import type { MemoryDeps } from './deps.js';
export declare const isCompletedMark: (value: string) => boolean;
export declare const ARCHIVE_SUMMARY_MAX = 80;
export declare const MAX_IMPORT_BYTES: number;
export interface CommitInput {
    key: string;
    value: string;
    full?: string;
    links?: string[];
    scope?: string;
    tags?: string[];
    confirmed?: boolean;
    source?: string;
    /** 用户亲自输入（/memory remember）：人即审批者，豁免 approveOnSet */
    fromUser?: boolean;
}
export interface WriteOps {
    commitMemory: (input: CommitInput, exec?: any) => Promise<{
        ok: true;
        key: string;
        scope: string;
        created: boolean;
        changed: boolean;
        mergedKey: string;
        updatedAt: string;
        warnings?: string[];
    }>;
    importFileToStore: (filePath: string, scope: string, guard?: {
        exec?: any;
        fromUser?: boolean;
    }) => Promise<{
        imported: number;
        skipped: number;
        rejected: number;
        summary: string;
    }>;
    oneLineSummary: (value: string) => string;
    defaultImportScope: () => string;
}
export declare function createWriteOps(deps: MemoryDeps): WriteOps;
