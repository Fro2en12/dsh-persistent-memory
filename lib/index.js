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
import z from '@deepseek-ai/schemastery';
// C5/M10：DSH 官方 delegation depth（monotone：Math.max(header, runtime options)）。
// 说明：报告建议的 '@deepseek-ai/dsh-subagent/depth' 子路径不在该包 exports 表中
// （运行时 ERR_PACKAGE_PATH_NOT_EXPORTED），主入口官方 re-export delegationDepthOf，故从主入口导入。
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
import { isCredentialItem, matchesRedactPattern, normalizeScope } from './write-gate.js';
import { createStore, withConflictRetry } from './store.js';
import { PLUGIN_NAME } from './const.js';
import { registerExtraction } from './extract.js';
import { registerPreStep } from './pre-step.js';
import { createWriteOps } from './write-ops.js';
import { registerPanel } from './panel.js';
import { registerTools } from './tools.js';
import { registerCommands } from './commands.js';
export const name = PLUGIN_NAME;
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
    fullMaxChars: z.number().default(8000),
    maxItems: z.number().default(2000),
    taskTtlDays: z.number().default(30),
    autoExtract: z.boolean().default(true),
    autoExtractCooldownMs: z.number().default(120 * 1000),
    injectionBudgetChars: z.number().default(1200),
    importAllowRoots: z.array(z.string()).default([]),
    allowCredentialReveal: z.boolean().default(false),
    redactPatterns: z.array(z.string()).default([]),
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
    // M11 会话级总预算（v0.1.23）：修复前四通道各有独立预算、守则与索引完全不受约束，
    // 最坏单轮 ≈ 守则 3000 + 教训 300 + 召回 300 + 索引 160，而用户以为旋钮是 300。
    const injectionBudgetChars = Math.max(300, config.injectionBudgetChars || 1200);
    // 召回阈值（v0.1.17）：绝对下限挡"整体都不相关"，相对比例挡"矮子里拔将军"。
    // 参考 mem0 的 threshold（归一化相似度绝对门槛）与 Zep 的 limit + reranker 两级做法。
    const autoRecallMinScore = Math.max(0, config.autoRecallMinScore ?? 3);
    const autoRecallRelativeFloor = Math.max(0, Math.min(1, config.autoRecallRelativeFloor ?? 0.5));
    const autoRecallScope = (config.autoRecallScope || '').trim();
    const autoRecallFallback = config.autoRecallFallback === true;
    const autoCapture = config.autoCapture !== false;
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
    // m9：full 总长上限——修复前同一 key 反复超长更新会把原文一再追加进 full，无限膨胀
    const fullMaxChars = Math.max(1000, config.fullMaxChars || 8000);
    // T10/T11（第五轮）：凭据揭示开关与自定义敏感词
    const allowCredentialReveal = config.allowCredentialReveal === true;
    const redactPatterns = Array.isArray(config.redactPatterns)
        ? config.redactPatterns.filter((pattern) => typeof pattern === 'string' && pattern.trim() !== '')
        : [];
    /** 出库掩码判定：固定凭据正则 ∪ 自定义敏感词 */
    const shouldMaskOutbound = (key, value) => isCredentialItem(key, value) || matchesRedactPattern(value, redactPatterns);
    // M12 容量守卫（v0.1.23）：条数无上限时，召回扫描与「整库重写」I/O 都随库线性劣化。
    // 默认 2000，可按需调小（小库/测试场景）；只挡「新增」——更新已有条目永远放行。
    const maxItems = Math.max(1, Math.floor(Number(config.maxItems) || 2000));
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
        unlink: (p) => fs.unlink(p),
        utimes: (p, t) => fs.utimes(p, new Date(t), new Date(t)),
    };
    const store = createStore({ fs: storeFs, dataDir, dataFile, defaultScope, makeId, now: () => new Date().toISOString() });
    const readItems = () => store.readItems();
    const writeItems = (items) => store.writeItems(items);
    // M8：启动时一次性迁移历史数据里的大小写非规范 scope（改前的手工编辑/旧版本产物）
    async function migrateScopeCase() {
        try {
            const renamed = await withLock(() => withConflictRetry(async () => {
                const items = await readItems();
                const changed = [];
                let dirty = false;
                for (const item of items) {
                    const lower = item.scope.toLowerCase();
                    if (lower !== item.scope) {
                        changed.push(item.key + '(' + item.scope + ' → ' + lower + ')');
                        item.scope = lower;
                        dirty = true;
                    }
                }
                if (!dirty)
                    return [];
                await writeItems(items);
                return changed;
            }));
            if (renamed.length > 0) {
                ctx.logger.warn('dsh-persistent-memory: 启动迁移：%d 条记忆的 scope 已归一为小写：%s', renamed.length, renamed.slice(0, 20).join('、'));
            }
        }
        catch (err) {
            ctx.logger.warn('dsh-persistent-memory: scope 归一迁移失败（不影响使用）：%o', err);
        }
    }
    void migrateScopeCase();
    // 检索公共实现：memory_search 工具与 /memory recall 命令共用
    async function searchItems(options) {
        const query = String(options.query || '').trim().toLowerCase();
        const scopeFilter = options.scope ? normalizeScope(options.scope, defaultScope) : undefined;
        const tagsFilter = normalizeTags(options.tags);
        const limit = Math.max(1, Math.min(100, Number(options.limit) || maxResults));
        return withLock(async () => {
            const items = await readItems();
            const matched = items.filter((item) => {
                if (options.allowedScopes && !options.allowedScopes.includes(item.scope))
                    return false;
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
    async function persistInjectionStateNow() {
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
    }
    function persistInjectionState() {
        if (persistTimer)
            return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            void persistInjectionStateNow();
        }, 500);
        persistTimer.unref?.();
    }
    // m7：卸载/热重载时 flush——否则进程在 500ms 去抖窗口内退出会丢掉本次注入记录，
    // 重启后同一会话重复注入守则/召回
    ctx.effect(() => () => {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        void persistInjectionStateNow();
    }, 'dsh-persistent-memory: flush injection state');
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
    // ── 记忆新鲜度（借鉴 Claude Code memoryAge.ts）────────────────────────
    // 天龄显示：今天/昨天/N 天前。模型对原始 ISO 时间戳的"过期感"很差，
    // "47 天前"比 ISO 串更能触发过期推理。
    /** M11：入参已由调用方按「min(单通道预算, 剩余总预算)」裁剪 */
    /** M11：入参已由调用方按「min(单通道预算, 剩余总预算)」裁剪 */
    // 子代理探测（C5/M10，v0.1.23；S2 加固，v0.1.24）：只有「能明确证明是主会话」才返回 false——
    // 会话身份（session.id）、header、runtime options 齐备 + 深度 0 + 无任何子代理标记，
    // 任何一项缺失或不确定一律按子代理（fail-closed）。不依赖上游 delegationDepthOf 抛错兜底：
    // 上游只在 options 缺失/subagentDepth 畸形时抛，{session:{header:{}}, options:{}} 会返回 0。
    //
    // 为什么正向证据用「session.id」而不是「header.delegationDepth 显式等于 0」：DSH 进程内新建的
    // 顶层会话 header 不带 delegationDepth（SessionStore.prepare 仅在 meta 提供时写入，见
    // @deepseek-ai/dsh-session 的 prepare；GUI/session-controller 建会话的 meta 只有 cwd/agentPreset，
    // agentOptions 只有 provider/model），而子代理会话必然带 origin/parentSession/delegationDepth
    // （@deepseek-ai/dsh-subagent 的 childSessionMeta）。要求显式深度会把新鲜顶层会话误判为子代理。
    // 深度仍用 DSH 官方 delegationDepthOf（单调取大：header 权威，runtime options 只能加深）。
    // T8（第五轮调查结论）：残留折中「{session:{id,header:{}},options:{}} 判为主会话」在生产**不可达作为子代理**——
    // DSH 的子代理会话由 childSessionMeta 构造（packages/subagent/subagent/src/child-agent.ts:139-158），
    // 必写 parentSession / origin:'subagent' / delegationDepth（注释标为 Durable，持久化后仍在），
    // 而 packages/core/agent/src/runtime-types.ts:166 的 Agent.options 恒存在（字段全可选，缺失时不影响判定）。
    // 顶层主会话的 header 只带 cwd/agentPreset，正是该形状 → 判主会话正确。收紧这条的代价是把所有新鲜顶层
    // 主会话误判为子代理（写不了 global + 只读守则 + 提取器停摆），故保持现状并在此固化依据。
    function isSubagentAgent(agent) {
        const session = agent?.session;
        if (session === null || typeof session !== 'object')
            return true; // 拿不到会话 → 按子代理
        if (typeof session.id !== 'string' || session.id === '')
            return true; // 没有会话身份 → 证明不了是主会话
        const h = session.header;
        if (h === null || typeof h !== 'object')
            return true; // 拿不到 header → 按子代理
        if (agent.options === null || typeof agent.options !== 'object')
            return true; // 拿不到 runtime options → 按子代理
        let depth;
        try {
            depth = delegationDepthOf(agent);
        }
        catch {
            return true;
        } // 畸形 subagentDepth 也是不确定
        if (!Number.isSafeInteger(depth) || depth !== 0)
            return true; // 深度非 0 → 子代理
        // 子代理标记三件套（childSessionMeta）：origin / parentSession；parentId 兼容仅运行时的视图
        if (h.origin === 'subagent')
            return true;
        if (h.parentSession !== undefined && h.parentSession !== null)
            return true;
        if (h.parentId !== undefined && h.parentId !== null)
            return true;
        return false;
    }
    // ── 轮末自动提取（对标 Claude Code extractMemories：AI 用 AI 写记忆）────────
    // 订阅 session/event 火线缓冲每个会话当前 turn 的文本；agent/turn-stopping 时
    // 异步调 LLM 提取高置信候选，过最小闸门后落盘。互斥：主 agent 30s 内手动写过
    // 记忆 → 跳过；提取中 → 跳过；冷却内 → 跳过。两个监听器都绝不抛错。
    const turnBuffers = new Map();
    const lastExtractAt = new Map();
    const lastManualWriteAt = new Map();
    // m7：会话级 Map 的廉价上限（依赖 Map 插入顺序删最旧），避免长生命周期进程无界增长
    function setBounded(map, key, value, max = 200) {
        map.set(key, value);
        while (map.size > max) {
            const oldest = map.keys().next().value;
            if (oldest === undefined)
                break;
            map.delete(oldest);
        }
    }
    // M5：并发粒度——per-session 互斥 + 全局上限（修复前是全局单例布尔：两个会话同时
    // 结束回合时后到者被静默丢弃，而它已经写过 lastExtractAt，整个冷却周期不再尝试）
    const extractingSessions = new Set();
    // 第 2 批拆分：装箱成对象字段，deps 传递的是同一引用（解构成 number 会让并发上限失效）
    const extractCounters = { globalInFlight: 0 };
    // ── 显式依赖对象（第 2 批拆分）────────────────────────────────────────
    // 拆分前所有函数都闭包在 apply() 作用域上；现在把「共享状态 + 归一化配置常量 +
    // 辅助函数」打包成同一实例，沿 registerXxx(ctx, deps) 传递。
    // 禁止 { ...deps } 展开或重建：sessionInjections 分叉 → 注入去重失效；
    // extractCounters 分叉 → 提取并发上限失效（M5）；runtime 分叉 → 面板开关失效（B1）。
    const deps = {
        // 配置面
        dataDir,
        dataFile,
        defaultScope,
        maxResults,
        autoRecall,
        autoRecallLimit,
        autoRecallMaxChars,
        autoRecallBudgetChars,
        injectionBudgetChars,
        autoRecallMinScore,
        autoRecallRelativeFloor,
        autoRecallScope,
        autoRecallFallback,
        autoCapture,
        autoExtract,
        autoExtractCooldownMs,
        autoRecallOnce,
        autoRecallCooldownMs,
        rrfRecall,
        rrfFirstTurnOnly,
        approveOnSet,
        synonymExpansion,
        dedupeOnSet,
        autoRecallRerank,
        taskTtlDays,
        autoRecallRerankMax,
        valueMaxChars,
        fullMaxChars,
        allowCredentialReveal,
        redactPatterns,
        maxItems,
        // 运行时开关（面板写、消费点读）
        runtime,
        // store 面
        store,
        readItems,
        writeItems,
        withLock,
        searchItems,
        // 会话状态
        sessionInjections,
        persistInjectionState,
        turnBuffers,
        lastExtractAt,
        lastManualWriteAt,
        extractingSessions,
        extractCounters,
        // 工具函数
        makeId,
        normalizeTags,
        setBounded,
        isSubagentAgent,
        currentWorkspaceScopes,
        shouldMaskOutbound,
        importAllowRoots: () => config.importAllowRoots,
    };
    // 写侧共享实现（commitMemory / importFileToStore / oneLineSummary）：tools 与 commands 共用同一实例
    const writeOps = createWriteOps(deps);
    registerExtraction(ctx, deps);
    registerPreStep(ctx, deps);
    // ── 8 个记忆工具（已拆到 src/tools.ts，第 2 批）──────────────────────
    registerTools(ctx, deps, writeOps);
    // ── /memory 斜杠命令（已拆到 src/commands.ts，第 2 批）───────────────
    registerCommands(ctx, deps, writeOps);
    registerPanel(ctx, deps);
}
//# sourceMappingURL=index.js.map