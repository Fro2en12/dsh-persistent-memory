import { afterEach, describe, expect, it } from 'vitest'
import { promises as fsp, writeFileSync } from 'node:fs'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StoreConflictError, createStore, withConflictRetry } from '../src/store'
import type { StoreFs } from '../src/store'
import type { MemoryItem as Item } from '../src/types'
import { cleanTempDir, makeTempDir } from './helpers'

// B3：跨进程并发——乐观并发（size/mtime 版本校验）让后写者报冲突而不是静默覆盖；
// withConflictRetry 重读重试后两个 worker 各写 50 条应得 100 条。
//
// S6/S9 回归：写锁必须「只有持有者能删自己的锁」。
// 修复前 releaseWriteLock 无条件 unlink、陈旧锁清除是 stat→无条件 unlink，
// 两者都会删掉别人刚建立的锁 → 互斥失效 → 丢更新。

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
  utimes: (p, t) => fsp.utimes(p, new Date(t), new Date(t)),
}

function mkStore(fs: StoreFs, dir: string, file: string) {
  return createStore({ fs, dataDir: dir, dataFile: file, defaultScope: 'global', makeId: () => 'id-' + Math.random().toString(36).slice(2, 10), now: () => new Date().toISOString() })
}

function item(key: string): Item {
  return { id: 'id-' + key, key, value: 'v', scope: 'global', tags: [], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' }
}

const lockPathOf = (file: string) => file + '.lock'

/** 读锁文件内容（JSON）；不存在/不是 JSON 时返回 null */
async function readLock(p: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(p, 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch { return null }
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true } catch { return false }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件在 ' + timeoutMs + 'ms 内未成立')
    await new Promise((r) => setTimeout(r, 2))
  }
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
        // 显式放大重试预算：两个 worker 全程抢锁，机器有负载时默认 5 次可能被调度抖动用尽
        // （断言口径不变：重读重试后 100 条不丢；生产 withConflictRetry 默认值仍是 5）
        await withConflictRetry(async () => {
          const items = await store.readItems()
          items.push(item(prefix + '.' + i))
          await store.writeItems(items)
        }, 50)
      }
    }
    await Promise.all([worker(storeA, 'a'), worker(storeB, 'b')])
    const final = await storeA.readItems()
    expect(final.length).toBe(100)
    expect(new Set(final.map((i) => i.key)).size).toBe(100)
  })
})

describe('B3 写锁等价性（S6/S9 回归）', () => {
  it('S6：锁被抢走后，原持有者的 release 不得删除他人的锁', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const lock = lockPathOf(file)
    // A 的 copyFile 卡在 gate 上：A 已持锁且停在写盘耗时阶段
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const fsA: StoreFs = {
      ...realFs,
      copyFile: async (from, to) => { await gate; await realFs.copyFile(from, to) },
    }
    const storeA = mkStore(fsA, dir, file)
    const items = await storeA.readItems()
    items.push(item('rule.from-a'))
    const pending = storeA.writeItems(items)
    await waitFor(() => exists(lock))
    // 模拟：A 的锁被判陈旧 → 别人清除并建立了自己的锁（别人的 token 在锁文件里）
    await fsp.writeFile(lock, JSON.stringify({ pid: process.pid + 1, token: 'thief-token' }), 'utf8')
    openGate()
    const settled = await pending.then(() => null, (err: unknown) => err)
    const after = await readLock(lock)
    expect(after, 'A 的 release 删掉了抢锁者的锁（S6：release 未校验持有者）').not.toBeNull()
    expect(after!.token).toBe('thief-token')
    // 丢掉锁之后必须放弃写入：转成可重试的并发冲突，而不是与抢锁者同时落盘（丢更新）
    expect(settled, '丢掉锁的写者仍然完成了写入').toBeInstanceOf(StoreConflictError)
  })

  it('S9：陈旧锁清除期间别人清了旧锁并新建 → 清除者不得删掉新锁', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const lock = lockPathOf(file)
    // 种一个陈旧锁（持有者已死：mtime 老于 10s 阈值）
    await fsp.writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead-owner' }), 'utf8')
    const old = (Date.now() - 60_000) / 1000
    await fsp.utimes(lock, old, old)
    const stolenTokens: Array<string | null> = []   // B 每次 unlink 锁文件之前，锁文件里的 token
    let injectionStarted = false
    let injected = false
    const fsB: StoreFs = {
      ...realFs,
      stat: async (p) => {
        const st = await realFs.stat(p)
        if (p === lock && !injectionStarted) {
          injectionStarted = true
          // C：清除陈旧锁 + 原子新建自己的锁；而 B 拿到的是「抢锁之前」的陈旧快照（竞态核心）
          await fsp.rm(lock, { force: true })
          await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'C-new-lock' }), 'utf8')
          injected = true
        }
        return st
      },
      unlink: async (p) => {
        if (p === lock) {
          const cur = await readLock(lock)
          stolenTokens.push(cur ? (cur.token as string | null) : null)
        }
        return realFs.unlink(p)
      },
    }
    const storeB = mkStore(fsB, dir, file)
    const items = await storeB.readItems()
    items.push(item('rule.from-b'))
    const pending = storeB.writeItems(items)
    void pending.catch(() => { /* 断言提前失败时不要变成 unhandled rejection */ })
    // C 在 150ms 后才释放自己的锁（模拟 C 的正常写入耗时）
    setTimeout(() => {
      void (async () => {
        try {
          const cur = await readLock(lock)
          if (cur && cur.token === 'C-new-lock') await fsp.rm(lock, { force: true })
        } catch { /* ignore */ }
      })()
    }, 150)
    await waitFor(async () => injected, 2000)      // 等 B 走到陈旧锁判断并完成注入
    expect(injected, '注入未发生：B 没有走到陈旧锁判断').toBe(true)
    // 采样必须从「C 的锁确实在场」开始，否则测的是注入中途的空窗
    let cSeen = false
    await waitFor(async () => {
      const cur = await readLock(lock)
      if (cur && cur.token === 'C-new-lock') { cSeen = true; return true }
      return false
    }, 2000).catch(() => { /* 旧实现：C 的锁立刻被删，等不到 */ })
    expect(cSeen, 'C 建立的新锁从未被观测到（已被别人删掉）').toBe(true)
    let cSurvivedMs = 0
    const started = Date.now()
    while (Date.now() - started < 400) {
      const cur = await readLock(lock)
      if (!cur || cur.token !== 'C-new-lock') break
      cSurvivedMs = Date.now() - started
      await new Promise((r) => setTimeout(r, 3))
    }
    await pending
    expect(stolenTokens, 'B 删除了抢锁者 C 刚建立的新锁（S9：清除陈旧锁无 CAS）').not.toContain('C-new-lock')
    expect(stolenTokens.length, 'B 应当只删除自己创建的锁').toBe(1)
    expect(cSurvivedMs, 'C 建立的新锁在 C 释放之前就被别人删掉了').toBeGreaterThanOrEqual(100)
    expect(await exists(lock + '.reap'), '清除陈旧锁的临界区文件泄漏了').toBe(false)
  })

  it('S9b：rename 之前刷新锁 mtime（长写不被误判陈旧而抢锁）', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const lock = lockPathOf(file)
    writeFileSync(file, JSON.stringify(item('rule.pre')) + '\n', 'utf8')
    const staleSec = (Date.now() - 60_000) / 1000
    let mtimeAtRename = -1
    const fsX: StoreFs = {
      ...realFs,
      copyFile: async (from, to) => {
        try { await realFs.copyFile(from, to) } catch { /* 首次写入无 .bak 可复制 */ }
        // 持锁期间把锁 mtime 改老：等价于「序列化+落盘耗时超过 10s 陈旧阈值」
        await fsp.utimes(lock, staleSec, staleSec)
      },
      rename: async (from, to) => {
        if (to === file) mtimeAtRename = (await fsp.stat(lock)).mtimeMs
        return realFs.rename(from, to)
      },
    }
    const store = mkStore(fsX, dir, file)
    const items = await store.readItems()
    items.push(item('rule.long'))
    await store.writeItems(items)
    expect(mtimeAtRename, 'rename 前未读到锁文件').toBeGreaterThan(0)
    expect(Date.now() - mtimeAtRename, 'rename 前没有刷新锁 mtime：长写仍会被判陈旧而抢锁').toBeLessThan(5_000)
  })

  it('StoreFs 无 utimes 时降级为重写锁内容刷新 mtime（且 token 不变）——src/index.ts 适配器走的正是这条路径', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const lock = lockPathOf(file)
    writeFileSync(file, JSON.stringify(item('rule.pre')) + '\n', 'utf8')
    const staleSec = (Date.now() - 60_000) / 1000
    let tokenBeforeRefresh: string | null = null
    let tokenAtRename: string | null = null
    let mtimeAtRename = -1
    const fsNoUtimes: StoreFs = {
      stat: realFs.stat,
      readFile: realFs.readFile,
      mkdir: realFs.mkdir,
      open: realFs.open,
      unlink: realFs.unlink,
      copyFile: async (from, to) => {
        try { await realFs.copyFile(from, to) } catch { /* 首次写入无 .bak 可复制 */ }
        tokenBeforeRefresh = ((await readLock(lock))?.token as string | undefined) ?? null
        await fsp.utimes(lock, staleSec, staleSec)     // 把锁 mtime 改老：只有刷新才能救回来
      },
      rename: async (from, to) => {
        if (to === file) {
          tokenAtRename = ((await readLock(lock))?.token as string | undefined) ?? null
          mtimeAtRename = (await fsp.stat(lock)).mtimeMs
        }
        return realFs.rename(from, to)
      },
    }
    const store = mkStore(fsNoUtimes, dir, file)
    const items = await store.readItems()
    items.push(item('rule.no-utimes'))
    await store.writeItems(items)
    expect(mtimeAtRename, 'rename 前未读到锁文件').toBeGreaterThan(0)
    expect(Date.now() - mtimeAtRename, '缺 utimes 时未降级刷新锁 mtime').toBeLessThan(5_000)
    expect(tokenBeforeRefresh, '刷新前锁文件里没有 token').not.toBeNull()
    expect(tokenAtRename, '降级刷新把锁内容/token 改掉了：陈旧清除的二次校验会误判').toBe(tokenBeforeRefresh)
    expect(await exists(lock)).toBe(false)
  })

  it('活性：陈旧锁（持有者已死）+ 泄漏的 reap 文件仍能被清除并成功写入（不死锁）', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const lock = lockPathOf(file)
    const old = (Date.now() - 60_000) / 1000
    await fsp.writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead-owner' }), 'utf8')
    await fsp.utimes(lock, old, old)
    // 清除者崩溃留下的 reap 文件：必须能被清理，否则陈旧锁永远无人可清
    await fsp.writeFile(lock + '.reap', JSON.stringify({ pid: 999998, token: 'dead-reaper' }), 'utf8')
    await fsp.utimes(lock + '.reap', old, old)
    const store = mkStore(realFs, dir, file)
    const items = await store.readItems()
    items.push(item('rule.recover'))
    await store.writeItems(items)
    expect((await store.readItems()).map((i) => i.key)).toEqual(['rule.recover'])
    expect(await exists(lock), '锁未释放').toBe(false)
    expect(await exists(lock + '.reap'), 'reap 文件未清理').toBe(false)
  })

  it('持锁期间锁文件确实存在，内容为 pid + 随机 token；写完即释放', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const lock = lockPathOf(file)
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let raw: string | null = null
    const fsD: StoreFs = {
      ...realFs,
      copyFile: async (from, to) => {
        // 此处已进入 writeItemsLocked 的耗时阶段 = 本进程持有写锁
        raw = await fsp.readFile(lock, 'utf8').catch(() => null)
        await gate
        try { await realFs.copyFile(from, to) } catch { /* 首次写入无 .bak */ }
      },
    }
    const store = mkStore(fsD, dir, file)
    const items = await store.readItems()
    items.push(item('rule.lock'))
    const pending = store.writeItems(items)
    void pending.catch(() => { /* 同上 */ })
    await waitFor(async () => raw !== null)
    const seen = JSON.parse(raw as string) as Record<string, unknown>
    openGate()
    await pending
    expect(typeof seen === 'object' && seen !== null, '锁内容不是 pid+token 结构（旧实现写裸 pid）').toBe(true)
    expect(seen.pid).toBe(process.pid)
    expect(String(seen.token ?? ''), '锁内容缺随机 token：无法校验持有者身份').toMatch(/^[0-9a-z]{8,}$/i)
    expect(await exists(lock), '写完未释放锁').toBe(false)
  })
})

// ── 真实跨进程：fork 两个 node 子进程，各自 import 源码构建的 store（Node 26 类型剥离）──
const CHILD_SOURCE = [
  "import { promises as fsp } from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  "const [srcPath, dataDir, dataFile, prefix, countRaw] = process.argv.slice(2)",
  "const { createStore, withConflictRetry } = await import(pathToFileURL(srcPath).href)",
  "const fs = {",
  "  stat: (p) => fsp.stat(p),",
  "  readFile: (p) => fsp.readFile(p, 'utf8'),",
  "  mkdir: (p, o) => fsp.mkdir(p, o),",
  "  open: (p, f) => fsp.open(p, f),",
  "  rename: (a, b) => fsp.rename(a, b),",
  "  copyFile: (a, b) => fsp.copyFile(a, b),",
  "  unlink: (p) => fsp.unlink(p),",
  "  utimes: (p, t) => fsp.utimes(p, new Date(t), new Date(t)),",
  "}",
  "const store = createStore({ fs, dataDir, dataFile, defaultScope: 'global' })",
  "const count = Number(countRaw)",
  "const iso = '2026-09-17T00:00:00.000Z'",
  "let lockSeen = 0",
  "const parsePid = (raw) => { try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v.pid : v } catch { return null } }",
  "const sampler = setInterval(() => {",
  "  void fsp.readFile(dataFile + '.lock', 'utf8').then((raw) => { const pid = parsePid(raw); if (pid !== null && pid !== process.pid) lockSeen += 1 }, () => {})",
  "}, 2)",
  "for (let i = 0; i < count; i++) {",
  "  await withConflictRetry(async () => {",
  "    const items = await store.readItems()",
  "    items.push({ id: prefix + '-id-' + i, key: prefix + '.' + i, value: 'v' + i, scope: 'global', tags: [], createdAt: iso, updatedAt: iso })",
  "    await store.writeItems(items)",
  "  }, 40)",
  "}",
  "clearInterval(sampler)",
  "process.stdout.write(JSON.stringify({ pid: process.pid, lockSeen }))",
].join('\n')

function runChild(childPath: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = fork(childPath, args, { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('B3 真实跨进程互斥', () => {
  it('两个子进程各写 50 条不同 key → 最终 100 条、无丢更新', async () => {
    const dir = mkdirs()
    const file = join(dir, 'memory.jsonl')
    const childPath = join(dir, 'fork-writer.mjs')
    writeFileSync(childPath, CHILD_SOURCE, 'utf8')
    const srcPath = fileURLToPath(new URL('../src/store.ts', import.meta.url))
    const [a, b] = await Promise.all([
      runChild(childPath, [srcPath, dir, file, 'a', '50']),
      runChild(childPath, [srcPath, dir, file, 'b', '50']),
    ])
    expect(a.code, '子进程 A 失败：' + a.stderr).toBe(0)
    expect(b.code, '子进程 B 失败：' + b.stderr).toBe(0)
    const final = await mkStore(realFs, dir, file).readItems()
    expect(final).toHaveLength(100)
    expect(new Set(final.map((i) => i.key)).size).toBe(100)
    const seen = [a, b]
      .map((r) => Number((JSON.parse(r.stdout || '{}') as { lockSeen?: number }).lockSeen ?? 0))
      .reduce((x, y) => x + y, 0)
    expect(seen, '两个子进程从未观察到对方持锁：它们没有在同一把锁上竞争').toBeGreaterThan(0)
  }, 30_000)
})
