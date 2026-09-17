export interface ImportEntry {
    key: string;
    value: string;
    full?: string;
    tags: string[];
}
export declare function slugKey(s: string): string;
/** 递归遍历 JSON 对象：value 为字符串的节点产出记忆条目，否则按 key 下钻（与 M9 前行为一致） */
export declare function walk(obj: unknown, prefix: string, entries: ImportEntry[]): void;
/**
 * 解析导入文件：.json 按条目递归展开；.md/.txt 按段落切分，自动分配 ref/rule/lesson 前缀。
 * value 超 valueMaxChars 截断（md 分支），JSON 分支不截断（与 M9 前行为一致）。
 */
export declare function parseImportEntries(raw: string, filePath: string, opts: {
    valueMaxChars: number;
}): ImportEntry[];
