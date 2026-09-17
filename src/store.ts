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
  writeFile(path: string, body: string, encoding: 'utf8'): Promise<void>
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
  /** 启动告警等非致命诊断（B2 起启用） */
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
 */
export function createStore(opts: StoreOptions): MemoryStore {
  let itemsCache: { mtimeMs: number; size: number; items: MemoryItem[] } | null = null

  async function readItems(): Promise<MemoryItem[]> {
    let st: StoreFsStat
    try {
      st = await opts.fs.stat(opts.dataFile)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    if (itemsCache && itemsCache.mtimeMs === st.mtimeMs && itemsCache.size === st.size) {
      return itemsCache.items
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
    return items
  }

  function invalidateCache(): void {
    itemsCache = null
  }

  async function writeItems(items: MemoryItem[]): Promise<void> {
    await opts.fs.mkdir(opts.dataDir, { recursive: true })
    const body = items.map((item) => JSON.stringify(item)).join('\n') + '\n'
    await opts.fs.writeFile(opts.dataFile, body, 'utf8')
    invalidateCache()
  }

  return { readItems, writeItems, invalidateCache }
}
