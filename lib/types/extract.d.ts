/**
 * 轮末自动提取（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * 订阅 session/event 火线缓冲每个会话当前 turn 的文本；agent/turn-stopping 时异步调 LLM
 * 提取高置信候选，过最小闸门后落盘。互斥：主 agent 30s 内手动写过记忆 → 跳过；提取中 →
 * 跳过；冷却内 → 跳过。两个监听器都绝不抛错。
 *
 * deps 化说明：本模块不再闭包 apply()，所有共享状态与常量经 deps 传入；其中
 * turnBuffers / lastExtractAt / lastManualWriteAt / extractingSessions 是引用传递，
 * extractCounters 必须整体传引用（解构成 number 会让全局并发上限失效）。
 */
import type { Context } from 'cordis';
import type { MemoryDeps } from './deps.js';
export declare function registerExtraction(ctx: Context, deps: MemoryDeps): void;
