export function slugKey(s) {
    const cleaned = s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return cleaned || 'item';
}
/** 递归遍历 JSON 对象：value 为字符串的节点产出记忆条目，否则按 key 下钻（与 M9 前行为一致） */
export function walk(obj, prefix, entries) {
    if (Array.isArray(obj)) {
        obj.forEach((v, i) => walk(v, `${prefix}-${i}`, entries));
        return;
    }
    if (obj && typeof obj === 'object') {
        const o = obj;
        if (typeof o.value === 'string') {
            entries.push({ key: `${prefix}.${slugKey(String(o.key ?? 'item'))}`, value: String(o.value), full: typeof o.full === 'string' ? o.full : undefined, tags: [] });
        }
        else {
            for (const [k, v] of Object.entries(o))
                walk(v, `${prefix}.${slugKey(k)}`, entries);
        }
    }
}
/**
 * 解析导入文件：.json 按条目递归展开；.md/.txt 按段落切分，自动分配 ref/rule/lesson 前缀。
 * value 超 valueMaxChars 截断（md 分支），JSON 分支不截断（与 M9 前行为一致）。
 */
export function parseImportEntries(raw, filePath, opts) {
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
        walk(data, 'import', entries);
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
        let prefix = 'ref';
        if (/必须|不要|禁止|一律|规则|默认|优先|纠正/i.test(text))
            prefix = 'rule';
        else if (/教训|坑|切记|注意/i.test(text))
            prefix = 'lesson';
        out.push({
            key: `${prefix}.${slugKey(tag || `item${i + 1}`)}`,
            value: text.length > opts.valueMaxChars ? `${text.slice(0, opts.valueMaxChars - 1)}…` : text,
            full: text.length > opts.valueMaxChars ? text : undefined,
            tags: [],
        });
    });
    return out;
}
//# sourceMappingURL=import.js.map