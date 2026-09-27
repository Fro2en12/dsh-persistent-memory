import type { Context } from '@deepseek-ai/cordis';
import { type WriteOps } from './write-ops.js';
import type { MemoryDeps } from './deps.js';
export declare function registerCommands(ctx: Context, deps: MemoryDeps, writeOps: WriteOps): void;
