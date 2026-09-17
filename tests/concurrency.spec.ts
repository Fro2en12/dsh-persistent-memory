import { afterEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createStore, withConflictRetry } from '../src/store'
import type { StoreFs } from '../src/store'
import type { MemoryItem as Item } from '../src/types'
import { cleanTempDir, makeTempDir } from './helpers'

// B3：跨进程并发——乐观并发（size/mtime 版本校验）让后写者报冲突而不是静默覆盖；
// withConflictRetry 重读重试后两个 worker 各写 50 条应得 100 条。

const tmpDirs: string[] = []
function mkdirs() {
  const dir = makeTempDir('dspm-conc')
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

const realFs: StoreFs = {
  stat: (p) => fsp.stat(p),
  readFile: (p) => fsp.readFile(p, 'utf8'),
  mkdir: (p, o) => fsp.mkdir(p, o),
  open: (p, f) => fsp.open(p, f).then((fh) => fh as unknown as never),
  rename: (a, b) => fsp.rename(a, b),
  copyFile: (a, b) => fsp.copyFile(a, b),
  unlink: (p) => fsp.unlink(p),
}

function mkStore(fs: StoreFs, dir: string, file: string) {
  return createStore({ fs, dataDir: dir, dataFile: file, defaultScope: 'global', makeId: () => 'id-' + Math.random().toString(36).slice(2, 10), now: () => new Date().toISOString() })
}

function item(key: string): Item {
  return { id: 'id-' + key, key, value: 'v', scope: 'global', tags: [], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' }
}

describe('B3 乐观并发校验', () => {
  it('落后版本写入报冲突（不静默覆盖）', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const storeA = mkStore(realFs, dir, file)
    const storeB = mkStore(realFs, dir, file)
    // 两个「进程」读到同一版本
    const a = await storeA.readItems()
    const b = await storeB.readItems()
    a.push(item('rule.from-a'))
    await storeA.writeItems(a)
    b.push(item('rule.from-b'))
    await expect(storeB.writeItems(b)).rejects.toThrow(/其他进程修改|冲突/)
  })

  it('冲突后重试可成功（重读最新版本）', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const storeA = mkStore(realFs, dir, file)
    const storeB = mkStore(realFs, dir, file)
    const a = await storeA.readItems()
    a.push(item('rule.from-a'))
    await storeA.writeItems(a)
    const b = await storeB.readItems()   // 模拟：B 在 A 写之后才读
    b.push(item('rule.from-b'))
    await storeB.writeItems(b)
    const final = await storeA.readItems()
    expect(final.map((i) => i.key).sort()).toEqual(['rule.from-a', 'rule.from-b'])
  })

  it('两个 worker 各写 50 条不同 key → 最终 100 条', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    // 两个独立 store 实例 = 两个进程（各自独立缓存与版本戳）
    const storeA = mkStore(realFs, dir, file)
    const storeB = mkStore(realFs, dir, file)
    const worker = async (store: ReturnType<typeof mkStore>, prefix: string) => {
      for (let i = 0; i < 50; i++) {
        await withConflictRetry(async () => {
          const items = await store.readItems()
          items.push(item(prefix + '.' + i))
          await store.writeItems(items)
        })
      }
    }
    await Promise.all([worker(storeA, 'a'), worker(storeB, 'b')])
    const final = await storeA.readItems()
    expect(final.length).toBe(100)
    expect(new Set(final.map((i) => i.key)).size).toBe(100)
  })
})
