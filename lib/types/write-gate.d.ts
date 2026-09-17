import type { MemoryItem } from './types.js';
/** scope 归一：未传/空白回退 defaultScope，仅 trim（大小写归一见 M8） */
export declare function normalizeScope(scope: string | undefined, defaultScope: string): string;
/** key 前缀白名单硬校验：与守则文本同源（KEY_PREFIX_LIST） */
export declare function validateKeyPrefix(key: string, scope: string): void;
/**
 * 凭据检测（与守则同源）：返回需要拒绝的明文凭据原因；
 * 无命中返回 null。token/secret 类弱信号由调用方自行决定警告。
 */
export declare function detectCredentials(body: string): string | null;
/** token/secret/api_key 弱信号检测（当前仅警告；M2 将升级为拒绝） */
export declare function hasWeakCredentialSignal(body: string): boolean;
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
