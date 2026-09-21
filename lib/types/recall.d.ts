import type { MemoryItem } from './types.js';
export declare const SYNONYM_GROUPS: string[][];
export declare const NOISE_WORDS: string[];
export declare const WEAK_WORDS: string[];
export declare function stripNoise(token: string): string;
export declare function expandToken(token: string): string[];
export declare function queryTokens(query: string): string[];
export declare function tokenizeForSemantic(s: string): string[];
export declare function bigramJaccard(a: string, b: string): number;
export declare function semanticOverlap(query: string, text: string): number;
export declare function keySimilarity(a: string, b: string): number;
export declare function contentSimilarity(a: MemoryItem, b: MemoryItem): number;
export interface ScoreEnv {
    /** 启用同义词扩展评分（代理↔梯子↔vpn、认证↔登录↔凭据等） */
    synonymExpansion: boolean;
    /** task.* 保鲜期（天）：超期在召回评分中降权 */
    taskTtlDays: number;
    /** 当前工作区 scope 小写清单（global 不加不减，命中工作区加权） */
    workspaceScopes: string[];
}
export declare function scoreItem(item: MemoryItem, query: string, isFirstTurn: boolean, env: ScoreEnv): number;
export declare function lexicalHit(item: MemoryItem, query: string): boolean;
export declare function rrfRanking(items: MemoryItem[], query: string, env: ScoreEnv, isFirstTurn?: boolean): {
    item: MemoryItem;
    rrf: number;
}[];
export interface RecallEnv extends ScoreEnv {
    /** 自动召回限定作用域；空串表示不限定 */
    autoRecallScope: string;
    /** 非首轮召回的绝对分数下限 */
    minScore: number;
    /** 相对阈值：低于最高分该比例的记忆不注入；0 表示禁用 */
    relativeFloor: number;
    /** 写入 RRF 混合召回（词法+中文二元组双排名融合） */
    rrfRecall: boolean;
    /** RRF 语义补位是否只在首轮生效 */
    rrfFirstTurnOnly: boolean;
}
export declare function pickRecallItems(items: MemoryItem[], query: string, limit: number, useFallback: boolean, isFirstTurn: boolean, hasImage: boolean, env: RecallEnv): MemoryItem[];
export declare function fitBudget(items: MemoryItem[], budget: number, maxChars: number, sanitize: (s: string) => string, opts?: {
    atLeastOne?: boolean;
}): {
    kept: MemoryItem[];
    used: number;
};
/**
 * 按「渲染后真实长度」收敛（M11 收口；第七轮从 pre-step 的两处重复循环抽成纯函数，便于单测）。
 *
 * fitBudget 的 cost 是条目估算（value + key + 64），不含通道标题、行前缀与「🔗 关联」等包装——
 * 实测每通道低估 17–22 字。直接按估算扣减，后续通道会据虚高的剩余额度误判（索引块挤进真实
 * 已经不足的余额）。这里从尾部（分数最低的项）逐个丢弃，直到渲染长度落进 budget。
 *
 * @param items 已按分数排序的候选
 * @param budget 本通道可用字符数；必须是有限数（调用方保证）。非有限值时不做裁剪原样返回——
 *   NaN 下 `text.length > budget` 恒 false，属 fail-open，故这里只文档化、不额外兜底。
 * @param render 把 kept 渲染成最终注入文本的函数（每轮迭代都会重新调用，故调用方应保持它无副作用）
 * @returns kept 与它的渲染结果；两者始终一致，调用方直接用 text.length 扣减预算。
 *   边界：budget ≤ 0 或单条就超预算时 kept 为空，此时 text 是 render([])（可能仍长于 budget，
 *   那是通道标题的固定开销，调用方以 kept.length > 0 为护栏）。
 */
export declare function fitByRenderedLength<T>(items: T[], budget: number, render: (items: T[]) => string): {
    kept: T[];
    text: string;
};
export declare function truncate(text: string, max: number): string;
export declare function ageLabel(iso: string): string;
