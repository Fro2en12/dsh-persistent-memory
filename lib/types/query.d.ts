/**
 * 查询提取与候选挑选（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * 这些函数原本闭包在 apply() 作用域上，实测只有 pickRecallCandidates 真的读闭包状态
 * （scoreEnv()），其余都是纯函数。故：纯函数原样搬出；pickRecallCandidates 参数化——
 * 新增 env: () => ScoreEnv 形参，函数内保持 rrfRanking(items, query, env()) 的调用形态，
 * 调用点传 scoreEnv 本身（不预先求值）：env() 的求值点与拆分前 rrfRanking(..., scoreEnv())
 * 的参数求值位置逐字对应（红队 P2 收口）。
 */
import { type ScoreEnv } from './recall.js';
import type { MemoryItem } from './types.js';
export declare function extractQuery(messages: unknown[]): {
    query: string;
    hasImage: boolean;
};
export declare function regretSignal(query: string): boolean;
export declare function ruleScene(query: string): boolean;
export declare function isLessonLike(item: MemoryItem): boolean;
export declare function pickLessonItems(items: MemoryItem[], query: string, isRegret: boolean, isRule: boolean, limit: number): MemoryItem[];
export declare function pickRecallCandidates(items: MemoryItem[], query: string, max: number, env: () => ScoreEnv): MemoryItem[];
