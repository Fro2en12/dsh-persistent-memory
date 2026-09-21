import { KEY_PREFIX_WHITELIST, KEY_PREFIX_LIST } from './types.js';
import { contentSimilarity, keySimilarity } from './recall.js';
/**
 * scope 归一（M8，v0.1.23）：trim + 统一小写。
 *
 * T12（第五轮核对）：审查报告 M8 的原文是「**建议**同时把 _/空格折叠为 -」（措辞为建议，非必须），
 * 且折叠会改写用户已有的 scope 命名（如 "my project" → "my-project"），可能让既有条目的 scope
 * 与用户心智/其它工具不一致；因此本轮**有意只做小写归一**，不折叠 _ 与空格。README 已同步说明。
 * 修复前只 trim：scope='Global' 既不是 'global'（索引分组失败）也不含小写工作区名，
 * 同一逻辑作用域裂成多个物理 scope（该条在索引中隐身、按 scope 精确检索查不到）。
 */
export function normalizeScope(scope, defaultScope) {
    const s = (scope || defaultScope).trim().toLowerCase();
    return s || 'global';
}
/** key 前缀白名单硬校验：与守则文本同源（KEY_PREFIX_LIST） */
export function validateKeyPrefix(key, scope) {
    const prefix = key.split('.')[0];
    if (!KEY_PREFIX_WHITELIST.includes(prefix) && prefix !== scope) {
        throw new Error(`memory_set: key 前缀 "${prefix}" 不在分类白名单（${KEY_PREFIX_LIST}）。项目专属记忆请把项目名写进 scope 参数、key 前缀用标准分类（如 task.xxx 配 scope=项目名）；确需项目名前缀时 scope 须与 key 前缀一致。`);
    }
}
/**
 * M2/S5 增强版凭据正则：写侧拒绝 / 提取器 / 导入闸门共用同一份（防止实现漂移）。
 * 覆盖：弱关键词（token/secret/api key/access key/AccountKey/password/中文口令）、
 * 授权头（Bearer 长串 / Authorization: Basic|Bearer|Token <base64>）、常见厂商前缀
 * （sk-/sk-ant-/sk-proj-/sk_live_/ghp_/github_pat_/glpat-/xox./npm_/AKIA/ASIA）、
 * JWT、带账号密码的连接串、PRIVATE KEY 块。
 * 无任何前缀的长令牌（AWS secret、私钥体、自定义 API key…）由 findHighEntropyCredential 兜底。
 */
export const CREDENTIAL_RE = /token|secret|api[_-]?key|access[_-]?key|accountkey|password|passwd|密码|口令|密钥|bearer\s+\S{16,}|(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer|token)\s+[A-Za-z0-9+/=_.-]{12,}|\bbasic\s+[A-Za-z0-9+/=]{16,}|\bsk-[A-Za-z0-9]{16,}|\bsk-ant-[A-Za-z0-9_-]{16,}|\bsk-proj-[A-Za-z0-9_-]{16,}|\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bnpm_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}|\bASIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|BEGIN[ A-Z]*PRIVATE KEY|(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|sqlserver|ftp|sftp|smtp|ldap):\/\/[^\s:@\/]+:[^\s@\/]+@/i;
/** 高熵令牌候选：连续 ≥32 个令牌字符（不含空格/点/冒号，URL 与路径不会被整段吞进来） */
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+/=_-]{32,}/g;
/** base64 形态（标准字母表，允许尾部 = 填充） */
const BASE64_SHAPE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** hex 形态（md5/sha/无前缀 hex token） */
const HEX_SHAPE_RE = /^[0-9a-f]+$/i;
/** URL/路径形态（com/foo/bar-baz、E:/Work/proj2/src/index）是正常长文本，不是凭据。
 *  判定收紧到两类：① 首段是 TLD 形态（URL 残段）；② ≥4 段文件路径。
 *  这样 40 字符的 AWS secret（wJalr…/K7MDENG/bPxRfi…，3 段且首段非全小写）不会被豁免。 */
function looksLikePathOrUrl(token) {
    const trimmed = token.replace(/^[.\/\\]+/, '');
    const segments = trimmed.split('/');
    if (segments.length < 3)
        return false;
    if (!segments.every((seg) => /^[A-Za-z0-9._-]+$/.test(seg)))
        return false;
    if (/^[a-z]{2,10}$/.test(segments[0]))
        return true;
    return segments.length >= 4;
}
/**
 * S5 高熵兜底：没有任何已知前缀的长令牌（AWS secret、私钥体、自定义 API key…）。
 * 判定（长度 ≥32 且满足其一）：① 同时含大写、小写与数字；② base64 形态且大小写混排
 * 并含 +/= 或数字；③ hex 形态。只作用于 value 的凭据判定——中文正文、普通句子、
 * URL、路径与长驼峰标识都不含这样的连续令牌段，不会误判（见 S5_SAFE 反例用例）。
 */
export function findHighEntropyCredential(text) {
    const candidates = text.match(ENTROPY_CANDIDATE_RE);
    if (!candidates)
        return null;
    for (const token of candidates) {
        if (token.length < 32 || looksLikePathOrUrl(token))
            continue;
        const hasUpper = /[A-Z]/.test(token);
        const hasLower = /[a-z]/.test(token);
        const hasDigit = /[0-9]/.test(token);
        if (hasUpper && hasLower && hasDigit)
            return token;
        if (BASE64_SHAPE_RE.test(token) && hasUpper && hasLower && (/[+/=]/.test(token) || hasDigit))
            return token;
        if (HEX_SHAPE_RE.test(token) && hasDigit)
            return token;
    }
    return null;
}
/** 返回命中的凭据片段（未命中 null）：先已知形态，再高熵兜底 */
export function findCredentialMatch(body) {
    const m = body.match(CREDENTIAL_RE);
    if (m)
        return m[0];
    return findHighEntropyCredential(body);
}
/**
 * C7：凭据掩码（工具出库面用）。记忆原文会随工具返回进入会话上下文并外发至
 * 配置的 LLM provider——auth.* 与命中凭据正则的条目默认只回掩码，保留可识别
 * 前缀（sk-/ghp_/AKIA/Bearer/xox./glpat-/…）以便用户知道"这里有一条什么凭据记忆"。
 */
export function maskCredential(text) {
    const m = text.match(/(sk-ant-|sk-proj-|sk_live_|sk_test_|github_pat_|glpat-|xox[abposr]-|npm_|sk-|ghp_|AKIA|ASIA|Bearer\s+|Basic\s+)/i);
    if (m)
        return `${m[1]}****（凭据已掩码，memory_get 带 confirmed:true 可取回原文）`;
    return '****（凭据类记忆已掩码，memory_get 带 confirmed:true 可取回原文）';
}
/**
 * T11（第五轮）：自定义敏感词匹配（config.redactPatterns）。与固定 CREDENTIAL_RE 取并集，
 * 只作用于出库掩码，不做写侧拒绝——避免把正常内容误拒（用户可能确实要记录内部代号，只是不该外发）。
 * 非法正则（用户手滑）被忽略，不影响其它模式。
 */
export function matchesRedactPattern(text, patterns) {
    for (const pattern of patterns) {
        if (typeof pattern !== 'string' || pattern.trim() === '')
            continue;
        try {
            if (new RegExp(pattern, 'i').test(text))
                return true;
        }
        catch {
            // 非法正则：忽略该模式（调用方启动时会 warn）
        }
    }
    return false;
}
/** C7：该条目是否属于"默认掩码、需显式确认才返回原文"的类别 */
export function isCredentialItem(key, value) {
    return key.toLowerCase().startsWith('auth.') || findCredentialMatch(value) !== null;
}
/** T17：字符串数组按值比较（undefined 与空数组等价）；用于判定 upsert 是否为空操作 */
function sameStringArray(a, b) {
    const x = a ?? [];
    const y = b ?? [];
    return x.length === y.length && x.every((v, i) => v === y[i]);
}
/** 写入/更新的合并逻辑：同 scope+key 覆盖更新；dedupe 时高相似 key 就地合并；否则 push 新建 */
export function upsertMemory(items, input, opts) {
    const { key, value, full, links, tags, scope, createdAt, updatedAt, source, explicitSource } = input;
    let idx = items.findIndex((item) => item.scope === scope && item.key === key);
    let created = false;
    let mergedKey = '';
    let clashKey;
    let clashSim;
    // ④ 去重合并：同 scope 下 key 高度相似的旧条目视为同一条记忆，就地更新而非新建
    if (idx < 0 && opts.dedupe) {
        const similar = items
            .map((item, i) => ({ i, sim: item.scope === scope ? keySimilarity(item.key, key) : 0 }))
            .filter((entry) => entry.sim >= 0.6)
            .sort((a, b) => b.sim - a.sim)[0];
        if (similar) {
            idx = similar.i;
            mergedKey = items[idx].key;
        }
    }
    if (idx >= 0) {
        const prev = items[idx];
        const nextFull = full !== undefined ? full : prev.full;
        const nextLinks = links.length ? links : prev.links;
        const nextTags = tags.length ? tags : prev.tags;
        const nextSource = explicitSource ? source : prev.source;
        // T17（第六轮）：空操作防护。updatedAt 被召回排序（recall.ts）、年龄标签与
        // memory_dream 的过期判定（index.ts 的 ageDaysOf 分支）消费；无条件刷新会让反复
        // 重申的旧记忆永远显得新鲜，代谢判定随之失效。内容全等时不动条目、不刷新时间，
        // 由调用方据此跳过整次落盘。
        const changed = prev.value !== value
            || prev.full !== nextFull
            || !sameStringArray(prev.links, nextLinks)
            || !sameStringArray(prev.tags, nextTags)
            || prev.source !== nextSource;
        if (!changed)
            return { created: false, mergedKey, changed: false, updatedAt: prev.updatedAt };
        items[idx] = { ...prev, value, full: nextFull, links: nextLinks, tags: nextTags, updatedAt, source: nextSource };
    }
    else {
        // v0.1.9 内容冲突检测：同 scope 已有内容高度相似的条目 → 警告提示确认，不静默并存
        const clash = items
            .map((item, i) => ({
            i,
            sim: item.scope === scope
                ? contentSimilarity(item, { key, value, scope, tags: [], id: '', createdAt, updatedAt })
                : 0,
        }))
            .filter((entry) => entry.sim >= 0.55)
            .sort((a, b) => b.sim - a.sim)[0];
        if (clash) {
            clashKey = items[clash.i].key;
            clashSim = clash.sim;
        }
        items.push({ id: opts.makeId(), key, value, full, links: links.length ? links : undefined, scope, tags, createdAt, updatedAt, source });
        created = true;
    }
    return { created, mergedKey, changed: true, updatedAt, ...(clashKey !== undefined ? { clashKey, clashSim } : {}) };
}
//# sourceMappingURL=write-gate.js.map