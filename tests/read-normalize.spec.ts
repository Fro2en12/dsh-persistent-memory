import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { createStore } from '../src/store'
import type { StoreFs, StoreFsStat, StoreFileHandle } from '../src/store'
import type { MemoryItem } from '../src/types'
import { cleanTempDir, findPluginMessages, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// M1：readItems 行级规范化——一条坏行只丢一条并计数，不再让整条召回链静默失效；
// dropped 计入 memory_stats；pre-step 注入链被打断时降级为仅注入守则。

function err(code: string): Error & { code: string } {
  const e = new Error(code) as Error & { code: string }
  e.code = code
  return e
}

/** 简易内存 fs：本组用例只测读侧规范化 */
function makeStubFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const fs: StoreFs = {
    stat: async (p): Promise<StoreFsStat> => {
      const c = files.get(p)
      if (c === undefined) throw err('ENOENT')
      return { mtimeMs: 1, size: Buffer.byteLength(c, 'utf8') }
    },
    readFile: async (p) => {
      const c = files.get(p)
      if (c === undefined) throw err('ENOENT')
      return c
    },
    mkdir: async () => {},
    open: async (): Promise<StoreFileHandle> => ({ writeFile: async () => {}, sync: async () => {}, close: async () => {} }),
    rename: async () => {},
    copyFile: async () => {},
  }
  return fs
}

function item(key: string, value = 'v'): MemoryItem {
  return {
    id: 'id-' + key, key, value, scope: 'global', tags: [],
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  }
}

const DIRTY_NO_SCOPE = '{"id":"x1","key":"task.probe","value":"v","tags":[],"createdAt":"t","updatedAt":"t"}'
const DIRTY_SCOPE_NUM = '{"id":"x2","key":"task.probe2","value":"v","scope":123,"tags":[]}'
const DIRTY_NO_VALUE = '{"id":"x3","key":"task.probe3","scope":"global","tags":[]}'
const NORMAL = JSON.stringify(item('rule.ok', '正常内容'))

describe('M1 readItems 行级规范化（store 级）', () => {
  it('3 条脏行 + 1 条正常行 → 正常行可检索，dropped===3', async () => {
    const fs = makeStubFs({ 'memory.jsonl': [DIRTY_NO_SCOPE, DIRTY_SCOPE_NUM, DIRTY_NO_VALUE, NORMAL].join('\n') + '\n' })
    const store = createStore({ fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global', makeId: () => 'gen-id', now: () => '2026-09-17T00:00:00.000Z' })
    const items = await store.readItems()
    expect(items.map((i) => i.key)).toEqual(['rule.ok'])
    expect(items[0].value).toBe('正常内容')
    expect(store.getDropped()).toBe(3)
  })

  it('缺 scope 的坏行不再让 scoreItem 崩溃（规范化后 scope 必为 string）', async () => {
    const fs = makeStubFs({ 'memory.jsonl': DIRTY_NO_SCOPE + '\n' + NORMAL })
    const store = createStore({ fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global', makeId: () => 'g', now: () => 't' })
    const items = await store.readItems()
    expect(items).toHaveLength(1)
    expect(typeof items[0].scope).toBe('string')
    expect(store.getDropped()).toBe(1)
  })

  it('空白 scope 补 defaultScope；缺 tags 补空数组；缺 id/时间戳补默认值', async () => {
    const line = '{"key":"rule.x","value":"v","scope":"  "}'
    const fs = makeStubFs({ 'memory.jsonl': line + '\n' })
    const store = createStore({ fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global', makeId: () => 'gen-id', now: () => '2026-09-17T00:00:00.000Z' })
    const items = await store.readItems()
    expect(items).toHaveLength(1)
    expect(items[0].scope).toBe('global')
    expect(items[0].tags).toEqual([])
    expect(items[0].id).toBe('gen-id')
    expect(items[0].createdAt).toBe('2026-09-17T00:00:00.000Z')
    expect(store.getDropped()).toBe(0)
  })

  it('links/tags 中的非字符串元素被过滤', async () => {
    const line = JSON.stringify({ key: 'rule.x', value: 'v', scope: 'global', tags: ['a', 1, 'b'], links: ['l1', null] })
    const fs = makeStubFs({ 'memory.jsonl': line + '\n' })
    const store = createStore({ fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global', makeId: () => 'g', now: () => 't' })
    const items = await store.readItems()
    expect(items[0].tags).toEqual(['a', 'b'])
    expect(items[0].links).toEqual(['l1'])
    expect(store.getDropped()).toBe(0)
  })
})

// ── 工具级：stats.dropped + 降级守则 ──
const tmpDirs: string[] = []
function setupIntegration() {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: true, autoCapture: true, autoRecallRerank: false, autoExtract: false })
  return { fake, dir }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

describe('M1 工具级：stats.dropped 与降级守则', () => {
  it('memory_stats 报告 dropped===3', async () => {
    const { fake, dir } = setupIntegration()
    writeFileSync(join(dir, 'memory.jsonl'), [DIRTY_NO_SCOPE, DIRTY_SCOPE_NUM, DIRTY_NO_VALUE, NORMAL].join('\n') + '\n', 'utf8')
    const statsTool = fake.toolDefs.get('memory_stats')
    const s = await statsTool.execute({})
    expect(s.total).toBe(1)
    expect(s.dropped).toBe(3)
  })

  it('memory_search 仍能检索到正常行（坏行不拖垮检索通道）', async () => {
    const { fake, dir } = setupIntegration()
    writeFileSync(join(dir, 'memory.jsonl'), [DIRTY_NO_SCOPE, DIRTY_SCOPE_NUM, DIRTY_NO_VALUE, NORMAL].join('\n') + '\n', 'utf8')
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({ query: '正常' })
    expect(s.count).toBe(1)
    expect(s.items[0].key).toBe('rule.ok')
  })

  it('注入链被打断时降级为仅注入守则（不再整体静默）', async () => {
    const { fake, dir } = setupIntegration()
    // 故障注入：memory.jsonl 是目录 → stat 成功但 readFile 抛 EISDIR → 召回链崩
    rmSync(join(dir, 'memory.jsonl'), { force: true })
    mkdirSync(join(dir, 'memory.jsonl'))
    const payload = {
      agent: { session: { id: 'sess-d', header: {}, surface: undefined, events: undefined }, options: {} },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'pwsh 报错' }] }],
      step: 1,
      signal: undefined,
    }
    const d = await runPreStep(fake.handlers, payload)
    expect(findPluginMessages(d, 'memory-capture-guide')).toHaveLength(1)
  })
})
