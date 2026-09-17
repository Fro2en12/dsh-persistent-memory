/** n3：JSONL 首行 schema 哨兵——未来字段迁移的抓手（读取时跳过，不计入条目/坏行） */
export const SCHEMA_SENTINEL = '{"__schema":1}';
/** 乐观并发冲突：磁盘版本已不是本实例读到的那一版（B3 跨进程保护） */
export class StoreConflictError extends Error {
    code = 'MEMORY_STORE_CONFLICT';
    constructor(message) {
        super(message);
        this.name = 'StoreConflictError';
    }
}
/**
 * B3：冲突重试助手。fn 内必须是「读 → 改 → 写」的完整序列——
 * writeItems 失败会失效缓存，重试时 readItems 会重新读盘，绝不基于旧快照重写。
 */
export async function withConflictRetry(fn, attempts = 5) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        }
        catch (err) {
            if (!(err instanceof StoreConflictError))
                throw err;
            lastErr = err;
        }
    }
    throw lastErr ?? new StoreConflictError('memory.jsonl 并发写入冲突，重试次数已用尽');
}
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
    // B3：跨进程写锁（fs.open 'wx' 独占创建 + 陈旧锁超时清除）。
    // 单靠 size/mtime 乐观校验有 TOCTOU 窗口（校验与 rename 之间会让出事件循环），
    // 两者叠加：锁负责互斥，版本校验负责挡住绕过锁的外部写入（手工编辑/其它工具）。
    const LOCK_STALE_MS = 10_000;
    const LOCK_WAIT_MS = 10_000;
    const lockFile = opts.dataFile + '.lock';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function acquireWriteLock() {
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            try {
                const fh = await opts.fs.open(lockFile, 'wx');
                try {
                    await fh.writeFile(String(process.pid), 'utf8');
                }
                finally {
                    await fh.close();
                }
                return releaseWriteLock;
            }
            catch (err) {
                const code = err.code;
                // EEXIST = 锁已被持有；Windows 上并发创建/删除同名文件还会报 EPERM/EACCES/EBUSY
                // （共享冲突而非"已存在"），同样按「锁被占用」处理并重试
                if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
                    throw err;
            }
            // 陈旧锁（持有者崩溃）：超过 LOCK_STALE_MS 未更新则清除
            try {
                const st = await opts.fs.stat(lockFile);
                if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                    try {
                        await opts.fs.unlink(lockFile);
                    }
                    catch { /* 竞态下别人已清 */ }
                    continue;
                }
            }
            catch { /* 锁已消失，立即重试 */
                continue;
            }
            if (Date.now() > deadline) {
                throw new StoreConflictError('无法获取 memory.jsonl 写锁（等待超时），本次写入放弃以避免覆盖');
            }
            await sleep(5 + Math.floor(Math.random() * 15));
        }
    }
    async function releaseWriteLock() {
        for (let i = 0; i < 3; i++) {
            try {
                await opts.fs.unlink(lockFile);
                return;
            }
            catch {
                await sleep(10);
            }
        }
    }
    let itemsCache = null;
    // B3：本实例读到的磁盘版本（null = 没读过；stamp=null = 读到的是不存在的文件）
    let readState = null;
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
            if (err.code === 'ENOENT') {
                // 读到「文件不存在」也是有效版本：此后若文件被别的进程创建，本实例写入必须报冲突
                readState = { stamp: null };
                return [];
            }
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
            if (err.code === 'ENOENT') {
                readState = { stamp: null };
                return [];
            }
            throw err;
        }
        const items = [];
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const parsed = JSON.parse(trimmed);
                // n3：schema 哨兵行既不是条目也不是坏行
                if (parsed && typeof parsed.__schema === 'number')
                    continue;
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
        readState = { stamp: { mtimeMs: st.mtimeMs, size: st.size } };
        return items.slice();
    }
    function invalidateCache() {
        itemsCache = null;
        readState = null;
    }
    async function writeItems(items) {
        const release = await acquireWriteLock();
        try {
            await writeItemsLocked(items);
        }
        finally {
            await release();
        }
    }
    async function writeItemsLocked(items) {
        try {
            // B3 乐观并发：磁盘仍是本实例读到的那一版才允许覆盖，否则交给 withConflictRetry 重试
            if (readState) {
                let cur = null;
                try {
                    cur = await opts.fs.stat(opts.dataFile);
                }
                catch (err) {
                    if (err.code !== 'ENOENT')
                        throw err;
                }
                const expected = readState.stamp;
                const sameVersion = expected === null
                    ? cur === null
                    : cur !== null && cur.mtimeMs === expected.mtimeMs && cur.size === expected.size;
                if (!sameVersion) {
                    throw new StoreConflictError('memory.jsonl 已被其他进程修改（size/mtime 不一致），本次写入放弃以避免覆盖');
                }
            }
            await opts.fs.mkdir(opts.dataDir, { recursive: true });
            const body = SCHEMA_SENTINEL + '\n' + items.map((item) => JSON.stringify(item)).join('\n') + '\n';
            // B2：写前把当前主文件复制为 .bak（保留 1 份上一版完整快照）
            try {
                await opts.fs.copyFile(opts.dataFile, bakFile);
            }
            catch (err) {
                if (err.code !== 'ENOENT')
                    throw err;
            }
            // B2：tmp + write + fsync + close + rename（同盘 rename 原子替换主文件）
            // 随机后缀：同一进程内并发写（以及 pid 复用）不能让两个 tmp 同名，否则 rename 互相抢文件
            const tmp = opts.dataFile + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
            try {
                const fh = await opts.fs.open(tmp, 'w');
                try {
                    await fh.writeFile(body, 'utf8');
                    await fh.sync();
                }
                finally {
                    await fh.close();
                }
                try {
                    await opts.fs.rename(tmp, opts.dataFile);
                }
                catch (err) {
                    // Windows 并发替换目标文件会报 EPERM/EBUSY/EACCES —— 语义上就是「别人正在改」，按冲突重试
                    const code = err.code;
                    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
                        throw new StoreConflictError('memory.jsonl 正被其他进程替换（' + code + '），本次写入放弃以避免覆盖');
                    }
                    throw err;
                }
            }
            catch (err) {
                try {
                    await opts.fs.unlink(tmp);
                }
                catch { /* 清理失败不影响主流程 */ }
                throw err;
            }
        }
        finally {
            // C1：无论成败必失效——失败后旧缓存与磁盘状态可能不一致，绝不复用
            invalidateCache();
        }
        // C1：成功后才刷新缓存（按重命名后的新文件 stat），下一次读取直接命中
        const st = await opts.fs.stat(opts.dataFile);
        itemsCache = { mtimeMs: st.mtimeMs, size: st.size, items: items.slice() };
        readState = { stamp: { mtimeMs: st.mtimeMs, size: st.size } };
    }
    return { readItems, writeItems, invalidateCache, getDropped: () => dropped };
}
//# sourceMappingURL=store.js.map