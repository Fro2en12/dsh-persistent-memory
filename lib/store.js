/**
 * 记忆库读写实现（fs 可注入）。
 * 文件级缓存：stat（mtime+size）未变时复用解析结果，避免每轮 pre-step 重复读盘。
 */
export function createStore(opts) {
    let itemsCache = null;
    async function readItems() {
        let st;
        try {
            st = await opts.fs.stat(opts.dataFile);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
        if (itemsCache && itemsCache.mtimeMs === st.mtimeMs && itemsCache.size === st.size) {
            return itemsCache.items;
        }
        let text;
        try {
            text = await opts.fs.readFile(opts.dataFile, 'utf8');
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
        const items = [];
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const parsed = JSON.parse(trimmed);
                // 兼容历史/手工写入的缺字段记录：tags 缺失会令下游 item.tags.includes/map 抛 TypeError，
                // 进而使整个自动召回被外层 catch 静默吞掉（违背"忽略损坏行防崩溃"目标）。
                if (parsed && typeof parsed.key === 'string') {
                    if (!Array.isArray(parsed.tags))
                        parsed.tags = [];
                    items.push(parsed);
                }
            }
            catch {
                // 忽略损坏行，保证插件不因单条坏数据崩溃
            }
        }
        itemsCache = { mtimeMs: st.mtimeMs, size: st.size, items };
        return items;
    }
    function invalidateCache() {
        itemsCache = null;
    }
    async function writeItems(items) {
        await opts.fs.mkdir(opts.dataDir, { recursive: true });
        const body = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
        await opts.fs.writeFile(opts.dataFile, body, 'utf8');
        invalidateCache();
    }
    return { readItems, writeItems, invalidateCache };
}
//# sourceMappingURL=store.js.map