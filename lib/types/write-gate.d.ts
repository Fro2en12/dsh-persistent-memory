import type { MemoryItem } from './types.js';
/**
 * scope 归一（M8，v0.1.23）：trim + 统一小写。
 *
 * T12（第五轮核对）：审查报告 M8 的原文是「**建议**同时把 _/空格折叠为 -」（措辞为建议，非必须），
 * 且折叠会改写用户已有的 scope 命名（如 "my project" → "my-project"），可能让既有条目的 scope
 * 与用户心智/其它工具不一致；因此本轮**有意只做小写归一**，不折叠 _ 与空格。README 已同步说明。
 * 修复前只 trim：scope='Global' 既不是 'global'（索引分组失败）也不含小写工作区名，
 * 同一逻辑作用域裂成多个物理 scope（该条在索引中隐身、按 scope 精确检索查不到）。
 */
export declare function normalizeScope(scope: string | undefined, defaultScope: string): string;
/** key 前缀白名单硬校验：与守则文本同源（KEY_PREFIX_LIST） */
export declare function validateKeyPrefix(key: string, scope: string): void;
/**
 * M2/S5 增强版凭据正则：写侧拒绝 / 提取器 / 导入闸门共用同一份（防止实现漂移）。
 * 覆盖：弱关键词（token/secret/api key/access key/AccountKey/password/中文口令）、
 * 授权头（Bearer 长串 / Authorization: Basic|Bearer|Token <base64>）、常见厂商前缀
 * （sk-/sk-ant-/sk-proj-/sk_live_/ghp_/github_pat_/glpat-/xox./npm_/AKIA/ASIA）、
 * JWT、带账号密码的连接串、PRIVATE KEY 块。
 * 无任何前缀的长令牌（AWS secret、私钥体、自定义 API key…）由 findHighEntropyCredential 兜底。
 */
export declare const CREDENTIAL_RE: RegExp;
/**
 * S5 高熵兜底：没有任何已知前缀的长令牌（AWS secret、私钥体、自定义 API key…）。
 * 判定（长度 ≥32 且满足其一）：① 同时含大写、小写与数字；② base64 形态且大小写混排
 * 并含 +/= 或数字；③ hex 形态。只作用于 value 的凭据判定——中文正文、普通句子、
 * URL、路径与长驼峰标识都不含这样的连续令牌段，不会误判（见 S5_SAFE 反例用例）。
 */
export declare function findHighEntropyCredential(text: string): string | null;
/** 返回命中的凭据片段（未命中 null）：先已知形态，再高熵兜底 */
export declare function findCredentialMatch(body: string): string | null;
/**
 * C7：凭据掩码（工具出库面用）。记忆原文会随工具返回进入会话上下文并外发至
 * 配置的 LLM provider——auth.* 与命中凭据正则的条目默认只回掩码，保留可识别
 * 前缀（sk-/ghp_/AKIA/Bearer/xox./glpat-/…）以便用户知道"这里有一条什么凭据记忆"。
 */
export declare function maskCredential(text: string): string;
/**
 * T11（第五轮）：自定义敏感词匹配（config.redactPatterns）。与固定 CREDENTIAL_RE 取并集，
 * 只作用于出库掩码，不做写侧拒绝——避免把正常内容误拒（用户可能确实要记录内部代号，只是不该外发）。
 * 非法正则（用户手滑）被忽略，不影响其它模式。
 */
export declare function matchesRedactPattern(text: string, patterns: readonly string[]): boolean;
/** C7：该条目是否属于"默认掩码、需显式确认才返回原文"的类别 */
export declare function isCredentialItem(key: string, value: string): boolean;
export interface UpsertInput {
    key: string;
    value: string;
    full?: string;
    links: string[];
    tags: string[];
    scope: string;
    createdAt: string;
    updatedAt: string;
    /** 来源引证（已解析的最终值） */
    source: string;
    /** args.source 是否显式传入（决定更新时保留旧 source 还是覆盖） */
    explicitSource: boolean;
}
export interface UpsertResult {
    created: boolean;
    mergedKey: string;
    /** 内容高度相似（≥55%）但未合并的已有条目 key（供警告） */
    clashKey?: string;
    clashSim?: number;
}
/** 写入/更新的合并逻辑：同 scope+key 覆盖更新；dedupe 时高相似 key 就地合并；否则 push 新建 */
export declare function upsertMemory(items: MemoryItem[], input: UpsertInput, opts: {
    dedupe: boolean;
    makeId: () => string;
}): UpsertResult;
