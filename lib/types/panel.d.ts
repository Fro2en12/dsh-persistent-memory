import type { Context } from 'cordis';
import type { MemoryDeps } from './deps.js';
export declare function buildPanelHtml(items: {
    scope: string;
    key: string;
    value: string;
    tags: string[];
    updatedAt: string;
}[]): string;
export declare function registerPanel(ctx: Context, deps: MemoryDeps): void;
