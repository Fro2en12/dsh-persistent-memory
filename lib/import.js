import { KEY_PREFIX_WHITELIST } from './types.js';
export function slugKey(s) {
    const cleaned = s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return cleaned || 'item';
}
/** m11：walk 最大下钻层数——超过即跳过该分支（5000+ 层深链 JSON 不再打爆调用栈） */
export const MAX_DEPTH = 32;
/** 内容启发式前缀：rule / lesson / ref（md 段落与 importPrefixFor 同源，防止两处漂移） */
function prefixByContent(content) {
    if (/必须|不要|禁止|一律|规则|默认|优先|纠正/i.test(content))
        return 'rule';
    if (/教训|坑|切记|注意/i.test(content))
        return 'lesson';
    return 'ref';
}
/**
 * M7：把导入来源前缀映射成 KEY_PREFIX_WHITELIST 内的合法前缀。
 * 修复前 JSON 分支硬编码根前缀 'import'（不在白名单）：条目能写进库，但事后 memory_set 同 key
 * 会被 validateKeyPrefix 拒绝——成为「只写不改」的孤儿。白名单内的来源前缀原样保留；
 * 否则按内容判定 rule/lesson，兜底 ref，保证返回值永在白名单内。
 */
export function importPrefixFor(sourcePrefix, content) {
    if (KEY_PREFIX_WHITELIST.includes(sourcePrefix))
        return sourcePrefix;
    return prefixByContent(content);
}
/** JSON 分支根前缀：来源前缀 'import' 不在白名单（M7），内容为空 → 兜底 ref */
const JSON_ROOT_PREFIX = importPrefixFor('import', '');
/** m10：同一次解析内 key 唯一化——slugKey 把 a.b / a-b / a_b 折叠成同一 slug，第二条起会被
 *  导入闸门「内容相似 ≥70% 跳过」静默丢弃；重复 key 追加 -2/-3…（同一次调用内唯一即可）。 */
function uniqueKey(key, seen) {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1)
        return key;
    const unique = `${key}-${n}`;
    seen.set(unique, 1);
    return unique;
}
/**
 * 递归遍历 JSON 对象：value 为字符串的节点产出记忆条目，否则按 key 下钻（与 M9 前行为一致）。
 * m11：depth 超过 MAX_DEPTH 直接返回，跳过超深分支而不是抛 RangeError: Maximum call stack size exceeded。
 * seen：同一次解析的 key 占用表（m10），不传则不做唯一化。
 */
export function walk(obj, prefix, entries, depth = 0, seen) {
    if (depth > MAX_DEPTH)
        return;
    // 数组序号用 '.' 拼接：'-0' 会让 key 首段变成 'ref-0'（不在白名单）→ 导入条目事后无法 memory_set
    if (Array.isArray(obj)) {
        obj.forEach((v, i) => walk(v, `${prefix}.${i}`, entries, depth + 1, seen));
        return;
    }
    if (obj && typeof obj === 'object') {
        const o = obj;
        if (typeof o.value === 'string') {
            const key = `${prefix}.${slugKey(String(o.key ?? 'item'))}`;
            entries.push({ key: seen ? uniqueKey(key, seen) : key, value: String(o.value), full: typeof o.full === 'string' ? o.full : undefined, tags: [] });
        }
        else {
            for (const [k, v] of Object.entries(o))
                walk(v, `${prefix}.${slugKey(k)}`, entries, depth + 1, seen);
        }
    }
}
/**
 * 解析导入文件：.json 按条目递归展开；.md/.txt 按段落切分，自动分配 ref/rule/lesson 前缀。
 * value 超 valueMaxChars 截断（md 分支），JSON 分支不截断（与 M9 前行为一致）。
 */
export function parseImportEntries(raw, filePath, opts) {
    const seen = new Map();
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.json')) {
        let data;
        try {
            data = JSON.parse(raw);
        }
        catch {
            throw new Error(`memory_import: ${filePath} 不是合法 JSON`);
        }
        const entries = [];
        walk(data, JSON_ROOT_PREFIX, entries, 0, seen);
        return entries;
    }
    const blocks = raw.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
    const out = [];
    blocks.forEach((block, i) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        const heading = lines.find((l) => l.startsWith('#')) || '';
        const body = lines.filter((l) => !l.startsWith('#')).join(' ');
        const text = body || heading.replace(/^#+\s*/, '');
        if (!text)
            return;
        const tag = heading.replace(/^#+\s*/, '').slice(0, 24);
        const prefix = importPrefixFor('', text);
        out.push({
            key: uniqueKey(`${prefix}.${slugKey(tag || `item${i + 1}`)}`, seen),
            value: text.length > opts.valueMaxChars ? `${text.slice(0, opts.valueMaxChars - 1)}…` : text,
            full: text.length > opts.valueMaxChars ? text : undefined,
            tags: [],
        });
    });
    return out;
}
//# sourceMappingURL=import.js.map