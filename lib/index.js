/**
 * @dsh-external/dsh-persistent-memory — DSH 持久记忆插件（toolkit + 自动召回）。
 *
 * 能力：
 * - 跨会话保存/检索用户偏好、项目事实、任务状态等键值记忆；
 * - 数据落盘到 $DSH_HOME/dsh-persistent-memory/memory.jsonl，重启不丢；
 * - 支持 scope（默认 global）与 tags，可按关键词/标签搜索；
 * - 自动浮现：agent/pre-step 时自动召回相关/最近记忆并注入上下文，
 *   无需用户每次提醒。
 *
 * 规范：资源注册必须挂 ctx.effect / ctx.on（热重载/卸载自动清理）。
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { KEY_PREFIX_LIST, KEY_PREFIX_WHITELIST } from './types.js';
import { sanitizeValue } from './sanitize.js';
import { ageLabel, contentSimilarity, fitBudget, lexicalHit, pickRecallItems, rrfRanking, semanticOverlap, truncate, } from './recall.js';
import { detectCredentials, hasWeakCredentialSignal, normalizeScope, upsertMemory, validateKeyPrefix } from './write-gate.js';
import { parseImportEntries } from './import.js';
import { createStore } from './store.js';
export const name = '@dsh-external/dsh-persistent-memory';
export const inject = ['tools', 'commands', 'settings'];
export const Config = z.object({
    dataDir: z.string().default(''),
    defaultScope: z.string().default('global'),
    maxResults: z.number().default(20),
    autoRecall: z.boolean().default(true),
    autoRecallLimit: z.number().default(2),
    autoRecallMaxChars: z.number().default(160),
    autoRecallBudgetChars: z.number().default(300),
    autoRecallMinScore: z.number().default(3),
    autoRecallRelativeFloor: z.number().default(0.5),
    autoRecallScope: z.string().default(''),
    autoRecallFallback: z.boolean().default(false),
    autoCapture: z.boolean().default(true),
    autoCaptureDetail: z.string().default('full'),
    autoRecallOnce: z.boolean().default(true),
    autoRecallCooldownMs: z.number().default(10 * 60 * 1000),
    synonymExpansion: z.boolean().default(true),
    dedupeOnSet: z.boolean().default(true),
    autoRecallRerank: z.boolean().default(true),
    autoRecallRerankMax: z.number().default(5),
    rrfRecall: z.boolean().default(true),
    rrfFirstTurnOnly: z.boolean().default(true),
    approveOnSet: z.boolean().default(false),
    valueMaxChars: z.number().default(240),
    taskTtlDays: z.number().default(30),
    autoExtract: z.boolean().default(true),
    autoExtractCooldownMs: z.number().default(120 * 1000),
});
export function apply(ctx, config) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const dataDir = config.dataDir || join(dshHome, 'dsh-persistent-memory');
    const dataFile = join(dataDir, 'memory.jsonl');
    const defaultScope = config.defaultScope || 'global';
    const maxResults = Math.max(1, config.maxResults || 20);
    const autoRecall = config.autoRecall !== false;
    const autoRecallLimit = Math.max(1, Math.min(20, config.autoRecallLimit || 2));
    const autoRecallMaxChars = Math.max(40, config.autoRecallMaxChars || 160);
    // 注入预算（v0.1.16，对标 mem0 的 top_k + Letta 的 memory block 字符上限）：
    // 条数上限管不住"每条都很长"的情况，字符预算才能给出可预测的上下文开销。
    // v0.1.20：600 → 300。单条成本 ≈ 截断后正文 + key + 固定包装 ≈ 200 字，
    // 300 的预算意味着实际多为 1 条、偶尔 2 条——自动注入只负责"提个醒"，取全用 memory_search。
    const autoRecallBudgetChars = Math.max(120, config.autoRecallBudgetChars || 300);
    // 召回阈值（v0.1.17）：绝对下限挡"整体都不相关"，相对比例挡"矮子里拔将军"。
    // 参考 mem0 的 threshold（归一化相似度绝对门槛）与 Zep 的 limit + reranker 两级做法。
    const autoRecallMinScore = Math.max(0, config.autoRecallMinScore ?? 3);
    const autoRecallRelativeFloor = Math.max(0, Math.min(1, config.autoRecallRelativeFloor ?? 0.5));
    const autoRecallScope = (config.autoRecallScope || '').trim();
    const autoRecallFallback = config.autoRecallFallback === true;
    const autoCapture = config.autoCapture !== false;
    // 守则详略（v0.1.16）：默认 brief——完整守则约 1300 字且每会话常驻上下文，
    // 细则在 memory_set 校验报错时按需返回，不必每会话全量注入。
    // 默认完整版：只有显式配置 'brief' 才用精简版（不依赖 schema 默认值填充，裸 config 也一致）
    const autoCaptureDetail = config.autoCaptureDetail === 'brief' ? 'brief' : 'full';
    const autoExtract = config.autoExtract !== false;
    const autoExtractCooldownMs = Math.max(30_000, config.autoExtractCooldownMs ?? 120 * 1000);
    const autoRecallOnce = config.autoRecallOnce !== false;
    const autoRecallCooldownMs = Math.max(0, config.autoRecallCooldownMs ?? 10 * 60 * 1000);
    const rrfRecall = config.rrfRecall !== false;
    // 补位收口（v0.1.18）：非首轮词法被阈值过滤说明整体不相关，此时再语义补位等于
    // 用另一条通道放回排名靠前的记忆（0.025 ≈ 综合前 20）。首轮保留兜底。
    const rrfFirstTurnOnly = config.rrfFirstTurnOnly !== false;
    const approveOnSet = config.approveOnSet === true;
    const synonymExpansion = config.synonymExpansion !== false;
    const dedupeOnSet = config.dedupeOnSet !== false;
    const autoRecallRerank = config.autoRecallRerank !== false;
    // task.* 保鲜期（v0.1.16）：任务状态变化快，超期记忆在评分里降权而不是删除（保留可查）。
    const taskTtlDays = Math.max(1, config.taskTtlDays || 30);
    const autoRecallRerankMax = Math.max(1, Math.min(8, config.autoRecallRerankMax || 5));
    // value 存储上限（写侧，v0.1.15）：与注入展示上限 autoRecallMaxChars（160）分离——
    // 展示截断只影响本次注入 token 预算；存储摘要上限决定"自足摘要能写多全"。
    const valueMaxChars = Math.max(120, config.valueMaxChars || 240);
    // ── 运行时开关（B1 修复，v0.1.23）───────────────────────────────────
    // 设置面板 applyPanel 只写 runtime；全部消费点只读 runtime。
    // 修复前 6 个开关写入 config 对象而消费点读 apply 开头的闭包常量，
    // 面板保存后插件行为完全不变（UI 却宣称"已保存并生效"）。
    const runtime = {
        autoRecall,
        autoCapture,
        autoRecallRerank,
        rrfRecall,
        rrfFirstTurnOnly,
        approveOnSet,
    };
    // 串行化读写，避免并发写坏 JSONL
    let queue = Promise.resolve();
    function withLock(fn) {
        const run = queue.then(fn, fn);
        queue = run.then(() => undefined, () => undefined);
        return run;
    }
    // 文件级缓存与读写实现已提取到 store.ts（fs 可注入，便于故障注入测试）
    const storeFs = {
        stat: (p) => fs.stat(p),
        readFile: (p) => fs.readFile(p, 'utf8'),
        mkdir: (p, o) => fs.mkdir(p, o),
        open: (p, f) => fs.open(p, f).then((fh) => fh),
        rename: (a, b) => fs.rename(a, b),
        copyFile: (a, b) => fs.copyFile(a, b),
    };
    const store = createStore({ fs: storeFs, dataDir, dataFile, defaultScope });
    const readItems = () => store.readItems();
    const writeItems = (items) => store.writeItems(items);
    // 检索公共实现：memory_search 工具与 /memory recall 命令共用
    async function searchItems(options) {
        const query = String(options.query || '').trim().toLowerCase();
        const scopeFilter = options.scope ? normalizeScope(options.scope, defaultScope) : undefined;
        const tagsFilter = normalizeTags(options.tags);
        const limit = Math.max(1, Math.min(100, Number(options.limit) || maxResults));
        return withLock(async () => {
            const items = await readItems();
            const matched = items.filter((item) => {
                if (scopeFilter && item.scope !== scopeFilter)
                    return false;
                if (tagsFilter.length && !tagsFilter.every((tag) => item.tags.includes(tag)))
                    return false;
                if (query) {
                    const haystack = [item.key, item.value, item.scope, ...item.tags].join(' ').toLowerCase();
                    if (!haystack.includes(query))
                        return false;
                }
                return true;
            });
            return { count: matched.length, items: matched.slice(0, limit) };
        });
    }
    function normalizeTags(tags) {
        if (!Array.isArray(tags))
            return [];
        return tags.map((t) => String(t).trim()).filter(Boolean);
    }
    function makeId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    // ── 改进支撑设施 ──────────────────────────────────────────────────────
    // ① 会话级注入记录：sessionId → 上次注入时间戳（每会话一次 + 冷却期）。
    // v0.1.19 持久化到 dataDir/session-injections.json：内存 Map 重启即清空，
    // 而注入是追加到会话历史的、无法撤回——实测同一会话重启 5 次就攒了 5 份守则
    // 与 5 份召回（8722 字，本应 888 字）。落盘后"每会话一次"跨重启成立。
    const injectionStateFile = join(dataDir, 'session-injections.json');
    const INJECTION_STATE_TTL_MS = 30 * 86_400_000;
    const sessionInjections = new Map();
    function loadInjectionState() {
        try {
            if (!existsSync(injectionStateFile))
                return;
            const raw = JSON.parse(readFileSync(injectionStateFile, 'utf8'));
            const now = Date.now();
            for (const [key, ts] of Object.entries(raw?.entries ?? {})) {
                if (typeof ts === 'number' && now - ts < INJECTION_STATE_TTL_MS)
                    sessionInjections.set(key, ts);
            }
        }
        catch {
            // 状态文件损坏/不可读：按空状态继续，最坏退回"每次重启重新注入"的旧行为
        }
    }
    let persistTimer = null;
    function persistInjectionState() {
        if (persistTimer)
            return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            void (async () => {
                try {
                    await fs.mkdir(dataDir, { recursive: true });
                    const entries = {};
                    for (const [key, ts] of sessionInjections)
                        entries[key] = ts;
                    await fs.writeFile(injectionStateFile, JSON.stringify({ version: 1, entries }), 'utf8');
                }
                catch {
                    // 写失败只降低去重效果，不阻塞注入流程
                }
            })();
        }, 500);
        persistTimer.unref?.();
    }
    loadInjectionState();
    // ② 工作区感知：环境变量优先（harness 下 process.cwd() 是 host 进程目录，非当前工作区），cwd 仅兜底
    let workspaceScopesCache = null;
    function currentWorkspaceScopes() {
        if (workspaceScopesCache)
            return workspaceScopesCache;
        const scopes = new Set();
        for (const envName of ['DSH_WORKSPACE', 'DSH_WORKSPACE_NAME', 'DSH_SESSION_WORKSPACE']) {
            const v = process.env[envName];
            if (v && v.trim())
                scopes.add(v.trim().toLowerCase());
        }
        try {
            const base = basename(process.cwd()).toLowerCase();
            if (base)
                scopes.add(base);
        }
        catch { /* ignore */ }
        workspaceScopesCache = [...scopes];
        return workspaceScopesCache;
    }
    // 召回评分环境：把 apply 闭包内的运行时开关注入提取后的纯函数（recall.ts）
    const scoreEnv = () => ({ synonymExpansion, taskTtlDays, workspaceScopes: currentWorkspaceScopes() });
    const recallEnv = () => ({
        ...scoreEnv(),
        autoRecallScope,
        minScore: autoRecallMinScore,
        relativeFloor: autoRecallRelativeFloor,
        rrfRecall: runtime.rrfRecall,
        rrfFirstTurnOnly: runtime.rrfFirstTurnOnly,
    });
    // ── 自动召回：把相关/最近记忆注入到每轮请求前 ─────────────────────────
    // v0.1.4：只读文本、跳过插件注入消息、向后取最多 2 条用户文本消息（上下文延续如
    // "又报错了"能带上文关键词）；同时标记本轮是否含图片块 —— 图片内容无法参与
    // 字面召回，发图提问时召回意义为零（画像兜底也跳过），避免"看图问问题"惨遭画像刷屏。
    function extractQuery(messages) {
        if (!Array.isArray(messages) || messages.length === 0)
            return { query: '', hasImage: false };
        let hasImage = false;
        const texts = [];
        for (let i = messages.length - 1; i >= 0 && texts.length < 2; i--) {
            const msg = messages[i];
            if (!msg || !Array.isArray(msg.content))
                continue;
            // 跳过插件注入消息（自动守则/召回/教训），避免其文本污染查询信号
            if (msg.source?.kind === 'plugin')
                continue;
            const blocks = msg.content;
            if (blocks.some((b) => b?.type === 'image' || b?.type === 'image_url'))
                hasImage = true;
            const t = blocks
                .filter((b) => b?.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join(' ')
                .trim();
            if (t)
                texts.push(t);
        }
        return { query: texts.join(' ').slice(0, 200), hasImage };
    }
    // 规则/教训通道：识别"又犯同样错"的悔恨信号与"路径/终端/命令"类场景信号。
    // 这两类信号触发时，强制召回 rule.*/教训/坑/修复类记忆（不受 autoRecallOnce 限制）。
    function regretSignal(query) {
        const q = query.toLowerCase();
        const regret = ['又', '还是', '再次', '仍然', '依然', '老是', '一直', '经常', 'again'];
        const error = ['错', '失败', '报错', '不对', '不行', '崩', '挂', '回退', '问题', '错误', '没', '失败啦'];
        return regret.some((r) => q.includes(r)) && error.some((e) => q.includes(e));
    }
    function ruleScene(query) {
        const q = query.toLowerCase();
        const scene = ['路径', 'path', '盘', '目录', 'folder', '文件位置', '放哪', '移动', '拷贝', '复制',
            'powershell', 'pwsh', '终端', '命令', '脚本', '字符', '编码', '引号', 'c盘', 'd盘', 'e盘', 'windows'];
        return scene.some((s) => q.includes(s));
    }
    // 教训/规则记忆的判定：key 前缀 rule. 或 value/tags 含强信号
    function isLessonLike(item) {
        const key = item.key.toLowerCase();
        const blob = `${item.key} ${item.value} ${item.tags.join(' ')}`.toLowerCase();
        if (key.startsWith('rule.') || key.startsWith('convention.') || key.startsWith('lesson.'))
            return true;
        return ['教训', '坑', '切记', '勿', '不要', '禁止', '约定', 'lesson', 'pitfall', 'fixed', 'repair', 'fix']
            .some((w) => blob.includes(w));
    }
    // 自动注入通道排除 auth.*（v0.1.20）：凭据类记忆只在模型显式 memory_search /
    // memory_get 时返回，不随首轮自动注入进入每个新会话——实测 [global/auth.platforms]
    // 会把两个账号的明文密码带进每次新会话的上下文，既费 token 也放大泄露面。
    function excludeAuth(items) {
        return items.filter((item) => !item.key.toLowerCase().startsWith('auth.'));
    }
    // 教训通道的轻量词法命中：与 scoreItem 同源的噪声/弱词规则，但去掉工作区加分与
    // 同义词扩展——只回答「这条记忆里是否真的出现了 query 的词」。
    function pickLessonItems(items, query, isRegret, isRule, limit) {
        const candidates = items.filter((item) => isLessonLike(item));
        if (candidates.length === 0)
            return [];
        const scored = candidates.map((item) => {
            const blob = `${item.key} ${item.value} ${item.tags.join(' ')}`.toLowerCase();
            let bonus = 0;
            if (isRule && (blob.includes('路径') || blob.includes('path') || blob.includes('盘')
                || blob.includes('powershell') || blob.includes('pwsh') || blob.includes('终端') || blob.includes('命令')))
                bonus += 10;
            if (isRegret)
                bonus += 6;
            // 相关性门槛：悔恨/场景信号只决定「要不要看教训」，不决定「看哪一条」。
            // 只有真的与当前 query 沾边（共享中文二元组/英文词元，或词法命中）才准入——
            // 否则库里 lesson 类条目少时会把无关规则一并塞进来，还顶掉本该出现的索引兜底。
            const overlap = semanticOverlap(query, `${item.key} ${item.value}`);
            const lexHit = lexicalHit(item, query);
            return { item, bonus, relevance: overlap * 2 + (lexHit ? 3 : 0), hit: overlap >= 1 || lexHit };
        });
        const relevant = scored.filter((entry) => entry.hit);
        relevant.sort((a, b) => (b.bonus + b.relevance - (a.bonus + a.relevance)) || b.item.updatedAt.localeCompare(a.item.updatedAt));
        return relevant.slice(0, limit).map((entry) => entry.item);
    }
    // 重排候选池（v0.1.9）：RRF 双排名取 top max——词法零命中但语义相关的条目也能进 LLM 重排视野
    function pickRecallCandidates(items, query, max) {
        if (!query)
            return [];
        const ranked = rrfRanking(items, query, scoreEnv()).filter((e) => e.rrf >= 0.025);
        return ranked.slice(0, max).map((e) => e.item);
    }
    // ── 记忆新鲜度（借鉴 Claude Code memoryAge.ts）────────────────────────
    // 天龄显示：今天/昨天/N 天前。模型对原始 ISO 时间戳的"过期感"很差，
    // "47 天前"比 ISO 串更能触发过期推理。
    // 漂移警告：>1 天的记忆附"时点观察"提示——记忆是写入时的真相，不是实时状态；
    // 点名了文件/路径/命令的记忆在引用前先验证（否则"过时断言当事实"正是重复犯错之源）。
    function driftNote(iso) {
        const d = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
        if (!Number.isFinite(d) || d <= 1)
            return '';
        return `\n> ⚠️ 记忆为 ${d} 天前的时点观察，可能已过时：记忆中点名的文件/路径/命令，引用前请先验证现状；与当前信息冲突时以现状为准，并更新该记忆。`;
    }
    // 合并漂移警告（v0.1.16）：每条记忆各附一段几乎相同的警告是纯冗余，
    // 改为整块共用一段并取最老天数——信息量不变，字数降一个数量级。
    function mergedDriftNote(items) {
        const ages = items
            .map((item) => Math.max(0, Math.floor((Date.now() - Date.parse(item.updatedAt)) / 86_400_000)))
            .filter((d) => Number.isFinite(d) && d > 1);
        if (ages.length === 0)
            return '';
        const oldest = Math.max(...ages);
        return `\n> ⚠️ 以上 ${ages.length} 条为 ${oldest} 天前的时点观察，可能已过时：点名的文件/路径/命令引用前先验证现状；与现状冲突时以现状为准，并更新该记忆。`;
    }
    function formatRecall(items, all) {
        const fitted = fitBudget(items, autoRecallBudgetChars, autoRecallMaxChars, sanitizeValue);
        const lines = fitted.map((item) => {
            // ⑤ 投毒防护：注入前清洗（控制字符/危险 URI scheme/提示注入模式）
            const cleaned = sanitizeValue(item.value);
            const value = truncate(cleaned, autoRecallMaxChars);
            let line = `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}${item.source ? ` · 自${item.source}` : ''}] ${value}`;
            if (item.links && item.links.length > 0) {
                const linked = all
                    .filter((o) => o.scope === item.scope && o.id !== item.id && item.links.includes(o.key))
                    .map((o) => o.key)
                    .slice(0, 3);
                if (linked.length > 0)
                    line += `\n    🔗 关联: ${linked.join('、')}`;
            }
            return line;
        });
        const note = mergedDriftNote(fitted);
        return `【记忆自动召回】\n${lines.join('\n')}${note}`;
    }
    function formatLesson(items) {
        const fitted = fitBudget(items, autoRecallBudgetChars, autoRecallMaxChars, sanitizeValue);
        const lines = fitted.map((item) => {
            const cleaned = sanitizeValue(item.value);
            return `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}${item.source ? ` · 自${item.source}` : ''}] ${truncate(cleaned, autoRecallMaxChars)}`;
        });
        const note = mergedDriftNote(fitted);
        return `【历史教训/规则提醒】以下记忆与当前场景相关，请优先遵守以避免重复犯错：\n${lines.join('\n')}${note}`;
    }
    // ── LLM 语义重排（对标 Claude Code memdir/findRelevantMemories）─────────
    // 词法预筛 → 候选 manifest → LLM 选 3~5 条 → 失败/超时降级词法 top。
    // ctx.get('llm') 为可选服务；拿不到时静默降级（不影响原有词法链路）。
    const RERANK_SYSTEM_PROMPT = [
        '你是记忆选择器。给定用户查询与记忆清单，选出对该查询【明确有用】的记忆 key（最多 ',
        '{{max}}',
        ' 个）。规则：',
        '1. 不确定是否有用就不选；宁少勿多，可以返回空列表。',
        '2. 用户正在使用的工具的"参考文档/API 说明"不要选（对话里已有使用示例）；但警告、坑、已知问题、历史教训要选——正好在踩的时候最有用。',
        '3. 陈旧（N 天前）的状态记忆：除非查询明确指向"当时的结论/原因"，否则优先不选；规则类（rule.*）与画像类（user.*）不受此限。',
        '4. 输出只允许 JSON：{"selected_keys": ["scope/key", ...]}，key 必须原样来自清单。',
    ].join('');
    function buildRerankManifest(items) {
        return items.map((item) => {
            const cleaned = sanitizeValue(item.value);
            return `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}] ${truncate(cleaned, 80)}`;
        }).join('\n');
    }
    async function rerankMemories(ctx, query, candidates, limit, signal) {
        const llm = ctx.get('llm');
        if (!llm)
            return null;
        const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
        const provider = sel?.provider;
        const model = sel?.model;
        if (!provider || !model)
            return null;
        const manifest = buildRerankManifest(candidates);
        // 5s 整体超时 + 外部中止信号，防 pre-step 被慢调用拖住
        const timeout = AbortSignal.timeout(5000);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const system = RERANK_SYSTEM_PROMPT.replace('{{max}}', String(limit));
            const content = `Query: ${query}\n\nAvailable memories:\n${manifest}`;
            const textChunks = [];
            const stream = llm.stream({
                provider,
                model,
                system,
                maxTokens: 300,
                temperature: 0,
                signal: combined,
                messages: [{
                        id: `mid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                        role: 'user',
                        content: [{ type: 'text', text: content }],
                        source: { kind: 'plugin', plugin: name },
                    }],
            });
            for await (const chunk of stream) {
                if (chunk?.type === 'text-delta')
                    textChunks.push(chunk.text);
            }
            const text = textChunks.join('').trim();
            const m = text.match(/\{[\s\S]*\}/);
            if (!m)
                return null;
            const parsed = JSON.parse(m[0]);
            const byKey = new Map(candidates.map((c) => [`${c.scope}/${c.key}`, c]));
            const selected = (parsed.selected_keys ?? [])
                .map((k) => byKey.get(k))
                .filter((x) => !!x);
            // 解析成功就如实返回（空数组 = LLM 明确否决，调用处据此回落索引兜底）；
            // 只有异常/超时才是 null（降级回词法结果）。
            return selected.slice(0, limit);
        }
        catch (err) {
            ctx.logger.warn('dsh-persistent-memory: rerank failed: %o', err);
            return null;
        }
    }
    // ── 记忆索引（对标 Claude Code MEMORY.md，动态生成不落盘）──────────────
    // 触发：首轮 && 无信号 && !hasImage && 常规召回 0 命中 && 教训通道未注入。
    // 替代画像兜底（v0.1.7 起 user.* 在 global 组有固定 2 席配额，画像真实呈现）。
    function buildIndexBlock(rawItems, excludeKeys) {
        // v0.1.20：只列 key 不列摘要（实测 424 → 约 160 字），并排除 auth.*——
        // 目录里出现 [auth.platforms] 这类 key 本身就是不该随新会话扩散的线索。
        // 教训通道已给过内容的条目从目录里去掉，避免同一会话里重复出现。
        const items = excludeAuth(rawItems).filter((item) => !excludeKeys?.has(`${item.scope}/${item.key}`));
        const scopes = new Map();
        for (const item of items) {
            const group = item.scope === 'global' ? 'global'
                : (currentWorkspaceScopes().some((ws) => item.scope.includes(ws) || ws.includes(item.scope)) ? item.scope : null);
            if (!group)
                continue;
            if (!scopes.has(group))
                scopes.set(group, []);
            scopes.get(group).push(item);
        }
        const byUpdated = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
        const lines = [];
        const order = ['global', ...currentWorkspaceScopes()];
        for (const scope of order) {
            let picks;
            if (scope === 'global') {
                // v0.1.7 画像配额：只取"最新 4 条"时 user.* 会被 task/env 等高频条目永久挤出（v0.1.6 缺陷）。
                // global 组改为 user.* 固定 2 席 + 其余分类最新 2 席。
                const userPicks = (scopes.get(scope) || [])
                    .filter((item) => item.key.startsWith('user.')).sort(byUpdated).slice(0, 2);
                const otherPicks = (scopes.get(scope) || [])
                    .filter((item) => !item.key.startsWith('user.')).sort(byUpdated).slice(0, 2);
                picks = [...userPicks, ...otherPicks];
            }
            else {
                picks = (scopes.get(scope) || []).sort(byUpdated).slice(0, 3);
            }
            if (picks.length)
                lines.push(`- ${scope}: ${picks.map((item) => item.key).join('、')}`);
        }
        if (lines.length === 0)
            return '';
        lines.push('取内容：memory_search <关键词>');
        return `【记忆索引】以下记忆可查，本会话未自动召回：\n${lines.join('\n')}`;
    }
    // 注入去重（v0.1.19 起为 form 级）：会话历史里已有同 form 的注入即视为已注入，
    // 不再比对正文——否则守则/召回文本一改（如精简守则上线）就会在同一会话再追加一份。
    function isOwnInjected(message, form) {
        const msg = message;
        return Boolean(msg
            && msg.source?.kind === 'plugin'
            && msg.source.plugin === name
            && msg.source.form === form);
    }
    // ── 自动记忆守则 + 自动召回 ────────────────────────────────────────────
    // 守则不再走 system-prompt section：complete:true 的 preset（如 stock minimal）
    // 装配后只保留 persona 一个 section，其余全部静默丢弃；统一用 pre-step 注入
    // plugin user message，任何 preset 下都可达、可重放、压缩可见。
    const AUTO_CAPTURE_FORM = 'memory-capture-guide';
    const AUTO_CAPTURE_TEXT = [
        '# 记忆使用守则（dsh-persistent-memory）',
        '',
        '你有跨会话的长期记忆库：把用户偏好、踩过的坑与定过的结论攒下来，让未来的会话少走弯路——代价是必须守纪律：乱记比不记更糟，错误记忆会跨会话传播，而且看起来和正确记忆一样可信。',
        '自动召回会把相关记忆与记忆索引注入上下文，你不需要为此做任何事；不要因为收到注入就复述、确认或立刻写入——那只是注意力信号，不是待办。',
        '',
        '## 什么时候查',
        '- 用户提到你不可能记得的事（「上次」「之前那个」「我说过的」）→ `memory_search`（关键词 + tags/scope），命中后 `memory_get` 读细节。',
        '- 用户抱怨同一件事又做错（「又错了」「还是不行」）→ 检索时带 `lesson`/`rule` 关键词，先看上次是怎么栽的。',
        '- 记忆库里没有、但以前会话说过 → `memory_recall`（全文检索历史会话）。',
        '- 要重走一条曾经失败过的路径 → 检索时带 `lesson` 关键词。',
        '没有信号就不查；查不到不是失败，硬用不相关的记忆才是。',
        '',
        '## 什么时候写',
        '三个信号出现就写：① 用户明确说「记住」；② 用户纠正你，或确认了某个非常规做法——「对，就这样」与「别这样」同样重要，只记纠正会让你越来越保守；③ 用户分享了应该跨会话留存的背景（角色、目标、项目决策、外部资源位置）。',
        '其余情况默认不写；只有三条同时满足才写：跨会话仍然成立、代码与文档里看不出来、未来会再次用到。',
        '每轮结束会有后台提取器回顾本轮对话、自动沉淀高置信条目：它写过的你不用重复写，你漏掉的它会补。',
        '被要求记流水账（PR 列表、活动摘要、整段会议记录）时：先追问「哪一点最意外或最不显然」，只记那一条，不照抄全文。',
        '（软自律，非闸门）一轮对话最多写 3 条，其余留到真的需要时再说。',
        '',
        '## 怎么写',
        '1. **先查再写**：`memory_set` 之前先 `memory_search` 同 scope（必要时加 global）的相近 key；已有那条就更新，不新建重复条目。',
        '2. **冲突就覆盖，不并存**：更新旧条目，并在 value 里显式写「覆盖：<旧说法>」；只有两个事实都仍然成立才保留两条。',
        '3. key 一旦定下就稳定复用（如 `rule.powershell-encoding`），不要每次换新名；`links` 关联同 scope 的其它 key。',
        '4. value 是自足摘要，也是**检索器的索引**：召回靠词法/二元组匹配，具体名词（文件名、命令、库名、报错词、盘符）保留原样，代词（「那个/上次/问题」）召不回来；先写规则/事实一行，再 **Why:**（为什么这么定）与 **How to apply:**（什么情况下生效）；细节、步骤、长文放 `full`。',
        '5. 时间一律写**绝对日期**（2026-09-03，不写「昨天/下周」）；`task.*` 尤其要写清推动它的原因。',
        '6. 会随环境变化的判断（`rule.*`/`env.*`）带上最后验证日期，方便日后判断它是否过期。',
        '示例：「PowerShell 写中文文件加 -Encoding UTF8（5.1 默认带 BOM）。Why: 不指定会乱码。How to apply: 写中文输出的脚本。」',
        '',
        '## 分类（key 前缀 → 记什么）',
        '- `user.*` 用户画像：称呼/角色/目标/知识背景/偏好/禁忌。一次只记一件事；不写负面评判、不写与协作无关的隐私。',
        '- `rule.*` 工作方式约定：用户给过的指导——包括要避免的**和**要继续的。结构：规则一行 → **Why:** → **How to apply:** 何时生效。',
        '- `task.*` 任务/项目进展与决策：变化快，写绝对日期与推动原因；完成后更新状态，过期条目走 `memory_dream`。',
        '- `project.*` 项目知识**指针**：只记「结论在哪个文件/哪一节 + 为什么这么定」；正文留在项目知识库（cairn / AGENTS.md / 设计文档），不要复制进来。',
        '- `env.*` 环境事实：装了什么、配在哪、去哪查——记位置指针，不抄配置全文；随后可能变化的事实带验证日期。',
        '- `tool.*` / `plugin.*` 工具与插件（含本插件）的坑、已知行为、版本限制。',
        '- `ref.*` 外部资源指针：去哪查（面板入口、文档位置、连接方式）。',
        '- `auth.*` 凭据：默认不记，只有用户明确要求记住时才写。',
        '- `lesson.*` 负面知识账本：被证伪的路径与失败教训——记**结果 + 前置条件 + 证据 + 什么条件下解除**；证据变了就更新解除条件，别让一条过期的禁令一直挡路。',
        'scope：跨项目通用的事实写 `global`；项目专属的写项目名（如 `bd-cluster`），key 前缀仍用上面的分类，不要把项目名塞进 key。',
        '',
        '## 不要记（优先级从高到低）',
        '1. 能从当前代码、文件、git 历史推断出来的内容（架构、路径、目录结构、谁改了什么）。',
        '2. 项目知识库（cairn / AGENTS.md / 技能文档）**已经写下的内容**——那里是唯一真相，记忆里放指针就够了；冲突时以知识库为准。',
        '3. 修复的完整步骤与配方（留在代码、提交信息与文档里；记忆只记「坑在哪 + 怎么绕」）。',
        '4. 只对本次会话有意义的临时状态与进度（用 todo / 计划跟踪）。',
        '5. 口令、令牌、密钥原文（仅 `auth.*`，且用户明确要求时）。',
        '这五条即使在你被明确要求记录时也成立：被要求照抄流水账时，追问出那一条非显而易见的发现，比整段复制更有价值。',
        '',
        '## 记忆会过期',
        '记忆是**某个时点的观察**，不是当前事实。当前状态优先看代码与 `git log`，其次才是记忆；引用其中的文件、路径、命令、版本号之前先验证现状，与现状冲突时以现状为准，并立刻修掉记忆——还有用就 `memory_set` 更新，没用了就 `memory_forget` 删除。',
        '召回行会标注天龄，超过 1 天的会附「时点观察」警告：那是提醒你先验证，不是让你照抄。',
        '`memory_dream` 会列出过期候选（task > 30 天 / 任意 > 90 天 / 已完成 > 14 天），定期跑一次并处理掉。',
        '',
        '## 硬闸门（违反会被拒绝；清单与代码同源）',
        `- key 前缀限 ${KEY_PREFIX_LIST}（或与 scope 同名）；项目专属记忆把项目名写进 scope，不要两边都写。`,
        '- 非 auth.* 前缀不得含明文口令/密钥（闸门拒绝）；tags ≤3 个（超出拒绝）。',
        `- value ≤${valueMaxChars} 字：超长不拒绝，会自动截断为摘要、完整原文归档进 full（memory_get includeFull 可取回）。`,
        '- approveOnSet 开启时：先向用户确认，再带 `confirmed: true` 重试写入。',
        '- 子代理会话写 global 会被拒绝（`scope=sub:<id>` 可用）；成果写进结果报告回传父会话。',
    ].join('\n');
    // 精简守则（v0.1.16 引入，v0.1.20 二次压缩 476 → 212 字）：只留三样东西——
    // 九类前缀的一词语义、该不该记的判据、以及细则去哪儿看的指路。
    // 写入格式（value 上限、tags 数、scope 归属、相似 key 预查）移出常驻文本：
    // memory_set 的写侧闸门会在校验失败时逐条报错，写入时的去重合并也会就地兜底。
    const AUTO_CAPTURE_BRIEF_TEXT = [
        '# 记忆守则（记忆插件）',
        '',
        '前缀：user.画像、rule.纠正、task.进展、project.定稿、env.环境、tool.坑、ref.资源、auth.凭据（仅明确要求）、lesson.教训。',
        '',
        '记：反复错的坑与正解、用户纠正、确认过的非常规做法、代码看不出的背景。不记：代码可推导、git 历史、修复步骤、临时进度、AGENTS.md/cairn 已覆盖。',
        '',
        '写入：格式与分类细则由 memory_set 校验按需返回。',
    ].join('\n');
    const SUBAGENT_CAPTURE_TEXT = [
        '# 子代理记忆守则（dsh-persistent-memory）',
        '',
        '你是子代理：记忆库【只读】——不要调用 memory_set（写入会被硬层拒绝）。',
        '- 需要上下文时用 `memory_search` / `memory_get` 查；查不到就按现有信息干活，不要臆造记忆内容。',
        '- 本次任务中学到的东西（坑、正确做法、约束）写进**结果报告**回传父会话，由父会话判断是否沉淀；不要自己写。',
    ].join('\n');
    // 子代理探测（v0.1.6）：运行时会话 header 存 origin/parentSession/delegationDepth（dsh-subagent
    // childSessionMeta 写入），运行期 AgentOptions 另有 subagentDepth；探测不到按主会话处理（保守分支）。
    function isSubagentAgent(agent) {
        const header = agent?.session?.header ?? agent?.session ?? {};
        const depth = Number(header.delegationDepth ?? agent?.options?.subagentDepth ?? 0);
        return header.origin === 'subagent'
            || depth > 0
            || Boolean(header.parentSession ?? header.parentId);
    }
    // ── 轮末自动提取（对标 Claude Code extractMemories：AI 用 AI 写记忆）────────
    // 订阅 session/event 火线缓冲每个会话当前 turn 的文本；agent/turn-stopping 时
    // 异步调 LLM 提取高置信候选，过最小闸门后落盘。互斥：主 agent 30s 内手动写过
    // 记忆 → 跳过；提取中 → 跳过；冷却内 → 跳过。两个监听器都绝不抛错。
    const turnBuffers = new Map();
    const lastExtractAt = new Map();
    const lastManualWriteAt = new Map();
    let extractionInFlight = false;
    /** 提取器落盘路径：与 memory_set 同源的最小闸门（前缀白名单/凭据词/value 截断/tags 裁剪）。
     *  @returns 是否真的写入（被闸门拦截返回 false，调用方继续尝试下一条候选）。 */
    async function writeExtractedMemory(raw) {
        const key = String(raw.key ?? '').trim();
        if (!key)
            return false;
        const prefix = key.split('.')[0].toLowerCase();
        if (!KEY_PREFIX_WHITELIST.includes(prefix))
            return false;
        if (prefix === 'auth')
            return false;
        let value = String(raw.value ?? '').trim();
        if (!value)
            return false;
        if (/password|passwd|密码|口令|密钥/i.test(value))
            return false;
        if (value.length > valueMaxChars)
            value = truncate(value, valueMaxChars);
        const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)).filter(Boolean).slice(0, 3) : [];
        const now = new Date().toISOString();
        await withLock(async () => {
            const items = await readItems();
            const idx = items.findIndex((item) => item.scope === defaultScope && item.key === key);
            if (idx >= 0) {
                const prev = items[idx];
                items[idx] = { ...prev, value, tags: tags.length ? tags : prev.tags, updatedAt: now, source: '轮末提取' };
            }
            else {
                items.push({ id: makeId(), key, value, scope: defaultScope, tags, createdAt: now, updatedAt: now, source: '轮末提取' });
            }
            await writeItems(items);
        });
        return true;
    }
    const EXTRACTION_SYSTEM_PROMPT = [
        '你是记忆提取器：回顾一段对话，只提取值得跨会话保留的条目，宁缺毋滥——拿不准就返回空列表。',
        '提取判据（三条同时满足才提）：① 跨会话仍然成立（用户偏好/纠正、踩坑与正解、项目决策与背景）；② 从当前代码、文件、git 历史看不出来；③ 未来对话真的会用到。',
        '不提取：临时进度、完整修复步骤、可推导内容、流水账（PR 列表/活动摘要）；口令密钥一律不提取。',
        `key 前缀限 ${KEY_PREFIX_LIST}；rule.*/lesson.* 的 value 用「规则一行 + Why: + How to apply:」结构；task.* 写绝对日期；value 保留具体名词（文件名/命令/报错词），不用代词。`,
        '最多 1 条。只输出 JSON：{"memories":[{"key":"前缀.名","value":"自足摘要","tags":["标签"]}]}',
    ].join('\n');
    async function extractAndWrite(sid, dialogue) {
        const llm = ctx.get('llm');
        if (!llm)
            return;
        const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
        const provider = sel?.provider;
        const model = sel?.model;
        if (!provider || !model)
            return;
        const timeout = AbortSignal.timeout(5000);
        const textChunks = [];
        try {
            const stream = llm.stream({
                provider,
                model,
                system: EXTRACTION_SYSTEM_PROMPT,
                maxTokens: 300,
                temperature: 0,
                signal: timeout,
                messages: [{
                        id: `mid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                        role: 'user',
                        content: [{ type: 'text', text: `对话摘录：\n${dialogue}` }],
                        source: { kind: 'plugin', plugin: name },
                    }],
            });
            for await (const chunk of stream) {
                if (chunk?.type === 'text-delta')
                    textChunks.push(chunk.text);
            }
        }
        catch (err) {
            ctx.logger.debug('[mem] extract llm failed: %o', err);
            return;
        }
        const text = textChunks.join('').trim();
        const m = text.match(/\{[\s\S]*\}/);
        if (!m)
            return;
        let parsed;
        try {
            parsed = JSON.parse(m[0]);
        }
        catch {
            return;
        }
        const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];
        let written = 0;
        for (const cand of memories.slice(0, 3)) {
            if (written >= 1)
                break;
            try {
                if (await writeExtractedMemory(cand))
                    written += 1;
            }
            catch (err) {
                ctx.logger.debug('[mem] extract write failed: %o', err);
            }
        }
    }
    if (autoExtract) {
        // ① 火线缓冲：每会话当前 turn 的文本（user/message 与 assistant/message）
        ctx.on('session/event', (session, event) => {
            try {
                if (!session?.id || !event)
                    return;
                const sid = String(session.id);
                if (event.type === 'turn/start') {
                    turnBuffers.set(sid, []);
                    return;
                }
                let text = '';
                if (event.type === 'user/message') {
                    const blocks = Array.isArray(event.data?.content) ? event.data.content : [];
                    text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
                }
                else if (event.type === 'assistant/message') {
                    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
                    text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
                }
                text = text.trim();
                if (!text)
                    return;
                const buf = turnBuffers.get(sid);
                if (!buf)
                    return;
                buf.push(text.slice(0, 2000));
                if (buf.length > 30)
                    buf.splice(0, buf.length - 30);
                if (turnBuffers.size > 64) {
                    const oldest = turnBuffers.keys().next().value;
                    if (oldest !== undefined)
                        turnBuffers.delete(oldest);
                }
            }
            catch { /* 观察者绝不抛 */ }
        }, { global: true });
        // ② 轮末触发：异步提取（serial 监听器立即返回，不拖慢 turn 收尾）
        ctx.on('agent/turn-stopping', (payload) => {
            try {
                const agent = payload?.agent;
                if (!agent || isSubagentAgent(agent))
                    return;
                if (extractionInFlight)
                    return;
                const sid = String(agent.session?.id ?? '');
                if (!sid)
                    return;
                const now = Date.now();
                const last = lastExtractAt.get(sid);
                if (last !== undefined && now - last < autoExtractCooldownMs)
                    return;
                const manual = lastManualWriteAt.get(sid);
                if (manual !== undefined && now - manual < 30_000)
                    return;
                const buf = turnBuffers.get(sid);
                if (!buf || buf.length === 0)
                    return;
                lastExtractAt.set(sid, now);
                extractionInFlight = true;
                void extractAndWrite(sid, buf.join('\n').slice(-4000))
                    .catch((err) => ctx.logger.debug('[mem] extract failed: %o', err))
                    .finally(() => { extractionInFlight = false; });
            }
            catch { /* 观察者绝不抛 */ }
        }, { global: true });
    }
    if (autoRecall || autoCapture) {
        ctx.on('agent/pre-step', async (payload, next) => {
            const decision = await next();
            try {
                if (decision?.kind === 'reject')
                    return decision;
                if (payload.signal?.aborted)
                    return decision;
                if (payload.step === 1 && (!Array.isArray(decision.messages) || decision.messages.length === 0))
                    return decision;
                const sid = String(payload.agent?.session?.id ?? payload.agent?.session?.sessionId ?? 'default');
                if (payload.step === 1) {
                    const header = payload.agent?.session?.header ?? payload.agent?.session;
                    ctx.logger.debug('[mem] agent probe %o', {
                        origin: header?.origin,
                        parent: header?.parentSession,
                        depth: header?.delegationDepth,
                        optDepth: payload.agent?.options?.subagentDepth,
                        role: payload.agent?.role ?? header?.role,
                        id: payload.agent?.session?.id,
                    });
                }
                const claimed = payload.messages;
                const entered = [...decision.messages];
                const lastClaimedIndex = entered.findLastIndex((item) => claimed.includes(item));
                let changed = false;
                // ① 记忆守则：每会话首轮注入一次（独立 form，与召回分开去重）
                if (runtime.autoCapture && payload.step === 1) {
                    const guideKey = `${sid}:capture-guide`;
                    const guideText = isSubagentAgent(payload.agent)
                        ? SUBAGENT_CAPTURE_TEXT
                        : (autoCaptureDetail === 'full' ? AUTO_CAPTURE_TEXT : AUTO_CAPTURE_BRIEF_TEXT);
                    const guideForm = isSubagentAgent(payload.agent) ? 'memory-capture-guide-subagent' : AUTO_CAPTURE_FORM;
                    if (!sessionInjections.has(guideKey) && !entered.some((message) => isOwnInjected(message, guideForm))) {
                        entered.splice(lastClaimedIndex + 1, 0, {
                            role: 'user',
                            id: makeId(),
                            content: [{ type: 'text', text: guideText }],
                            source: { kind: 'plugin', plugin: name, form: guideForm, summary: '记忆守则自动注入' },
                        });
                        // 有界淘汰：只移除最旧一次注入记录，不整体清空（避免所有会话冷却状态丢失）
                        if (sessionInjections.size > 200) {
                            const oldest = sessionInjections.keys().next().value;
                            if (oldest !== undefined)
                                sessionInjections.delete(oldest);
                        }
                        sessionInjections.set(guideKey, Date.now());
                        persistInjectionState();
                        changed = true;
                    }
                }
                // ② 教训/规则通道：悔恨信号（又错了/还是失败）或场景信号（路径/终端/命令）
                //    触发时强制召回 rule.*/教训/坑/修复类记忆，**不受 autoRecallOnce 限制**——
                //    这是"AI 经常犯同样错"的直接解药：错误发生时立刻把上次的坑摆到眼前。
                const lessonKeys = new Set();
                if (runtime.autoRecall) {
                    const items = excludeAuth(await withLock(async () => readItems()));
                    const { query } = extractQuery(payload.messages);
                    const isRule = ruleScene(query);
                    const isRegret = regretSignal(query);
                    const lessonKey = `${sid}:lesson`;
                    const lastLesson = sessionInjections.get(lessonKey);
                    const lessonAllowed = lastLesson === undefined || Date.now() - lastLesson >= 120_000;
                    if (items.length > 0 && (isRule || isRegret) && lessonAllowed) {
                        // 同一条教训本会话已出现过则跳过，避免复述刷屏。
                        // v0.1.20 修：渲染格式是 `[scope/key · N 天前]`，key 后面还跟着 " · 天数"，
                        // 旧 marker `[scope/key]` 永远匹配不到 → 去重形同虚设（实测同一条教训相隔 6 分钟
                        // 被原样注入两次，白烧 503 字）。marker 保留到 " ·" 之前即可稳定命中。
                        const lessons = pickLessonItems(items, query, isRegret, isRule, 2);
                        const fresh = lessons.filter((item) => {
                            const marker = `[${item.scope}/${item.key} ·`;
                            return !entered.some((m) => JSON.stringify(m).includes(marker));
                        });
                        if (fresh.length > 0) {
                            const text = formatLesson(fresh);
                            entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                                role: 'user',
                                id: makeId(),
                                content: [{ type: 'text', text }],
                                source: { kind: 'plugin', plugin: name, form: 'memory-lesson', summary: `教训/规则提醒 ${fresh.length} 条` },
                            });
                            if (sessionInjections.size > 200) {
                                const oldest = sessionInjections.keys().next().value;
                                if (oldest !== undefined)
                                    sessionInjections.delete(oldest);
                            }
                            sessionInjections.set(lessonKey, Date.now());
                            persistInjectionState();
                            for (const item of fresh)
                                lessonKeys.add(`${item.scope}/${item.key}`);
                            changed = true;
                        }
                    }
                }
                // ③ 自动召回：每会话一次 + 冷却期
                let recallEmpty = false;
                if (runtime.autoRecall) {
                    const lastInjection = sessionInjections.get(sid);
                    const recallAllowed = lastInjection === undefined
                        || (!autoRecallOnce && Date.now() - lastInjection >= autoRecallCooldownMs);
                    if (recallAllowed) {
                        const { query, hasImage } = extractQuery(payload.messages);
                        const all = excludeAuth(await withLock(async () => readItems()));
                        // 教训通道已给过内容的条目不再重复召回：同一条记忆在同一会话里出现两次纯属浪费。
                        const items = lessonKeys.size > 0
                            ? all.filter((item) => !lessonKeys.has(`${item.scope}/${item.key}`))
                            : all;
                        if (items.length > 0) {
                            const isFirstTurn = payload.step === 1;
                            const recalled = pickRecallItems(items, query, autoRecallLimit, autoRecallFallback, isFirstTurn, hasImage, recallEnv());
                            // LLM 语义重排（v0.1.6）：词法命中候选 ≥1 且启用时，用 LLM 挑"明确有用"的条
                            let recalledItems = recalled;
                            if (runtime.autoRecallRerank && query && !hasImage && recalled.length > 0) {
                                const pool = pickRecallCandidates(items, query, autoRecallRerankMax * 4);
                                if (pool.length >= 1) {
                                    const picked = await rerankMemories(ctx, query, pool, autoRecallRerankMax, payload.signal);
                                    if (picked)
                                        recalledItems = picked; // 空数组也是有效结果 → 回落索引兜底
                                }
                            }
                            // recallEmpty 必须在重排之后定：否则 LLM 清零后既不注内容、也不注索引 = 白屏（v0.1.21）
                            recallEmpty = recalledItems.length === 0;
                            if (recalledItems.length > 0) {
                                const text = formatRecall(recalledItems, items);
                                const alreadyEntered = entered.some((message) => isOwnInjected(message, 'memory-recall'));
                                // 已在本会话可见表面出现过则不重复注入
                                let onSurface = false;
                                const surface = payload.agent?.session?.surface;
                                if (!alreadyEntered && Array.isArray(surface?.nodes) && Array.isArray(payload.agent?.session?.events)) {
                                    onSurface = surface.nodes.some((seq) => {
                                        const event = payload.agent.session.events[seq];
                                        return event?.type === 'user/message' && isOwnInjected(event.data, 'memory-recall');
                                    });
                                }
                                if (!alreadyEntered && !onSurface) {
                                    entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                                        role: 'user',
                                        id: makeId(),
                                        content: [{ type: 'text', text }],
                                        source: { kind: 'plugin', plugin: name, form: 'memory-recall', summary: `记忆自动召回 ${recalledItems.length} 条` },
                                    });
                                    // 有界淘汰：只移除最旧一次注入记录，不整体清空（避免所有会话冷却状态丢失）
                                    if (sessionInjections.size > 200) {
                                        const oldest = sessionInjections.keys().next().value;
                                        if (oldest !== undefined)
                                            sessionInjections.delete(oldest);
                                    }
                                    sessionInjections.set(sid, Date.now());
                                    persistInjectionState();
                                    changed = true;
                                }
                            }
                        }
                    }
                }
                // ④ 索引兜底：首轮没有任何召回且不是看图提问 → 注入索引而不是画像（v0.1.6）
                // 教训通道不再阻止索引：它给的是「可能是坑的内容」，索引给的是「库里还有什么」；
                // 教训通道命中的条目会从目录里排除，两者不重复。
                if (runtime.autoRecall && payload.step === 1 && !isSubagentAgent(payload.agent)) {
                    const { hasImage } = extractQuery(payload.messages);
                    const idxKey = `${sid}:index`;
                    if (!hasImage && !sessionInjections.has(idxKey) && recallEmpty) {
                        const items = await withLock(async () => readItems());
                        const text = items.length > 0 ? buildIndexBlock(items, lessonKeys) : '';
                        if (text) {
                            entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                                role: 'user',
                                id: makeId(),
                                content: [{ type: 'text', text }],
                                source: { kind: 'plugin', plugin: name, form: 'memory-index', summary: '记忆索引（未召回）' },
                            });
                            if (sessionInjections.size > 200) {
                                const oldest = sessionInjections.keys().next().value;
                                if (oldest !== undefined)
                                    sessionInjections.delete(oldest);
                            }
                            sessionInjections.set(idxKey, Date.now());
                            // v0.1.20 互斥：索引块与召回共用会话主键——首轮给过目录就不再补一次
                            // 召回，避免同一会话叠两套重叠记忆（实测索引 424 + 召回 460 = 884 字）。
                            // 需要具体内容时模型手上有 memory_search。
                            sessionInjections.set(sid, Date.now());
                            persistInjectionState();
                            changed = true;
                        }
                    }
                }
                if (changed)
                    return { kind: 'enter', messages: entered };
                return decision;
            }
            catch (error) {
                ctx.logger.warn(`dsh-persistent-memory: auto injection failed: %o`, error);
                return decision;
            }
        });
    }
    // ── memory_set：写入/更新一条记忆 ──────────────────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_set',
        description: '持久化写入一条记忆（用户偏好/项目事实/任务状态）。同 scope+key 会覆盖更新；长文用 full（仅 memory_get includeFull 返回），value 写自足摘要。',
        parameters: {
            key: { type: 'string', required: true, description: '记忆键，如 user.name / project.tech' },
            value: { type: 'string', required: true, description: '记忆摘要：召回/搜索只展示它' },
            full: { type: 'string', description: '可选完整正文：memory_get 传 includeFull 才返回，避免 token 膨胀' },
            links: { type: 'array', items: { type: 'string' }, description: '可选关联记忆 key（同 scope）：召回时展示关联提示' },
            scope: { type: 'string', description: '作用域，默认 global；可按项目/工作区隔离' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
            confirmed: { type: 'boolean', description: '审批门：approveOnSet 开启时须为 true（先向用户确认过）' },
            source: { type: 'string', description: '可选来源引证（默认自动填 日期+会话）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    key: { type: 'string', required: true },
                    scope: { type: 'string', required: true },
                    created: { type: 'boolean' },
                    mergedKey: { type: 'string' },
                    updatedAt: { type: 'string' },
                    warnings: { type: 'array', items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: [
                        value.mergedKey
                            ? `记忆已合并更新：${value.scope}/${value.mergedKey}（与新 key "${value.key}" 高度相似，未新建条目）@ ${value.updatedAt}`
                            : `记忆已${value.created ? '写入' : '更新'}：${value.scope}/${value.key} @ ${value.updatedAt}`,
                        ...(value.warnings?.length ? [`⚠️ ${value.warnings.join('；')}`] : []),
                    ].join('\n'),
                }],
        },
        async execute(args, exec) {
            const key = String(args.key || '').trim();
            if (!key)
                throw new Error('memory_set: key 不能为空');
            // 审批门（v0.1.9，approveOnSet=true 时生效）：未经用户确认的写入拒绝，确认后带 confirmed: true 重试
            if (runtime.approveOnSet && args.confirmed !== true) {
                throw new Error('memory_set: 已开启写入审批（approveOnSet）。请先向用户确认是否记录这条记忆（直接询问或 ask_user_question），用户同意后带 confirmed: true 重试本次写入。');
            }
            const scope = normalizeScope(args.scope, defaultScope);
            // 硬层隔离（v0.1.6）：子代理禁止写 global 记忆（软层只读守则 + 此处拒绝双保险）
            if (isSubagentAgent(exec?.agent) && scope === 'global') {
                const subId = String(exec?.agent?.session?.id ?? 'unknown');
                throw new Error(`memory_set: 子代理会话禁止写入 global 记忆；确需落地请用 scope=sub:${subId}，成果建议以结果报告回传父会话由父会话沉淀`);
            }
            const tags = normalizeTags(args.tags);
            const links = normalizeTags(args.links);
            // ── value 摘要（v0.1.15 宽容写入）─────────────────────────────────
            // 超限不拒绝：句边界截断为摘要（末尾 … 表截断），完整原文归档进 full —— 写失败=丢信息，比超长更糟。
            let value = String(args.value || '').trim();
            let full = args.full !== undefined ? (String(args.full).trim() || undefined) : undefined;
            const warnings = [];
            if (value.length > valueMaxChars) {
                const raw = value;
                value = truncate(value, valueMaxChars);
                full = full ? `${full}\n\n${raw}` : raw;
                warnings.push(`value 摘要 ${raw.length} 字超过 ${valueMaxChars} 字上限，已截断为摘要（结尾 …），完整原文已归档到 full（memory_get includeFull 可取回）`);
            }
            // ── 写侧闸门（v0.1.7）：实测闸门；文案与守则同源（KEY_PREFIX_LIST 见 types.ts / write-gate.ts）──
            validateKeyPrefix(key, scope);
            const prefix = key.split('.')[0];
            if (tags.length > 3) {
                throw new Error(`memory_set: tags 最多 3 个（当前 ${tags.length} 个）。请收敛到最能代表内容的 1-3 个标签。`);
            }
            if (prefix !== 'auth') {
                const body = `${args.value}\n${args.full ?? ''}`;
                const credErr = detectCredentials(body);
                if (credErr)
                    throw new Error(credErr);
                if (hasWeakCredentialSignal(body)) {
                    warnings.push('内容含 token/secret 类关键词：请确认这是"去哪查"的指针而非明文凭据');
                }
            }
            if (prefix === 'task' && !/\d{4}-\d{2}-\d{2}/.test(String(args.value))) {
                warnings.push('task.* 建议在 value 中写明绝对日期（如 2026-09-03），相对时间会过期失真');
            }
            // 已有写侧 warning 收集（见上）；若截断发生了，warnings 已含提示
            const now = new Date().toISOString();
            // 来源引证（v0.1.9）：默认自动填 日期+会话前缀；显式 source 参数优先
            const sessionId = String(exec?.agent?.session?.id ?? '');
            const source = (args.source || '').trim() || `${now.slice(0, 10)}${sessionId ? ` s=${sessionId.slice(0, 8)}` : ''}`;
            return withLock(async () => {
                const items = await readItems();
                // ④ 去重合并 / 冲突检测 / push 新建：逻辑见 write-gate.ts 的 upsertMemory（与 M9 提取前逐字节等价）
                const result = upsertMemory(items, {
                    key,
                    value,
                    full,
                    links,
                    tags,
                    scope,
                    createdAt: now,
                    updatedAt: now,
                    source,
                    explicitSource: Boolean((args.source || '').trim()),
                }, { dedupe: dedupeOnSet, makeId });
                if (result.clashKey !== undefined && result.clashSim !== undefined) {
                    warnings.push(`与已有条目 ${scope}/${result.clashKey} 内容高度相似（${Math.round(result.clashSim * 100)}%）：请确认是否应更新该条（memory_set 同 key）而非新建`);
                }
                await writeItems(items);
                if (sessionId)
                    lastManualWriteAt.set(sessionId, Date.now());
                return { ok: true, key, scope, created: result.created, mergedKey: result.mergedKey, updatedAt: now, ...(warnings.length ? { warnings } : {}) };
            });
        },
    })), '@dsh-external/dsh-persistent-memory: memory_set');
    // ── memory_get：按 key 读取 ───────────────────────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_get',
        description: '按 key（可带 scope）读取一条持久记忆；includeFull 获取长文完整内容。',
        parameters: {
            key: { type: 'string', required: true, description: '记忆键' },
            scope: { type: 'string', description: '作用域，默认 global' },
            includeFull: { type: 'boolean', description: '是否返回 full 完整正文（默认 false，只返回摘要 value）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean', required: true },
                    key: { type: 'string', required: true },
                    scope: { type: 'string', required: true },
                    value: { type: 'string' },
                    full: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    updatedAt: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.found
                        ? `记忆 ${value.scope}/${value.key}：${value.value}${value.full ? '\n(已附完整正文)' : ''}${value.tags?.length ? `（标签：${value.tags.join(', ')}）` : ''}`
                        : `未找到记忆：${value.scope}/${value.key}`,
                }],
        },
        async execute(args) {
            const key = String(args.key || '').trim();
            if (!key)
                throw new Error('memory_get: key 不能为空');
            const scope = normalizeScope(args.scope, defaultScope);
            const includeFull = args.includeFull === true;
            return withLock(async () => {
                const items = await readItems();
                const item = items.find((entry) => entry.scope === scope && entry.key === key);
                if (!item)
                    return { found: false, key, scope };
                return {
                    found: true,
                    key,
                    scope,
                    value: item.value,
                    ...(includeFull && item.full ? { full: item.full } : {}),
                    tags: item.tags,
                    updatedAt: item.updatedAt,
                };
            });
        },
    })), '@dsh-external/dsh-persistent-memory: memory_get');
    // ── memory_search：按关键词/标签搜索 ─────────────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_search',
        description: '搜索持久记忆：按关键词（匹配 key/value/tags/scope）或标签过滤，返回最多 limit 条。',
        parameters: {
            query: { type: 'string', description: '关键词，留空则只按 tags/scope 过滤' },
            scope: { type: 'string', description: '限定作用域' },
            tags: { type: 'array', items: { type: 'string' }, description: '必须包含的标签' },
            limit: { type: 'number', description: '返回条数上限，默认 20' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    count: { type: 'number', required: true },
                    items: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                key: { type: 'string', required: true },
                                scope: { type: 'string', required: true },
                                value: { type: 'string', required: true },
                                tags: { type: 'array', items: { type: 'string' } },
                                updatedAt: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                if (!value.count)
                    return [{ type: 'text', text: '没有匹配的记忆。' }];
                const lines = value.items.map((item) => `- ${item.scope}/${item.key}: ${item.value}`);
                return [{ type: 'text', text: `找到 ${value.count} 条记忆：\n${lines.join('\n')}` }];
            },
        },
        async execute(args) {
            const result = await searchItems(args);
            return {
                count: result.count,
                items: result.items.map((item) => ({
                    key: item.key,
                    scope: item.scope,
                    value: item.value,
                    tags: item.tags,
                    updatedAt: item.updatedAt,
                })),
            };
        },
    })), '@dsh-external/dsh-persistent-memory: memory_search');
    // ── memory_forget：删除一条记忆 ───────────────────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_forget',
        description: '删除一条持久记忆（按 scope+key）。',
        parameters: {
            key: { type: 'string', required: true, description: '记忆键' },
            scope: { type: 'string', description: '作用域，默认 global' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    removed: { type: 'boolean', required: true },
                    key: { type: 'string', required: true },
                    scope: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.removed ? `已删除记忆：${value.scope}/${value.key}` : `未找到要删除的记忆：${value.scope}/${value.key}`,
                }],
        },
        async execute(args) {
            const key = String(args.key || '').trim();
            if (!key)
                throw new Error('memory_forget: key 不能为空');
            const scope = normalizeScope(args.scope, defaultScope);
            return withLock(async () => {
                const items = await readItems();
                const before = items.length;
                const next = items.filter((item) => !(item.scope === scope && item.key === key));
                if (next.length === before)
                    return { ok: true, removed: false, key, scope };
                await writeItems(next);
                return { ok: true, removed: true, key, scope };
            });
        },
    })), '@dsh-external/dsh-persistent-memory: memory_forget');
    // ── memory_stats：查看记忆库概况 ─────────────────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_stats',
        description: '查看持久记忆库概况：总条数、各作用域分布。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    total: { type: 'number', required: true },
                    scopes: { type: 'object', required: true, additionalProperties: true },
                },
            },
            render: (_args, value) => {
                const scopes = Object.entries(value.scopes || {}).map(([scope, count]) => `- ${scope}: ${count}`).join('\n');
                return [{ type: 'text', text: `记忆库共 ${value.total} 条：\n${scopes}` }];
            },
        },
        async execute() {
            return withLock(async () => {
                const items = await readItems();
                const scopes = {};
                for (const item of items)
                    scopes[item.scope] = (scopes[item.scope] || 0) + 1;
                return { total: items.length, scopes };
            });
        },
    })), '@dsh-external/dsh-persistent-memory: memory_stats');
    // ── 记忆代谢（v0.1.9）：列出过期候选，由模型决定更新/归档/删除 ────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_dream',
        description: '记忆代谢维护：列出过期/低活跃候选条目（task.* 超 30 天未更新、任意条目超 90 天、标记完成超 14 天），给出处理建议，由你执行后续 memory_set/memory_forget。',
        parameters: {
            scope: { type: 'string', description: '限定作用域，默认全部' },
            maxItems: { type: 'number', description: '最多列出的候选数，默认 20' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    candidates: { type: 'array', items: { type: 'string' }, required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.summary }],
        },
        async execute(args) {
            const scopeFilter = args.scope ? normalizeScope(args.scope, defaultScope) : '';
            const maxItems = Math.max(1, Math.min(50, Number(args.maxItems) || 20));
            return withLock(async () => {
                const items = await readItems();
                const nowMs = Date.now();
                const DAY = 86_400_000;
                const candidates = items
                    .filter((item) => (!scopeFilter || item.scope === scopeFilter) && !item.key.startsWith('auth.'))
                    .map((item) => {
                    const ageDays = Math.floor((nowMs - Date.parse(item.updatedAt)) / DAY);
                    let reason = '';
                    let suggest = '';
                    if (item.key.startsWith('task.') && ageDays > 30) {
                        reason = 'task 状态超过 30 天未更新';
                        suggest = '确认是否已完成/过时：更新 value 或 memory_forget';
                    }
                    else if (ageDays > 90) {
                        reason = '超过 90 天未更新';
                        suggest = '归档（详情挪 full）或 memory_forget';
                    }
                    else if (/done|completed|已完成|完成/.test(item.value) && ageDays > 14) {
                        reason = '标记完成已超 14 天';
                        suggest = 'memory_forget 或归档';
                    }
                    return { key: item.key, scope: item.scope, ageDays, reason, suggest };
                })
                    .filter((c) => c.reason)
                    .sort((a, b) => b.ageDays - a.ageDays)
                    .slice(0, maxItems);
                const summary = candidates.length === 0
                    ? '记忆代谢：没有发现过期候选，记忆库很健康。'
                    : `记忆代谢：发现 ${candidates.length} 条过期候选（按陈旧度排序）：\n` + candidates.map((c) => `- [${c.scope}/${c.key}] ${c.ageDays} 天前更新，${c.reason} → ${c.suggest}`).join('\n');
                return {
                    candidates: candidates.map((c) => `${c.scope}/${c.key}|${c.ageDays} 天|${c.reason}|${c.suggest}`),
                    summary,
                };
            });
        },
    })), '@dsh-external/dsh-persistent-memory: memory_dream');
    // ── 记忆导入（v0.1.9）：CLAUDE.md / MEMORY.md / memories.json 一键入库 ──
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_import',
        description: `把外部文件导入记忆库：CLAUDE.md / MEMORY.md / Claude Code memories.json 等。.json 按条目、.md/.txt 按段落切分，自动分配 ref/rule/lesson 前缀，value 截 ${valueMaxChars} 字余量入 full，与库中已有条目内容高度相似（≥70%）自动跳过。`,
        parameters: {
            path: { type: 'string', required: true, description: '要导入的文件绝对路径' },
            scope: { type: 'string', description: '目标 scope，默认 global' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    imported: { type: 'number', required: true },
                    skipped: { type: 'number', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.summary }],
        },
        async execute(args) {
            const filePath = String(args.path || '').trim();
            if (!filePath)
                throw new Error('memory_import: path 必填');
            const scope = normalizeScope(args.scope, defaultScope);
            let raw;
            try {
                raw = await fs.readFile(filePath, 'utf8');
            }
            catch {
                throw new Error(`memory_import: 无法读取 ${filePath}`);
            }
            const entries = parseImportEntries(raw, filePath, { valueMaxChars });
            if (entries.length === 0)
                throw new Error(`memory_import: ${filePath} 没有可导入的内容`);
            return withLock(async () => {
                const items = await readItems();
                const now = new Date().toISOString();
                let imported = 0;
                let skipped = 0;
                for (const e of entries) {
                    const dup = items.some((item) => item.scope === scope
                        && contentSimilarity(item, { key: e.key, value: e.value, scope, tags: [], id: '', createdAt: now, updatedAt: now }) >= 0.7);
                    if (dup) {
                        skipped++;
                        continue;
                    }
                    items.push({ id: makeId(), key: e.key, value: e.value, full: e.full, scope, tags: e.tags, createdAt: now, updatedAt: now, source: `import:${basename(filePath)}` });
                    imported++;
                }
                await writeItems(items);
                return { imported, skipped, summary: `导入完成：${imported} 条新增（${scope}），${skipped} 条与库中已有内容高度相似被跳过。` };
            });
        },
    })), '@dsh-external/dsh-persistent-memory: memory_import');
    // ── 会话回捞（v0.1.9）：sessionQuery 全文检索历史会话 ─────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_recall',
        description: '会话回捞：全文检索历史会话（DSH sessionQuery 服务），把最强匹配的会话片段带回上下文。记忆库里没有、但以前会话说过的事，用它找。',
        parameters: {
            query: { type: 'string', required: true, description: '要回捞的主题/关键词' },
            limit: { type: 'number', description: '最多返回的会话命中数，默认 3' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    hits: { type: 'array', items: { type: 'string' }, required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.summary }],
        },
        async execute(args) {
            const query = String(args.query || '').trim();
            if (!query)
                throw new Error('memory_recall: query 必填');
            const sq = ctx.get('sessionQuery');
            if (!sq || typeof sq.searchSessions !== 'function') {
                throw new Error('memory_recall: 当前环境没有 sessionQuery 服务（全文会话检索不可用）');
            }
            const limit = Math.max(1, Math.min(10, Number(args.limit) || 3));
            let page;
            try {
                page = await sq.searchSessions({ query, limit });
            }
            catch (err) {
                ctx.logger.warn('dsh-persistent-memory: memory_recall search failed: %o', err);
                throw new Error('memory_recall: 历史会话检索失败，稍后再试');
            }
            const hits = (page?.items ?? []).map((h) => ({
                sessionId: String(h?.id ?? ''),
                title: String(h?.title ?? ''),
                seq: Number(h?.bestMatch?.seq ?? 0),
                snippet: String(h?.bestMatch?.text ?? '').slice(0, 400),
            })).filter((h) => h.snippet);
            const summary = hits.length === 0
                ? '没有从历史会话中回捞到相关内容。'
                : `历史会话回捞 ${hits.length} 条：\n` + hits.map((h) => `- [${h.title || h.sessionId} #${h.seq}] ${h.snippet}`).join('\n');
            return {
                hits: hits.map((h) => `${h.title || h.sessionId}#${h.seq}|${h.snippet}`),
                summary,
            };
        },
    })), '@dsh-external/dsh-persistent-memory: memory_recall');
    // ── /memory 斜杠命令：人直接查看/写入记忆，不依赖模型调用工具 ────────
    ctx.commands.register({
        name: 'memory',
        description: '查看/写入持久记忆：status / recall <查询> / remember <key> <内容> / forget <key> / dream / import <文件> / panel',
        input: { hint: '<status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|panel>' },
        recordInput: false,
        handler: (invocation) => executeMemoryCommand(invocation),
    });
    // 自包含 HTML 记忆面板（v0.1.9）：浏览器打开即用，数据内嵌 JSON，支持搜索
    function buildPanelHtml(items) {
        const data = JSON.stringify(items).replace(/</g, '\\u003c');
        const css = 'body{font-family:system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#222}input{width:100%;padding:8px 10px;font-size:15px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px}.item{border:1px solid #e0e0e0;border-radius:8px;padding:10px 14px;margin:10px 0}.key{font-weight:600}.meta{color:#999;font-size:12px;margin-left:8px}.tag{background:#eef2ff;border-radius:4px;padding:1px 6px;font-size:12px;margin-right:4px;color:#334}';
        const js = [
            'const ITEMS = ' + data + ';',
            `const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));`,
            `function render(){const q=document.getElementById('q').value.toLowerCase();const list=ITEMS.filter((i)=>!q||(i.key+' '+i.value+' '+i.tags.join(' ')).toLowerCase().includes(q));document.getElementById('count').textContent='共 '+ITEMS.length+' 条（不含 auth.*）';document.getElementById('list').innerHTML=list.map((i)=>'<div class="item"><div><span class="key">'+esc(i.scope+'/'+i.key)+'</span><span class="meta">'+esc(i.updatedAt.slice(0,10))+'</span>'+i.tags.map((t)=>'<span class="tag">'+esc(t)+'</span>').join('')+'</div><div>'+esc(i.value)+'</div></div>').join('');}`,
            `document.getElementById('q').addEventListener('input',render);render();`,
        ].join('\n');
        return '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 记忆面板</title><style>' + css + '</style></head><body><h2>DSH 记忆面板</h2><p id="count"></p><input id="q" placeholder="搜索 key / 内容 / 标签…"><div id="list"></div><script>' + js + '</script></body></html>';
    }
    async function executeMemoryCommand(invocation) {
        const raw = invocation.rawInput.trim();
        const [sub, ...rest] = raw.split(/\s+/);
        const arg = rest.join(' ').trim();
        const USAGE = 'Usage: /memory <status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|panel>';
        switch (sub) {
            case 'status':
            case 'stats': {
                const items = await withLock(async () => readItems());
                if (items.length === 0)
                    return { kind: 'success', text: '记忆库为空（0 条）。' };
                const scopes = new Map();
                for (const item of items)
                    scopes.set(item.scope, (scopes.get(item.scope) || 0) + 1);
                const lines = [...scopes.entries()].map(([scope, count]) => `- ${scope}: ${count}`).join('\n');
                return { kind: 'success', text: `记忆库共 ${items.length} 条：\n${lines}` };
            }
            case 'recall': {
                if (!arg)
                    return { kind: 'error', text: 'Usage: /memory recall <查询词>' };
                const result = await searchItems({ query: arg, limit: 8 });
                if (result.count === 0)
                    return { kind: 'success', text: '没有匹配的记忆。' };
                const lines = result.items.map((item) => {
                    const cleaned = sanitizeValue(item.value);
                    const value = cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
                    return `- [${item.scope}/${item.key}] ${value}`;
                });
                return { kind: 'success', text: `找到 ${result.count} 条记忆：\n${lines.join('\n')}` };
            }
            case 'remember': {
                const key = rest[0]?.trim() || '';
                const value = rest.slice(1).join(' ').trim();
                if (!key || !value)
                    return { kind: 'error', text: 'Usage: /memory remember <key> <内容>' };
                const now = new Date().toISOString();
                await withLock(async () => {
                    const items = await readItems();
                    const idx = items.findIndex((item) => item.scope === defaultScope && item.key === key);
                    if (idx >= 0) {
                        items[idx] = { ...items[idx], value, updatedAt: now };
                    }
                    else {
                        items.push({ id: makeId(), key, value, scope: defaultScope, tags: [], createdAt: now, updatedAt: now });
                    }
                    await writeItems(items);
                });
                return { kind: 'success', text: `已写入记忆：${defaultScope}/${key}` };
            }
            case 'forget': {
                if (!arg)
                    return { kind: 'error', text: 'Usage: /memory forget <key>' };
                const removed = await withLock(async () => {
                    const items = await readItems();
                    const next = items.filter((item) => !(item.scope === defaultScope && item.key === arg));
                    if (next.length === items.length)
                        return false;
                    await writeItems(next);
                    return true;
                });
                return removed
                    ? { kind: 'success', text: `已删除记忆：${defaultScope}/${arg}` }
                    : { kind: 'success', text: `未找到要删除的记忆：${defaultScope}/${arg}` };
            }
            case 'dream': {
                const items = await withLock(async () => readItems());
                const nowMs = Date.now();
                const DAY = 86_400_000;
                const cands = items
                    .filter((item) => !item.key.startsWith('auth.'))
                    .map((item) => {
                    const ageDays = Math.floor((nowMs - Date.parse(item.updatedAt)) / DAY);
                    let reason = '';
                    let suggest = '';
                    if (item.key.startsWith('task.') && ageDays > 30) {
                        reason = 'task 状态超 30 天未更新';
                        suggest = '更新或删除';
                    }
                    else if (ageDays > 90) {
                        reason = '超 90 天未更新';
                        suggest = '归档或删除';
                    }
                    else if (/done|completed|已完成|完成/.test(item.value) && ageDays > 14) {
                        reason = '标记完成超 14 天';
                        suggest = '删除或归档';
                    }
                    return { item, ageDays, reason, suggest };
                })
                    .filter((c) => c.reason)
                    .sort((a, b) => b.ageDays - a.ageDays)
                    .slice(0, 20);
                if (cands.length === 0)
                    return { kind: 'success', text: '记忆代谢：没有过期候选，记忆库很健康。' };
                const lines = cands.map((c) => `- [${c.item.scope}/${c.item.key}] ${c.ageDays} 天前，${c.reason} → ${c.suggest}`).join('\n');
                return { kind: 'success', text: `记忆代谢候选（${cands.length} 条）：\n${lines}\n\n处理：让 agent 用 memory_set 更新 / memory_forget 删除，或你直接确认。` };
            }
            case 'import': {
                if (!arg)
                    return { kind: 'error', text: 'Usage: /memory import <文件绝对路径>' };
                let raw;
                try {
                    raw = await fs.readFile(arg, 'utf8');
                }
                catch {
                    return { kind: 'error', text: `无法读取文件：${arg}` };
                }
                let entries;
                try {
                    entries = parseImportEntries(raw, arg, { valueMaxChars });
                }
                catch (err) {
                    return { kind: 'error', text: String(err instanceof Error ? err.message : err) };
                }
                if (entries.length === 0)
                    return { kind: 'error', text: `${arg} 没有可导入的内容。` };
                let imported = 0;
                let skipped = 0;
                const now = new Date().toISOString();
                await withLock(async () => {
                    const items = await readItems();
                    for (const e of entries) {
                        const dup = items.some((item) => item.scope === defaultScope
                            && contentSimilarity(item, { key: e.key, value: e.value, scope: defaultScope, tags: [], id: '', createdAt: now, updatedAt: now }) >= 0.7);
                        if (dup) {
                            skipped++;
                            continue;
                        }
                        items.push({ id: makeId(), key: e.key, value: e.value, full: e.full, scope: defaultScope, tags: e.tags, createdAt: now, updatedAt: now, source: `import:${basename(arg)}` });
                        imported++;
                    }
                    await writeItems(items);
                });
                return { kind: 'success', text: `导入完成：${imported} 条新增（${defaultScope}），${skipped} 条与库中已有内容高度相似被跳过。` };
            }
            case 'panel': {
                const items = await withLock(async () => readItems());
                const safe = items.filter((i) => !i.key.startsWith('auth.')).map((i) => ({ scope: i.scope, key: i.key, value: i.value, tags: i.tags, updatedAt: i.updatedAt }));
                const outPath = join(process.cwd(), `memory-panel-${new Date().toISOString().slice(0, 10)}.html`);
                await fs.writeFile(outPath, buildPanelHtml(safe), 'utf8');
                return { kind: 'success', text: `已生成记忆面板：${outPath}\n浏览器打开即可浏览/搜索全部记忆（auth.* 凭据已排除）。` };
            }
            default:
                return { kind: 'error', text: USAGE };
        }
    }
    // settings 面板（v0.1.10）：官方契约——inject 声明 'settings' 强制依赖，apply 内直接 register。
    // register 挂插件 fiber、describe() 供配置 UI 渲染；结果写文件日志便于诊断（不依赖 web 日志重定向）。
    const panelLogFile = join(dataDir, 'settings-panel.log');
    const panelLog = (msg) => {
        void fs.appendFile(panelLogFile, `[${new Date().toISOString()}] ${msg}\n`).catch(() => { });
    };
    try {
        const settingsEntry = {
            autoRecall: runtime.autoRecall,
            autoCapture: runtime.autoCapture,
            autoRecallRerank: runtime.autoRecallRerank,
            rrfRecall: runtime.rrfRecall,
            rrfFirstTurnOnly: runtime.rrfFirstTurnOnly,
            approveOnSet: runtime.approveOnSet,
        };
        const settingsSvc = ctx;
        const panelShape = {
            autoRecall: z.boolean().default(true),
            autoCapture: z.boolean().default(true),
            autoRecallRerank: z.boolean().default(true),
            rrfRecall: z.boolean().default(true),
            rrfFirstTurnOnly: z.boolean().default(true),
            approveOnSet: z.boolean().default(false),
        };
        const scope = settingsSvc.settings.register('dsh-persistent-memory', z.object(panelShape), { base: settingsEntry, applies: 'live' });
        const applyPanel = (next) => {
            const v = next ?? scope.get();
            runtime.autoRecall = Boolean(v.autoRecall);
            runtime.autoCapture = Boolean(v.autoCapture);
            runtime.autoRecallRerank = Boolean(v.autoRecallRerank);
            runtime.rrfRecall = Boolean(v.rrfRecall);
            runtime.rrfFirstTurnOnly = Boolean(v.rrfFirstTurnOnly);
            runtime.approveOnSet = Boolean(v.approveOnSet);
        };
        scope.watch((next) => applyPanel(next));
        applyPanel();
        // M13：字段数动态取自 schema 键数，杜绝 host/client/日志三方漂移
        panelLog('settings panel registered: ns=dsh-persistent-memory fields=' + Object.keys(panelShape).length + ' applies=live');
    }
    catch (err) {
        panelLog('settings panel register FAILED: ' + String(err instanceof Error ? (err.stack || err.message) : err));
    }
    // settings 面板后端路由（v0.1.13）：浏览器组件经同源 fetch 读写本命名空间
    // 模式照 dsh-email：webServer 可选服务 + exact 路由 + localhost-only 访问
    ctx.inject(['webServer'], (webCtx) => {
        const wctx = webCtx;
        wctx.effect(() => {
            const NS = 'dsh-persistent-memory';
            const ROUTE = '/_dsh/dsh-persistent-memory/settings';
            const svc = ctx;
            const respond = (res, status, body) => {
                const bytes = Buffer.from(JSON.stringify(body));
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Content-Length', String(bytes.length));
                res.setHeader('Cache-Control', 'no-store');
                res.writeHead(status);
                res.end(bytes);
            };
            const handler = async (req, res) => {
                const rr = res;
                const remote = String(req.socket?.remoteAddress ?? '');
                if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
                    respond(rr, 403, { ok: false, error: { code: 'forbidden', message: 'dsh-persistent-memory settings route is localhost-only' } });
                    return;
                }
                if (req.method === 'GET') {
                    try {
                        const descriptor = svc.settings.describe().find((row) => row.ns === NS);
                        respond(rr, 200, {
                            ok: true,
                            value: {
                                settings: { value: svc.settings.get(NS), revision: descriptor?.revision ?? 0, applies: descriptor?.applies ?? 'live' },
                                writable: svc.settings.writable !== false,
                            },
                        });
                    }
                    catch (err) {
                        respond(rr, 503, { ok: false, error: { code: 'unavailable', message: String(err) } });
                    }
                    return;
                }
                if (req.method !== 'POST') {
                    rr.setHeader('Allow', 'GET, POST');
                    respond(rr, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } });
                    return;
                }
                let body;
                try {
                    const chunks = [];
                    for await (const chunk of req) {
                        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        if (chunks.reduce((n, c) => n + c.length, 0) + part.length > 256 * 1024)
                            throw new RangeError('request body too large');
                        chunks.push(part);
                    }
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch (err) {
                    respond(rr, 400, { ok: false, error: { code: 'invalid-request', message: String(err) } });
                    return;
                }
                try {
                    if (body?.action === 'save') {
                        if (!Number.isSafeInteger(body.expectedRevision))
                            throw new Error('expectedRevision must be a non-negative integer');
                        await svc.settings.replace(NS, body.value, body.expectedRevision);
                        const descriptor = svc.settings.describe().find((row) => row.ns === NS);
                        respond(rr, 200, { ok: true, value: { settings: { value: svc.settings.get(NS), revision: descriptor?.revision ?? 0, applies: descriptor?.applies ?? 'live' } } });
                    }
                    else {
                        respond(rr, 400, { ok: false, error: { code: 'invalid-request', message: 'unsupported action' } });
                    }
                }
                catch (err) {
                    const conflict = err?.code === 'SETTINGS_CONFLICT';
                    respond(rr, conflict ? 409 : 400, { ok: false, error: { code: conflict ? 'settings-conflict' : 'rejected', message: String(err) } });
                }
            };
            const dispose = wctx.webServer.register({ kind: 'exact', path: ROUTE, handler: handler });
            return dispose;
        }, 'dsh-persistent-memory: settings route');
    });
}
//# sourceMappingURL=index.js.map