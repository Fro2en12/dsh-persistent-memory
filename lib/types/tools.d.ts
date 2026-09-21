/**
 * 8 个记忆工具（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * memory_set / memory_get / memory_search / memory_forget / memory_stats / memory_dream /
 * memory_import / memory_recall。注册顺序、ctx.effect 包装与第二个参数的标签字符串逐字未变
 * （tests/minor-batch.spec.ts 断言 effect 名称，integration-smoke.spec.ts 断言 8 个工具名齐全）。
 *
 * 依赖形态：registerTools(ctx, deps, writeOps)；writeOps 与 commands 共用同一实例
 * （createWriteOps 在 apply() 内只构造一次）。
 */
import type { Context } from 'cordis';
import type { MemoryDeps } from './deps.js';
import { type WriteOps } from './write-ops.js';
export declare function registerTools(ctx: Context, deps: MemoryDeps, writeOps: WriteOps): void;
