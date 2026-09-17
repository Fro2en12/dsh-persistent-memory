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
    //
    // S6/S9 等价性加固：锁内容 = { pid, token, ts }，把「删除锁」收敛为可证明的所有权操作。
    //  ① 释放：先读锁文件比对 token，只有持有者才 unlink
    //     （修复：A 的锁被判陈旧抢走后，A 的 release 会删掉抢锁者的新锁）；
    //  ② 陈旧清除：在 lockFile.reap 临界区内做「二次校验（mtime 仍超阈值 + token 未变）」后才 unlink
    //     （修复：旧实现 stat→无条件 unlink 无 CAS，B 会删掉 C 抢先建立的新锁）；
    //  ③ 心跳 + rename 前刷新 mtime：长写（大库序列化/慢盘/挂起唤醒）不再被判陈旧而抢锁。
    const LOCK_STALE_MS = 10_000;
    const LOCK_WAIT_MS = 10_000;
    /** 心跳周期：必须远小于陈旧阈值，保证活着的持锁者永远不会看起来陈旧 */
    const LOCK_HEARTBEAT_MS = Math.max(250, Math.floor(LOCK_STALE_MS / 4));
    /** 清除陈旧锁的临界区（reap）文件泄漏多久后可被清理；临界区本身只有几个 syscall */
    const LOCK_REAPER_STALE_MS = 5_000;
    const lockFile = opts.dataFile + '.lock';
    const reapFile = lockFile + '.reap';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    function makeToken() {
        // 每次获取锁都用新 token：同一进程的多次写入/pid 复用也不会互相误认
        return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    }
    function lockBody(token) {
        return JSON.stringify({ pid: process.pid, token, ts: Date.now() });
    }
    /** 解析锁持有者 token；非本格式（旧版裸 pid、被截断、非 JSON）一律返回 null = 「不是我的锁」 */
    function parseToken(raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') {
                return parsed.token;
            }
        }
        catch { /* 非 JSON */ }
        return null;
    }
    async function readFileOrNull(path) {
        try {
            return await opts.fs.readFile(path, 'utf8');
        }
        catch {
            return null;
        }
    }
    /**
     * 删除「确实是自己的」锁文件（S6 修复点）。
     * 修复前是无条件 unlink：A 的锁被判陈旧、被 B 清除并抢走后，A 的 release 仍会删掉 B 刚
     * 建立的新锁 → C 又能 open('wx') 拿到锁 → 两个写者并存 → 丢更新。
     * 现在 token 不匹配就什么都不做：别人的锁只能由它自己（或陈旧清除逻辑）处置。
     */
    async function releaseFile(file, token) {
        for (let i = 0; i < 3; i++) {
            try {
                await opts.fs.stat(file);
            }
            catch {
                return; // 文件已不在（已释放/被别人清掉）
            }
            const raw = await readFileOrNull(file);
            if (raw === null)
                return; // 读不到内容：保守不动
            if (parseToken(raw) !== token)
                return; // 锁已易主：绝不删别人的锁
            try {
                await opts.fs.unlink(file);
                return;
            }
            catch {
                await sleep(10);
            }
        }
    }
    /**
     * c) 刷新锁文件 mtime（心跳）。
     * 返回 'held' = 确认仍持有；'foreign' = 锁已被别人接管；'absent' = 锁文件不在（或读不到）。
     * 刷新前比对 token：锁易主后绝不「复活」或改写别人的锁（否则等于伪造持有权）。
     * StoreFs.utimes 缺失时降级为重写同样内容（内容/token 不变，仅 mtime 前进）。
     */
    async function refreshLock(token) {
        try {
            await opts.fs.stat(lockFile);
        }
        catch {
            return 'absent';
        }
        const raw = await readFileOrNull(lockFile);
        if (raw === null)
            return 'absent';
        if (parseToken(raw) !== token)
            return 'foreign';
        if (opts.fs.utimes) {
            await opts.fs.utimes(lockFile, Date.now());
        }
        else {
            const fh = await opts.fs.open(lockFile, 'w');
            try {
                await fh.writeFile(lockBody(token), 'utf8');
            }
            finally {
                await fh.close();
            }
        }
        return 'held';
    }
    /**
     * b) 陈旧锁清除（CAS 近似）。返回 true = 锁文件已消失，应立即重试 open('wx')。
     *
     * 旧的「stat → 无条件 unlink」没有 CAS：B 判陈旧后、unlink 生效前，C 可能已清掉旧锁并
     * 原子新建了自己的锁，B 的 unlink 就把 C 的新锁删了（S9）。这里把清除收敛成临界区：
     *  · 只有拿到 reap 文件（open 'wx' 独占）的进程才允许动 lockFile —— 同一时刻只有一个清除者；
     *  · unlink 前二次校验：mtime 仍超阈值 且 token 与判陈旧时读到的一致；任一项变化即放弃本轮；
     *  · lockFile 存在期间没有进程能 open('wx') 成功，因此临界区内的 unlink 不可能删到新锁。
     *
     * ── T9 残留窗口（已知且未关闭，故保留本方案而不是改 rename-claim）──────────────
     * 二次校验把「删到新锁」压到亚毫秒窗口，但没有消灭它。触发条件（两个必须同时成立）：
     *  ① 持锁者停摆 > LOCK_STALE_MS(10s)：心跳周期 LOCK_HEARTBEAT_MS(2.5s)，正常写入/慢盘都不可能
     *     停摆这么久；真实成因是进程被整体挂起（笔记本休眠、VM pause、断点调试、整机内存冻结），
     *     或刷新路径自身卡死 >10s（此时它也刷不动 mtime，锁确实已经不可用了）；
     *  ② 该持锁者恰好在清除者的「第二次 stat 之后、unlink 之前」恢复心跳并成功刷新 mtime。
     * 命中窗口：第二次 stat 与 unlink 之间只有 1 次 readFile（token 复核）+ 1 次 unlink，约 10^2 µs；
     * 相对 2.5s 的心跳周期，单次恢复命中概率量级 ~10^-4，再乘上「停摆 >10s」本身的罕见性，
     * 因此测试里从未自然复现（回归用例用注入的方式把刷新精确塞进该窗口，验证二次校验能救回）。
     * 命中后果：清除者删掉活锁 → 持锁者继续 rename，而等待者 open('wx') 拿到新锁 → 双持有。
     * 未关闭的原因：本方案没有原子的「比对并删除」，只有把锁改成 rename-claim（谁把 lockFile
     * rename 成自己的唯一名字谁就赢）才能彻底消除该窗口；第四轮论证认为该窗口需要两个独立
     * 罕见条件同时成立，风险量级低于 rename-claim 引入的新复杂度（多一类待清理的 claim 文件、
     * 崩溃后的回收语义更绕），故保留现状并在此备案（回归用例见 tests/concurrency.spec.ts 的 T9 用例）。
     */
    async function clearStaleLock() {
        let observed;
        try {
            observed = await opts.fs.stat(lockFile);
        }
        catch {
            return true; // 锁已消失 → 立即重试
        }
        if (Date.now() - observed.mtimeMs <= LOCK_STALE_MS)
            return false; // 锁新鲜：等
        const observedToken = parseToken((await readFileOrNull(lockFile)) ?? '');
        const reapToken = makeToken();
        try {
            const fh = await opts.fs.open(reapFile, 'wx');
            try {
                await fh.writeFile(lockBody(reapToken), 'utf8');
            }
            finally {
                await fh.close();
            }
        }
        catch (err) {
            const code = err.code;
            if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
                throw err;
            await clearStaleReaper(); // 别人正在清除（或 reap 文件泄漏）
            return false;
        }
        try {
            let again;
            try {
                again = await opts.fs.stat(lockFile);
            }
            catch {
                return true; // 别人已经清掉了
            }
            if (Date.now() - again.mtimeMs <= LOCK_STALE_MS)
                return false; // 已刷新/已被新建
            if (parseToken((await readFileOrNull(lockFile)) ?? '') !== observedToken)
                return false;
            try {
                await opts.fs.unlink(lockFile);
            }
            catch { /* 竞态下别人已清 */ }
            return true;
        }
        finally {
            await releaseFile(reapFile, reapToken);
        }
    }
    /** reap 文件泄漏（清除者崩溃）：超过阈值后清理，否则陈旧锁将永远无人可清 */
    async function clearStaleReaper() {
        try {
            const st = await opts.fs.stat(reapFile);
            if (Date.now() - st.mtimeMs <= LOCK_REAPER_STALE_MS)
                return;
            const before = await readFileOrNull(reapFile);
            const now = await opts.fs.stat(reapFile);
            if (Date.now() - now.mtimeMs <= LOCK_REAPER_STALE_MS)
                return; // 刚被别人重建
            const cur = await readFileOrNull(reapFile);
            if (cur === null || cur !== before)
                return;
            await opts.fs.unlink(reapFile);
        }
        catch { /* 已消失或不可读：忽略 */ }
    }
    async function acquireWriteLock() {
        const deadline = Date.now() + LOCK_WAIT_MS;
        const token = makeToken();
        for (;;) {
            try {
                const fh = await opts.fs.open(lockFile, 'wx'); // 唯一的所有权来源：原子独占创建
                try {
                    await fh.writeFile(lockBody(token), 'utf8');
                }
                finally {
                    await fh.close();
                }
                return {
                    release: () => releaseFile(lockFile, token),
                    refresh: async () => {
                        try {
                            return await refreshLock(token);
                        }
                        catch {
                            return 'absent'; // 刷新失败不能打断写入主流程
                        }
                    },
                };
            }
            catch (err) {
                const code = err.code;
                // EEXIST = 锁已被持有；Windows 上并发创建/删除同名文件还会报 EPERM/EACCES/EBUSY
                // （共享冲突而非"已存在"），同样按「锁被占用」处理并重试
                if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
                    throw err;
            }
            // 陈旧锁（持有者崩溃）：只在不违反「只有一个清除者 + 清除前二次校验」的前提下清除
            if (await clearStaleLock())
                continue;
            if (Date.now() > deadline) {
                throw new StoreConflictError('无法获取 memory.jsonl 写锁（等待超时），本次写入放弃以避免覆盖');
            }
            await sleep(5 + Math.floor(Math.random() * 15));
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
        // T2 附（第五轮 A 组发现的残留）：拿不到锁时也要失效缓存——语义上「本次没写」，
        // 但此刻另一进程很可能正在写盘；缓存虽由 size/mtime 校验兜底，仍存在「版本戳恰好相同」
        // 的窄盲区，代价一行即可消除。
        let lock;
        try {
            lock = await acquireWriteLock();
        }
        catch (err) {
            invalidateCache();
            throw err;
        }
        // c) 心跳：慢盘/大库/进程被挂起后的恢复期间持续刷新锁 mtime，避免被判陈旧而抢锁
        const beat = setInterval(() => { void lock.refresh(); }, LOCK_HEARTBEAT_MS);
        if (typeof beat.unref === 'function')
            beat.unref();
        try {
            await writeItemsLocked(items, lock.refresh);
        }
        finally {
            clearInterval(beat);
            await lock.release();
        }
    }
    async function writeItemsLocked(items, lockRefresh) {
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
                // c) 耗时阶段（copyFile/.bak + 整库序列化 + tmp 落盘 fsync）之后、rename 之前刷新锁 mtime，
                //    让长写不会被判陈旧而抢锁；同时复核锁仍在自己手里——互斥一旦被破坏，
                //    宁可报并发冲突交给 withConflictRetry 重试，也不静默覆盖别人的写入。
                if ((await lockRefresh()) === 'foreign') {
                    throw new StoreConflictError('memory.jsonl 写锁已被其他进程接管（并发冲突），本次写入放弃以避免覆盖');
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