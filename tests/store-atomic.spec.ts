import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { apply } from '../src/index'
import { createStore } from '../src/store'
import type { StoreFs, StoreFsStat, StoreFileHandle } from '../src/store'
import type { MemoryItem } from '../src/types'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// B2：writeItems 原子化（tmp + fsync + rename + .bak + 启动告警）
// C1：缓存副本 + 写失败必失效（幽灵记忆）

function err(code: string): Error & { code: string } {
  const e = new Error(code) as Error & { code: string }
  e.code = code
  return e
}

/** 内存文件系统桩：可注入 ENOSPC，记录读盘次数 */
function makeStubFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const mtimes = new Map<string, number>(Object.keys(initial).map((p) => [p, 1]))
  let clock = 1
  let failNextSync = false
  let reads = 0
  const touch = (p: string) => mtimes.set(p, ++clock)

  const fs: StoreFs = {
    stat: async (p): Promise<StoreFsStat> => {
      const content = files.get(p)
      if (content === undefined) throw err('ENOENT')
      return { mtimeMs: mtimes.get(p) ?? 1, size: Buffer.byteLength(content, 'utf8') }
    },
    readFile: async (p) => {
      reads += 1
      const content = files.get(p)
      if (content === undefined) throw err('ENOENT')
      return content
    },
    mkdir: async () => {},
    open: async (p): Promise<StoreFileHandle> => {
      const chunks: string[] = []
      return {
        writeFile: async (body) => { chunks.push(body) },
        sync: async () => {
          if (failNextSync) { failNextSync = false; throw err('ENOSPC') }
          files.set(p, chunks.join(''))
          touch(p)
        },
        close: async () => {},
      }
    },
    rename: async (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw err('ENOENT')
      files.set(to, content)
      touch(to)
      files.delete(from)
    },
    copyFile: async (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw err('ENOENT')
      files.set(to, content)
      touch(to)
    },
    unlink: async (p) => {
      if (!files.has(p)) throw err('ENOENT')
      files.delete(p)
      mtimes.delete(p)
    },
  }
  return {
    fs,
    read: (p: string) => files.get(p),
    failNextSync: () => { failNextSync = true },
    get reads() { return reads },
  }
}

function item(key: string, value = 'v'): MemoryItem {
  return {
    id: 'id-' + key, key, value, scope: 'global', tags: [],
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  }
}

const ORIGINAL_LINE = JSON.stringify(item('rule.a', 'original')) + '\n'

describe('B2 writeItems 原子写', () => {
  it('ENOSPC 注入：dataFile 逐字节等于写入前（不截断、不半截）', async () => {
    const stub = makeStubFs({ 'memory.jsonl': ORIGINAL_LINE })
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global' })
    const items = await store.readItems()
    items.push(item('rule.b', 'new'))
    stub.failNextSync()
    await expect(store.writeItems(items)).rejects.toThrow(/ENOSPC/)
    expect(stub.read('memory.jsonl')).toBe(ORIGINAL_LINE)
  })

  it('rename 前抛错（崩溃中断）：重启后库完整', async () => {
    const stub = makeStubFs({ 'memory.jsonl': ORIGINAL_LINE })
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global' })
    const items = await store.readItems()
    items.push(item('rule.b', 'new'))
    stub.failNextSync()
    await expect(store.writeItems(items)).rejects.toThrow()
    // 模拟重启：同一 fs 新 store 实例
    const store2 = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global' })
    const again = await store2.readItems()
    expect(again.map((i) => i.key)).toEqual(['rule.a'])
    expect(again[0].value).toBe('original')
  })

  it('成功写入后 .bak 保留上一版完整快照', async () => {
    const stub = makeStubFs({ 'memory.jsonl': ORIGINAL_LINE })
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global' })
    const items = await store.readItems()
    items.push(item('rule.b', 'second'))
    await store.writeItems(items)
    expect(stub.read('memory.jsonl.bak')).toBe(ORIGINAL_LINE)
    const v2 = await store.readItems()
    expect(v2).toHaveLength(2)
  })

  it('启动时主文件 0 字节 + .bak 非空 → 告警', async () => {
    const stub = makeStubFs({ 'memory.jsonl': '', 'memory.jsonl.bak': ORIGINAL_LINE })
    const warns: string[] = []
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global', onWarn: (m) => warns.push(m) })
    await store.readItems()
    expect(warns.some((w) => w.includes('0 字节'))).toBe(true)
  })

  it('正常空库（无文件）不告警', async () => {
    const stub = makeStubFs()
    const warns: string[] = []
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global', onWarn: (m) => warns.push(m) })
    await store.readItems()
    expect(warns).toHaveLength(0)
  })
})

describe('C1 缓存副本 + 写失败必失效', () => {
  it('readItems 返回副本：外部就地改写不影响后续读取', async () => {
    const stub = makeStubFs({ 'memory.jsonl': ORIGINAL_LINE })
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global' })
    const a = await store.readItems()
    a.push(item('ghost', 'never persisted'))   // 就地改写返回数组
    const b = await store.readItems()
    expect(b.map((i) => i.key)).toEqual(['rule.a'])
  })

  it('写失败后缓存必失效：第二次 readItems 重新读盘', async () => {
    const stub = makeStubFs({ 'memory.jsonl': ORIGINAL_LINE })
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global' })
    await store.readItems()
    expect(stub.reads).toBe(1)
    const items = await store.readItems()   // 缓存命中，不读盘
    expect(stub.reads).toBe(1)
    items.push(item('rule.b', 'ghost'))
    stub.failNextSync()
    await expect(store.writeItems(items)).rejects.toThrow()
    const again = await store.readItems()   // 必须重新读盘
    expect(stub.reads).toBe(2)
    expect(again.map((i) => i.key)).toEqual(['rule.a'])
  })

  it('写成功后缓存刷新为最新快照（下次命中不读盘且内容为新）', async () => {
    const stub = makeStubFs({ 'memory.jsonl': ORIGINAL_LINE })
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global' })
    const items = await store.readItems()
    items.push(item('rule.b', 'second'))
    await store.writeItems(items)
    const before = stub.reads
    const again = await store.readItems()   // 缓存命中
    expect(stub.reads).toBe(before)
    expect(again.map((i) => i.key)).toEqual(['rule.a', 'rule.b'])
  })
})

// ── 工具级幽灵记忆（C1 报告验收口径：注入写失败 → memory_get 返回 found:false）──
const tmpDirs: string[] = []
function setupIntegration() {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false })
  return { fake, dir }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

describe('C1 工具级：写失败不产生幽灵记忆', () => {
  it('写失败后 memory_get 返回 found:false（当前实现会返回 true）', async () => {
    const { fake, dir } = setupIntegration()
    const setTool = fake.toolDefs.get('memory_set')
    const getTool = fake.toolDefs.get('memory_get')
    const exec = { agent: { session: { id: 's1', header: {} }, options: {} } }
    await setTool.execute({ key: 'rule.a', value: 'v' }, exec)
    // 故障注入：把 dataDir 换成同名文件 → mkdir 抛错 → writeItems 失败
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'i am a file now')
    await expect(setTool.execute({ key: 'rule.b', value: 'v2' }, exec)).rejects.toThrow()
    const g = await getTool.execute({ key: 'rule.b' })
    expect(g.found).toBe(false)
  })
})
