import type { MemoryItem } from './types.js';
export declare function excludeCredentials(items: MemoryItem[]): MemoryItem[];
export declare function formatRecall(items: MemoryItem[], all: MemoryItem[], maxChars: number): string;
export declare function formatLesson(items: MemoryItem[], maxChars: number): string;
export declare function buildRerankManifest(items: MemoryItem[]): string;
export declare function buildIndexBlock(rawItems: MemoryItem[], workspaceScopes: string[], excludeKeys?: Set<string>): string;
