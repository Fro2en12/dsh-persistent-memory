export interface ImportEntry {
    key: string;
    value: string;
    full?: string;
    tags: string[];
}
export declare function slugKey(s: string): string;
/** m11：walk 最大下钻层数——超过即跳过该分支（5000+ 层深链 JSON 不再打爆调用栈） */
export declare const MAX_DEPTH = 32;
/**
 * M7：把导入来源前缀映射成 KEY_PREFIX_WHITELIST 内的合法前缀。
 * 修复前 JSON 分支硬编码根前缀 'import'（不在白名单）：条目能写进库，但事后 memory_set 同 key
 * 会被 validateKeyPrefix 拒绝——成为「只写不改」的孤儿。白名单内的来源前缀原样保留；
 * 否则按内容判定 rule/lesson，兜底 ref，保证返回值永在白名单内。
 */
export declare function importPrefixFor(sourcePrefix: string, content: string): string;
/**
 * 递归遍历 JSON 对象：value 为字符串的节点产出记忆条目，否则按 key 下钻（与 M9 前行为一致）。
 * m11：depth 超过 MAX_DEPTH 直接返回，跳过超深分支而不是抛 RangeError: Maximum call stack size exceeded。
 * seen：同一次解析的 key 占用表（m10），不传则不做唯一化。
 */
export declare function walk(obj: unknown, prefix: string, entries: ImportEntry[], depth?: number, seen?: Map<string, number>): void;
/**
 * 解析导入文件：.json 按条目递归展开；.md/.txt 按段落切分，自动分配 ref/rule/lesson 前缀。
 * value 超 valueMaxChars 截断（md 分支），JSON 分支不截断（与 M9 前行为一致）。
 */
export declare function parseImportEntries(raw: string, filePath: string, opts: {
    valueMaxChars: number;
}): ImportEntry[];
