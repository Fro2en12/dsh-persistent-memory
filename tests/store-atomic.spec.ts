import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { StoreConflictError, createStore } from '../src/store'
import type { StoreFs, StoreFsStat, StoreFileHandle } from '../src/store'
import type { MemoryItem } from '../src/types'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// B2：writeItems 原子化（tmp + fsync + rename + .bak + 启动告警）
// C1：缓存副本 + 写失败必失效（幽灵记忆）
//
// ── A 组可信度修复：旧桩让「非原子直写主文件」的坏实现照样全绿 ──────────────
// 旧桩的两个特性把 B2 用例变成了恒真断言：
//  ① open() 只把内容攒在 chunks 里、sync() 才 files.set，且 sync 先判 failNextSync 再落盘
//     → 注入的 ENOSPC 永远发生在「主文件被碰」之前；
//  ② 主文件只能被 rename 整串替换 → 桩里根本不存在「主文件被写半截」这条路径。
// 新桩按真实 fs 语义实现（已实测：open(p,'w') 会立刻把目标文件截断为 0 字节）：
//  · open(p,'w') 立刻截断/创建 p，writeFile 逐步 append —— 直写实现一 open 就丢旧内容；
//  · 可注入短写（只落前 N 字节后 ENOSPC）→ 精确复现「主文件被写半截」；
//  · 可注入 fsync 失败（ENOSPC）与 rename 失败 → 原子实现此时主文件仍是旧内容、tmp 被清理。
// 注入的 match 谓词同时覆盖主文件与 tmp 路径，因此注入与「是否原子」无关，
// 对比的是「旧内容还在不在」，而不是「代码长什么样」。

function err(code: string): Error & { code: string } {
  const e = new Error(code) as Error & { code: string }
  e.code = code
  return e
}

/** 注入规则：命中 match 的下一次同类操作按 code 失败（用后即焚） */
interface FaultRule {
  kind: 'shortWrite' | 'sync' | 'rename'
  match: (path: string) => boolean
  bytes?: number
  code?: string
}

const DATAFILE = 'memory.jsonl'
/** 「写入库内容」的路径：原子实现的 tmp 与非原子实现的主文件都命中 */
const isBodyWrite = (p: string) => p === DATAFILE || p.startsWith(DATAFILE + '.tmp-')

/**
 * 内存文件系统桩：语义贴近真实 fs，使 B2/C1 的故障注入可证伪。
 * clock 单调递增；stat 返回 (mtimeMs, size)，与 store 的缓存 stamp 同口径。
 */
function makeStubFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const mtimes = new Map<string, number>(Object.keys(initial).map((p) => [p, 1]))
  let clock = 1
  let reads = 0
  const readCounts = new Map<string, number>()
  const rules: FaultRule[] = []
  const touch = (p: string) => mtimes.set(p, ++clock)
  const contentOf = (p: string) => {
    const c = files.get(p)
    if (c === undefined) throw err('ENOENT')
    return c
  }
  const takeRule = (kind: FaultRule['kind'], path: string): FaultRule | null => {
    const idx = rules.findIndex((r) => r.kind === kind && r.match(path))
    if (idx < 0) return null
    return rules.splice(idx, 1)[0]
  }

  const fs: StoreFs = {
    stat: async (p): Promise<StoreFsStat> => {
      const content = files.get(p)
      if (content === undefined) throw err('ENOENT')
      return { mtimeMs: mtimes.get(p) ?? 1, size: Buffer.byteLength(content, 'utf8') }
    },
    readFile: async (p) => {
      reads += 1
      readCounts.set(p, (readCounts.get(p) ?? 0) + 1)
      return contentOf(p)
    },
    mkdir: async () => {},
    open: async (p, flags): Promise<StoreFileHandle> => {
      // 真实 fs 语义：'wx' = 独占创建（已存在 → EEXIST）；'w'/'wx' 都会立刻截断/创建目标
      if (flags.includes('x') && files.has(p)) throw err('EEXIST')
      files.set(p, '')
      touch(p)
      return {
        writeFile: async (body) => {
          const rule = takeRule('shortWrite', p)
          if (rule) {
            // 短写：只有前 N 字节落到盘上，随后 ENOSPC —— 「主文件被写半截」的真实形态
            const n = rule.bytes ?? 0
            files.set(p, (files.get(p) ?? '') + body.slice(0, n))
            touch(p)
            throw err(rule.code ?? 'ENOSPC')
          }
          files.set(p, (files.get(p) ?? '') + body)
          touch(p)
        },
        sync: async () => {
          const rule = takeRule('sync', p)
          if (rule) throw err(rule.code ?? 'ENOSPC')
        },
        close: async () => {},
      }
    },
    rename: async (from, to) => {
      const rule = takeRule('rename', to)
      if (rule) throw err(rule.code ?? 'ENOSPC')
      files.set(to, contentOf(from))
      touch(to)
      files.delete(from)
      mtimes.delete(from)
    },
    copyFile: async (from, to) => {
      files.set(to, contentOf(from))
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
    has: (p: string) => files.has(p),
    paths: () => [...files.keys()],
    /** 残留文件（tmp/锁泄漏断言用） */
    leftovers: (prefix: string) => [...files.keys()].filter((p) => p.startsWith(prefix)),
    failNextSync: (match: (p: string) => boolean, code = 'ENOSPC') => { rules.push({ kind: 'sync', match, code }) },
    failNextShortWrite: (match: (p: string) => boolean, bytes: number, code = 'ENOSPC') => { rules.push({ kind: 'shortWrite', match, bytes, code }) },
    failNextRename: (match: (p: string) => boolean, code = 'ENOSPC') => { rules.push({ kind: 'rename', match, code }) },
    /**
     * 外部写入（另一个进程 / 手工编辑）。keepStamp = true 时不推进 mtime，
     * 用于模拟「同 mtime 刻度内、同长度的改写」= store 的 stat(mtime,size) stamp 看不见的盲区；
     * 长度必须不变，否则 stamp 变化本身就会让缓存 miss，用例失去判别力。
     */
    /** 某个路径被真正读盘的次数（锁文件的 readFile 也会计入 reads，故按路径分开统计） */
    readsOf: (p: string) => readCounts.get(p) ?? 0,
    poke: (p: string, content: string, keepStamp = false) => {
      if (keepStamp && files.has(p)) {
        const old = files.get(p) as string
        if (Buffer.byteLength(old, 'utf8') !== Buffer.byteLength(content, 'utf8')) {
          throw new Error('poke(keepStamp) 必须等长：否则 stamp 变化会让用例失去判别力')
        }
      }
      files.set(p, content)
      if (!keepStamp) touch(p)
    },
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
/** 与 ORIGINAL_LINE 等长（rule.a → rule.z，其余字段不变）：外部改写必须等长才能保持 stamp */
const FOREIGN_LINE = JSON.stringify(item('rule.z', 'original')) + '\n'

function mkStore(stub: ReturnType<typeof makeStubFs>) {
  return createStore({ fs: stub.fs, dataDir: '.', dataFile: DATAFILE, defaultScope: 'global' })
}

describe('B2 writeItems 原子写', () => {
  it('桩语义自检：直写主文件（open "w"）会立刻丢内容 —— 保证下面两条故障用例可证伪', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const fh = await stub.fs.open(DATAFILE, 'w')     // 非原子实现的第一步
    expect(stub.read(DATAFILE), '桩里 open("w") 没有截断主文件：非原子实现照样能通过 B2 用例').toBe('')
    await fh.writeFile('半截', 'utf8')
    await fh.close()
    expect(stub.read(DATAFILE)).toBe('半截')
  })

  it('ENOSPC 注入（fsync 失败）：dataFile 逐字节等于写入前（不截断、不半截）', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const items = await store.readItems()
    items.push(item('rule.b', 'new'))
    stub.failNextSync(isBodyWrite)
    await expect(store.writeItems(items)).rejects.toThrow(/ENOSPC/)
    expect(stub.read(DATAFILE), '写失败后主文件被截断/改写了（非原子直写会丢旧内容）').toBe(ORIGINAL_LINE)
    expect(stub.leftovers(DATAFILE + '.tmp-'), '失败后 tmp 文件泄漏').toEqual([])
    expect(stub.has(DATAFILE + '.lock'), '失败后写锁泄漏').toBe(false)
    // 失败后同实例重读：必须还是旧内容（缓存已失效、不得复活半截内容）
    expect((await store.readItems()).map((i) => i.key)).toEqual(['rule.a'])
  })

  it('ENOSPC 注入（短写：主文件只落一半）→ 主文件仍是完整旧内容，重启后坏行数为 0', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const items = await store.readItems()
    items.push(item('rule.b', 'new'))
    stub.failNextShortWrite(isBodyWrite, Math.floor(ORIGINAL_LINE.length / 2))
    await expect(store.writeItems(items)).rejects.toThrow(/ENOSPC/)
    expect(stub.read(DATAFILE), '写失败后主文件只剩半截内容').toBe(ORIGINAL_LINE)
    const store2 = mkStore(stub)                       // 模拟重启
    const again = await store2.readItems()
    expect(again.map((i) => i.key)).toEqual(['rule.a'])
    expect(again[0].value).toBe('original')
    expect(store2.getDropped(), '重启后读到了半截行（坏行）').toBe(0)
  })

  it('rename 注入失败（ENOSPC）：主文件保持旧内容、tmp 与锁都被清理', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const items = await store.readItems()
    items.push(item('rule.b', 'new'))
    stub.failNextRename((to) => to === DATAFILE)
    await expect(store.writeItems(items)).rejects.toThrow(/ENOSPC/)
    expect(stub.read(DATAFILE), 'rename 失败却改动了主文件').toBe(ORIGINAL_LINE)
    expect(stub.leftovers(DATAFILE + '.tmp-'), '失败后 tmp 文件泄漏').toEqual([])
    expect(stub.has(DATAFILE + '.lock'), '失败后写锁泄漏').toBe(false)
  })

  it('rename EPERM（Windows 并发替换）→ StoreConflictError，主文件保持旧内容', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const items = await store.readItems()
    items.push(item('rule.b', 'new'))
    stub.failNextRename((to) => to === DATAFILE, 'EPERM')
    await expect(store.writeItems(items)).rejects.toBeInstanceOf(StoreConflictError)
    expect(stub.read(DATAFILE)).toBe(ORIGINAL_LINE)
  })

  it('rename 前抛错（崩溃中断）：重启后库完整', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const items = await store.readItems()
    items.push(item('rule.b', 'new'))
    stub.failNextSync(isBodyWrite)
    await expect(store.writeItems(items)).rejects.toThrow()
    // 模拟重启：同一 fs 新 store 实例
    const store2 = mkStore(stub)
    const again = await store2.readItems()
    expect(again.map((i) => i.key)).toEqual(['rule.a'])
    expect(again[0].value).toBe('original')
  })

  it('成功写入后 .bak 保留上一版完整快照', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const items = await store.readItems()
    items.push(item('rule.b', 'second'))
    await store.writeItems(items)
    expect(stub.read(DATAFILE + '.bak')).toBe(ORIGINAL_LINE)
    expect(stub.leftovers(DATAFILE + '.tmp-'), '成功写入后 tmp 未清理').toEqual([])
    expect(stub.has(DATAFILE + '.lock'), '成功写入后锁未释放').toBe(false)
    const v2 = await store.readItems()
    expect(v2).toHaveLength(2)
  })

  it('启动时主文件 0 字节 + .bak 非空 → 告警', async () => {
    const stub = makeStubFs({ [DATAFILE]: '', [DATAFILE + '.bak']: ORIGINAL_LINE })
    const warns: string[] = []
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: DATAFILE, defaultScope: 'global', onWarn: (m) => warns.push(m) })
    await store.readItems()
    expect(warns.some((w) => w.includes('0 字节'))).toBe(true)
  })

  it('正常空库（无文件）不告警', async () => {
    const stub = makeStubFs()
    const warns: string[] = []
    const store = createStore({ fs: stub.fs, dataDir: '.', dataFile: DATAFILE, defaultScope: 'global', onWarn: (m) => warns.push(m) })
    await store.readItems()
    expect(warns).toHaveLength(0)
  })
})

describe('C1 缓存副本 + 写失败必失效', () => {
  it('readItems 返回副本：外部就地改写不影响后续读取', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const a = await store.readItems()
    a.push(item('ghost', 'never persisted'))   // 就地改写返回数组
    const b = await store.readItems()
    expect(b.map((i) => i.key)).toEqual(['rule.a'])
  })

  it('写失败后缓存必失效：即使磁盘 stamp 未变也必须重新读盘（reads 计数）', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    await store.readItems()
    expect(stub.readsOf(DATAFILE)).toBe(1)
    const items = await store.readItems()   // 缓存命中，不读盘
    expect(stub.readsOf(DATAFILE)).toBe(1)
    items.push(item('rule.b', 'ghost'))
    stub.failNextSync(isBodyWrite)
    await expect(store.writeItems(items)).rejects.toThrow(/ENOSPC/)
    expect(stub.read(DATAFILE), '失败路径碰过主文件：本用例前提被破坏').toBe(ORIGINAL_LINE)
    expect((await store.readItems()).map((i) => i.key)).toEqual(['rule.a'])
    expect(stub.readsOf(DATAFILE), '写失败后仍命中旧缓存：没有重新读盘').toBe(2)
  })

  it('写失败 + 同 stamp 的外部改写：不得把缓存里的旧内容当成磁盘内容（幽灵记忆）', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    expect((await store.readItems()).map((i) => i.key)).toEqual(['rule.a'])
    const items = await store.readItems()
    items.push(item('rule.b', 'ghost'))
    stub.failNextSync(isBodyWrite)
    await expect(store.writeItems(items)).rejects.toThrow(/ENOSPC/)
    // 另一个进程用「等长内容 + 不推进 mtime」替换主文件：stat(mtime,size) 与缓存完全一致
    const stampBefore = await stub.fs.stat(DATAFILE)
    stub.poke(DATAFILE, FOREIGN_LINE, true)
    expect(await stub.fs.stat(DATAFILE), 'stamp 变了：本用例失去判别力（缓存本来就会 miss）').toEqual(stampBefore)
    const again = await store.readItems()
    expect(again.map((i) => i.key), '写失败后仍返回缓存旧内容：看不见磁盘上的 rule.z').toEqual(['rule.z'])
  })

  it('写成功后缓存刷新为最新快照（下次命中不读盘且内容为新）', async () => {
    const stub = makeStubFs({ [DATAFILE]: ORIGINAL_LINE })
    const store = mkStore(stub)
    const items = await store.readItems()
    items.push(item('rule.b', 'second'))
    await store.writeItems(items)
    const before = stub.readsOf(DATAFILE)
    const again = await store.readItems()   // 缓存命中
    expect(stub.readsOf(DATAFILE)).toBe(before)
    expect(again.map((i) => i.key)).toEqual(['rule.a', 'rule.b'])
  })
})

// ── 工具级幽灵记忆（C1 报告验收口径：注入写失败 → 重新读盘 → 不得复活旧缓存）──
// 旧用例把 dataDir 换成同名普通文件：stat 与 open(lock,"wx") 都会提前 ENOENT 返回，
// 写失败发生在「锁都没拿到」的阶段 → 删掉 invalidateCache 照样通过（恒真）。
// 新用例改用真实 fs 的可用注入点：把 memory.jsonl.bak 变成目录 → copyFile EPERM →
// 失败发生在 writeItemsLocked 内部（主文件全程未被碰）→ 缓存是否失效成为唯一变量。
const tmpDirs: string[] = []
function setupIntegration() {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false })
  return { fake, dir }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

describe('C1 工具级：写失败后必须重新读盘（真实 fs，不需要给 index.ts 注入适配器）', () => {
  it('写失败 + 同 stamp 的外部改写：memory_get 必须看见新内容、不再返回旧缓存', async () => {
    const { fake, dir } = setupIntegration()
    const file = join(dir, 'memory.jsonl')
    const setTool = fake.toolDefs.get('memory_set')
    const getTool = fake.toolDefs.get('memory_get')
    const exec = { agent: { session: { id: 's1', header: {} }, options: {} } }
    await setTool.execute({ key: 'rule.a', value: 'original' }, exec)
    // mtime 归整到整毫秒：utimes 只能写整毫秒（Date 精度），归整后下面才能精确还原 stamp
    const t0 = (await fsp.stat(file)).mtimeMs
    await fsp.utimes(file, new Date(Math.trunc(t0)), new Date(Math.trunc(t0)))
    const stamp = await fsp.stat(file)
    // 在「归整后的 stamp」上建立缓存
    expect((await getTool.execute({ key: 'rule.a' })).found, '前置条件：rule.a 应已落盘').toBe(true)

    // 故障注入（真实 fs）：memory.jsonl.bak 变成目录 → copyFile EPERM → 写入失败
    const bak = file + '.bak'
    await fsp.rm(bak, { recursive: true, force: true })
    await fsp.mkdir(bak)
    await expect(setTool.execute({ key: 'rule.b', value: 'v2' }, exec), '写失败注入未生效').rejects.toThrow()
    const raw = await fsp.readFile(file, 'utf8')
    expect(raw, '失败路径改动了主文件：本用例前提被破坏').toContain('"rule.a"')

    // 外部同长度改写（rule.a → rule.z）并精确还原 mtime：stat stamp 与内存缓存完全一致
    const foreign = raw.replace('"rule.a"', '"rule.z"')
    expect(Buffer.byteLength(foreign), '外部改写不等长：stamp 会变，用例失去判别力').toBe(Buffer.byteLength(raw))
    await fsp.writeFile(file, foreign, 'utf8')
    await fsp.utimes(file, new Date(Math.trunc(stamp.mtimeMs)), new Date(Math.trunc(stamp.mtimeMs)))
    const after = await fsp.stat(file)
    expect(after.mtimeMs, 'mtime 未精确还原：用例失去判别力').toBe(stamp.mtimeMs)
    expect(after.size, 'size 未保持：用例失去判别力').toBe(stamp.size)
    expect(await fsp.readFile(file, 'utf8')).not.toBe(raw)

    // 唯一通过条件：写失败后缓存已失效 → 重新读盘 → 看见 rule.z、看不见 rule.a
    const spy = vi.spyOn(fsp, 'readFile')
    const readsBefore = spy.mock.calls.filter((c) => c[0] === file).length
    expect((await getTool.execute({ key: 'rule.z' })).found, '写失败后仍用旧缓存：磁盘上的 rule.z 看不见（幽灵记忆）').toBe(true)
    const readsAfter = spy.mock.calls.filter((c) => c[0] === file).length
    expect(readsAfter, '写失败后没有重新读盘：缓存未失效').toBeGreaterThan(readsBefore)
    expect((await getTool.execute({ key: 'rule.a' })).found, '写失败后仍用旧缓存：返回了磁盘上已不存在的 rule.a').toBe(false)
    await fsp.rm(bak, { recursive: true, force: true })
  })

  it('写失败的 key 不得变成幽灵记忆（memory_get 返回 found:false）', async () => {
    const { fake, dir } = setupIntegration()
    const file = join(dir, 'memory.jsonl')
    const setTool = fake.toolDefs.get('memory_set')
    const getTool = fake.toolDefs.get('memory_get')
    const exec = { agent: { session: { id: 's1', header: {} }, options: {} } }
    await setTool.execute({ key: 'rule.a', value: 'v' }, exec)
    const bak = file + '.bak'
    await fsp.rm(bak, { recursive: true, force: true })
    await fsp.mkdir(bak)
    await expect(setTool.execute({ key: 'rule.b', value: 'v2' }, exec)).rejects.toThrow()
    expect((await getTool.execute({ key: 'rule.b' })).found, '写失败的条目出现在读取结果里（幽灵记忆）').toBe(false)
    expect((await getTool.execute({ key: 'rule.a' })).found).toBe(true)
    await fsp.rm(bak, { recursive: true, force: true })
  })
})
