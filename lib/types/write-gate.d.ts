import type { MemoryItem } from './types.js';
/**
 * scope 归一（M8，v0.1.23）：trim + 统一小写。
 * 修复前只 trim：scope='Global' 既不是 'global'（索引分组失败）也不含小写工作区名，
 * 同一逻辑作用域裂成多个物理 scope（该条在索引中隐身、按 scope 精确检索查不到）。
 */
export declare function normalizeScope(scope: string | undefined, defaultScope: string): string;
/** key 前缀白名单硬校验：与守则文本同源（KEY_PREFIX_LIST） */
export declare function validateKeyPrefix(key: string, scope: string): void;
/**
 * M2 增强版凭据正则：写侧拒绝 / 提取器 / 导入闸门共用同一份（防止实现漂移）。
 * 覆盖：弱关键词（token/secret/api key/password）、可识别形态
 * （bearer 长串、sk-/ghp_/AKIA、BEGIN PRIVATE KEY 块）与中文口令词。
 */
export declare const CREDENTIAL_RE: RegExp;
/** 返回命中的凭据片段（未命中 null） */
export declare function findCredentialMatch(body: string): string | null;
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
