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
export declare function truncate(text: string, max: number): string;
export declare function ageLabel(iso: string): string;
