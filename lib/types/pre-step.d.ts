/**
 * pre-step 注入四通道（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * 通道顺序：守则（每会话首轮一次）→ 教训/规则 → 召回（词法 + RRF + 可选 LLM 重排）→ 索引兜底，
 * 共享**每轮**总预算 injectionBudgetChars（每次 pre-step 重新起算，不是会话级累计）；
 * 守则不计入预算（它永不被砍）。
 *
 * deps 化说明：原先这些函数闭包在 apply() 上（scoreEnv/recallEnv、rerankMemories、
 * isOwnInjected/AUTO_CAPTURE_FORM/sessionQueryAvailable/buildGuideText 与 pre-step 监听器）。
 * 现在整块搬进 registerPreStep(ctx, deps)，保持「同层闭包」结构——函数体逐字未改，
 * 只是闭包对象从 apply() 作用域换成 deps 解构出的同名局部绑定。
 * sessionInjections / runtime / 各 Map 都是引用传递，与 index.ts 共用同一实例。
 */
import type { Context } from 'cordis';
import type { MemoryDeps } from './deps.js';
export declare function registerPreStep(ctx: Context, deps: MemoryDeps): void;
