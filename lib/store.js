/**
 * 记忆库读写实现（fs 可注入）。
 * 文件级缓存：stat（mtime+size）未变时复用解析结果，避免每轮 pre-step 重复读盘。
 *
 * B2（原子写）：tmp + fsync + rename——磁盘满/崩溃时主文件保持上一版完整内容；
 * 写前复制 memory.jsonl.bak 保留 1 份上一版快照；启动时主文件 0 字节 + .bak 非空 → 告警。
 * C1（缓存一致性）：readItems 返回副本，杜绝外部就地改写缓存；writeItems 失败必失效，
 * 成功后才刷新缓存。
 */
export function createStore(opts) {
    let itemsCache = null;
    let warnedZeroBak = false;
    let dropped = 0;
    const bakFile = opts.dataFile + '.bak';
    const makeId = opts.makeId ?? (() => 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    const nowIso = opts.now ?? (() => new Date().toISOString());
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
            // C1：返回浅拷贝，杜绝外部就地改写缓存数组（写失败产生"幽灵记忆"的根因之一）
            return itemsCache.items.slice();
        }
        // B2 启动检查：主文件 0 字节而 .bak 非空 = 上一次写入被中断截断过 → 告警
        if (!warnedZeroBak && st.size === 0 && opts.onWarn) {
            warnedZeroBak = true;
            try {
                const bak = await opts.fs.stat(bakFile);
                if (bak.size > 0) {
                    opts.onWarn('memory.jsonl 为 0 字节而 ' + bakFile + ' 非空：上一次写入可能被中断。可从 .bak 恢复或删除主文件后重建。');
                }
            }
            catch { /* 无 .bak 视为正常空库 */ }
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
                // M1 行级规范化：一行不合法只丢一行并计数——修复前单条缺 scope 脏行
                // 会让 scoreItem 的 item.scope.toLowerCase() 崩掉整条召回链（守则/教训/召回/索引全停）。
                // 口径：key/value 必须为 string、scope 缺省/非 string、tags 非数组 → 坏行 dropped++；
                // 空白 scope 补 defaultScope；id/时间戳缺失补默认；links/tags 过滤非字符串元素。
                if (!parsed || typeof parsed.key !== 'string' || !parsed.key.trim()) {
                    dropped++;
                    continue;
                }
                if (typeof parsed.value !== 'string') {
                    dropped++;
                    continue;
                }
                if (parsed.scope === undefined) {
                    dropped++;
                    continue;
                }
                if (typeof parsed.scope !== 'string') {
                    dropped++;
                    continue;
                }
                if (parsed.tags !== undefined && !Array.isArray(parsed.tags)) {
                    dropped++;
                    continue;
                }
                const scope = parsed.scope.trim() ? parsed.scope.trim() : opts.defaultScope;
                items.push({
                    id: typeof parsed.id === 'string' && parsed.id ? parsed.id : makeId(),
                    key: parsed.key,
                    value: parsed.value,
                    scope,
                    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === 'string') : [],
                    createdAt: typeof parsed.createdAt === 'string' && parsed.createdAt ? parsed.createdAt : nowIso(),
                    updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt ? parsed.updatedAt : nowIso(),
                    ...(typeof parsed.full === 'string' ? { full: parsed.full } : {}),
                    ...(Array.isArray(parsed.links) ? { links: parsed.links.filter((link) => typeof link === 'string') } : {}),
                    ...(typeof parsed.source === 'string' ? { source: parsed.source } : {}),
                });
            }
            catch {
                dropped++;
            }
        }
        itemsCache = { mtimeMs: st.mtimeMs, size: st.size, items };
        return items.slice();
    }
    function invalidateCache() {
        itemsCache = null;
    }
    async function writeItems(items) {
        try {
            await opts.fs.mkdir(opts.dataDir, { recursive: true });
            const body = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
            // B2：写前把当前主文件复制为 .bak（保留 1 份上一版完整快照）
            try {
                await opts.fs.copyFile(opts.dataFile, bakFile);
            }
            catch (err) {
                if (err.code !== 'ENOENT')
                    throw err;
            }
            // B2：tmp + write + fsync + close + rename（同盘 rename 原子替换主文件）
            const tmp = opts.dataFile + '.tmp-' + process.pid + '-' + Date.now().toString(36);
            const fh = await opts.fs.open(tmp, 'w');
            try {
                await fh.writeFile(body, 'utf8');
                await fh.sync();
            }
            finally {
                await fh.close();
            }
            await opts.fs.rename(tmp, opts.dataFile);
        }
        finally {
            // C1：无论成败必失效——失败后旧缓存与磁盘状态可能不一致，绝不复用
            invalidateCache();
        }
        // C1：成功后才刷新缓存（按重命名后的新文件 stat），下一次读取直接命中
        const st = await opts.fs.stat(opts.dataFile);
        itemsCache = { mtimeMs: st.mtimeMs, size: st.size, items: items.slice() };
    }
    return { readItems, writeItems, invalidateCache, getDropped: () => dropped };
}
//# sourceMappingURL=store.js.map