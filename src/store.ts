import type { MemoryItem } from './types.js'

/** 可注入的文件系统依赖：测试可替换为故障注入桩 */
export interface StoreFsStat {
  mtimeMs: number
  size: number
}

export interface StoreFileHandle {
  writeFile(body: string, encoding: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface StoreFs {
  stat(path: string): Promise<StoreFsStat>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>
  open(path: string, flags: string): Promise<StoreFileHandle>
  rename(from: string, to: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
}

export interface StoreOptions {
  fs: StoreFs
  dataDir: string
  dataFile: string
  defaultScope: string
  /** 行级规范化缺失 id 时使用（M1 起启用） */
  makeId?: () => string
  /** 行级规范化缺失时间戳时使用（M1 起启用） */
  now?: () => string
  /** 启动告警等非致命诊断 */
  onWarn?: (message: string) => void
}

export interface MemoryStore {
  readItems(): Promise<MemoryItem[]>
  writeItems(items: MemoryItem[]): Promise<void>
  invalidateCache(): void
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
export function createStore(opts: StoreOptions): MemoryStore {
  let itemsCache: { mtimeMs: number; size: number; items: MemoryItem[] } | null = null
  let warnedZeroBak = false
  const bakFile = opts.dataFile + '.bak'

  async function readItems(): Promise<MemoryItem[]> {
    let st: StoreFsStat
    try {
      st = await opts.fs.stat(opts.dataFile)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    if (itemsCache && itemsCache.mtimeMs === st.mtimeMs && itemsCache.size === st.size) {
      // C1：返回浅拷贝，杜绝外部就地改写缓存数组（写失败产生"幽灵记忆"的根因之一）
      return itemsCache.items.slice()
    }
    // B2 启动检查：主文件 0 字节而 .bak 非空 = 上一次写入被中断截断过 → 告警
    if (!warnedZeroBak && st.size === 0 && opts.onWarn) {
      warnedZeroBak = true
      try {
        const bak = await opts.fs.stat(bakFile)
        if (bak.size > 0) {
          opts.onWarn('memory.jsonl 为 0 字节而 ' + bakFile + ' 非空：上一次写入可能被中断。可从 .bak 恢复或删除主文件后重建。')
        }
      } catch { /* 无 .bak 视为正常空库 */ }
    }
    let text: string
    try {
      text = await opts.fs.readFile(opts.dataFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const items: MemoryItem[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as MemoryItem
        // 兼容历史/手工写入的缺字段记录：tags 缺失会令下游 item.tags.includes/map 抛 TypeError，
        // 进而使整个自动召回被外层 catch 静默吞掉（违背"忽略损坏行防崩溃"目标）。
        if (parsed && typeof parsed.key === 'string') {
          if (!Array.isArray(parsed.tags)) parsed.tags = []
          items.push(parsed)
        }
      } catch {
        // 忽略损坏行，保证插件不因单条坏数据崩溃
      }
    }
    itemsCache = { mtimeMs: st.mtimeMs, size: st.size, items }
    return items.slice()
  }

  function invalidateCache(): void {
    itemsCache = null
  }

  async function writeItems(items: MemoryItem[]): Promise<void> {
    try {
      await opts.fs.mkdir(opts.dataDir, { recursive: true })
      const body = items.map((item) => JSON.stringify(item)).join('\n') + '\n'
      // B2：写前把当前主文件复制为 .bak（保留 1 份上一版完整快照）
      try {
        await opts.fs.copyFile(opts.dataFile, bakFile)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      // B2：tmp + write + fsync + close + rename（同盘 rename 原子替换主文件）
      const tmp = opts.dataFile + '.tmp-' + process.pid + '-' + Date.now().toString(36)
      const fh = await opts.fs.open(tmp, 'w')
      try {
        await fh.writeFile(body, 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await opts.fs.rename(tmp, opts.dataFile)
    } finally {
      // C1：无论成败必失效——失败后旧缓存与磁盘状态可能不一致，绝不复用
      invalidateCache()
    }
    // C1：成功后才刷新缓存（按重命名后的新文件 stat），下一次读取直接命中
    const st = await opts.fs.stat(opts.dataFile)
    itemsCache = { mtimeMs: st.mtimeMs, size: st.size, items: items.slice() }
  }

  return { readItems, writeItems, invalidateCache }
}
