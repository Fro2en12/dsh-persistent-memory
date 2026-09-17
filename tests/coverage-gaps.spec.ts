import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { createStore } from '../src/store'
import type { StoreFs, StoreFsStat, StoreFileHandle } from '../src/store'
import type { MemoryItem } from '../src/types'
import { upsertMemory, type UpsertInput } from '../src/write-gate'
import { ageLabel, bigramJaccard, contentSimilarity, keySimilarity, pickRecallItems, semanticOverlap, truncate } from '../src/recall'
import type { RecallEnv } from '../src/recall'
import { sanitizeValue } from '../src/sanitize'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M9 测试覆盖补充：只补既有用例未覆盖的边界，不复述已有断言。
// 与既有文件的边界划分：
// - unit-baseline：truncate 只测「短文本 + 硬截断」；ageLabel 只测 今天/昨天/3 天前；
//   bigramJaccard 只测「相近分更高」；upsertMemory 只测 同 key 覆盖 与 dedupe 合并。
// - read-normalize：只测 缺 scope / scope 非串 / 缺 value / tags+links 混合元素过滤。
// - sanitize.spec：只测 危险 scheme 中和 与 普通文本不误伤（未覆盖盘符路径回归）。
// - store-atomic：只测 原子写 与 缓存一致性（读侧容错未覆盖）。
// 本文件不 import store-atomic.spec.ts，makeStubFs 为自带副本。

function mkItem(p: { key: string; value?: string; scope?: string; tags?: string[]; id?: string; createdAt?: string; updatedAt?: string }): MemoryItem {
  return {
    id: p.id ?? 'id-' + p.key,
    key: p.key,
    value: p.value ?? 'v',
    scope: p.scope ?? 'global',
    tags: p.tags ?? [],
    createdAt: p.createdAt ?? '2026-09-01T00:00:00.000Z',
    updatedAt: p.updatedAt ?? '2026-09-01T00:00:00.000Z',
  }
}

function upsertInput(p: { key: string; value: string; full?: string; links?: string[]; tags?: string[]; scope?: string; source?: string; explicitSource?: boolean }): UpsertInput {
  return {
    key: p.key,
    value: p.value,
    links: p.links ?? [],
    tags: p.tags ?? [],
    scope: p.scope ?? 'global',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    source: p.source ?? '测试',
    explicitSource: p.explicitSource ?? false,
    ...(p.full !== undefined ? { full: p.full } : {}),
  }
}

/** 主会话 exec（header 0 + options 0）：避免 fail-closed 把工具级用例判成子代理 */
const MAIN = { agent: { session: { id: 'cov-main', header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } }

const tmpDirs: string[] = []
function setup(config: Record<string, unknown> = {}) {
  const dir = makeTempDir('dspm-cov')
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false, ...config })
  return { fake, dir }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

function err(code: string): Error & { code: string } {
  const e = new Error(code) as Error & { code: string }
  e.code = code
  return e
}

/** 内存文件系统桩（思路同 store-atomic.spec.ts，本文件自带一份） */
function makeStubFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const mtimes = new Map<string, number>(Object.keys(initial).map((p) => [p, 1]))
  let clock = 1
  const touch = (p: string) => mtimes.set(p, ++clock)
  const fs: StoreFs = {
    stat: async (p): Promise<StoreFsStat> => {
      const c = files.get(p)
      if (c === undefined) throw err('ENOENT')
      return { mtimeMs: mtimes.get(p) ?? 1, size: Buffer.byteLength(c, 'utf8') }
    },
    readFile: async (p) => {
      const c = files.get(p)
      if (c === undefined) throw err('ENOENT')
      return c
    },
    mkdir: async () => {},
    open: async (p): Promise<StoreFileHandle> => {
      const chunks: string[] = []
      return {
        writeFile: async (body) => { chunks.push(body) },
        sync: async () => { files.set(p, chunks.join('')); touch(p) },
        close: async () => {},
      }
    },
    rename: async (from, to) => {
      const c = files.get(from)
      if (c === undefined) throw err('ENOENT')
      files.set(to, c)
      touch(to)
      files.delete(from)
    },
    copyFile: async (from, to) => {
      const c = files.get(from)
      if (c === undefined) throw err('ENOENT')
      files.set(to, c)
      touch(to)
    },
    unlink: async (p) => {
      if (!files.has(p)) throw err('ENOENT')
      files.delete(p)
      mtimes.delete(p)
    },
  }
  return fs
}

/** 用给定 JSONL 文本构造 store（只测读侧，写侧桩不落盘也够用） */
function readStore(text: string) {
  const fs = makeStubFs({ 'memory.jsonl': text })
  return createStore({ fs, dataDir: '.', dataFile: 'memory.jsonl', defaultScope: 'global', makeId: () => 'gen-id', now: () => '2026-09-17T00:00:00.000Z' })
}

// ── 1) 写侧闸门：tags 上限（工具级）──────────────────────────────────
describe('M9 写侧闸门：tags ≤3（工具级 memory_set）', () => {
  it('tags 4 个 → 拒绝写入且条目未落盘', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await expect(setTool.execute({ key: 'rule.tags4', value: 'v', tags: ['a', 'b', 'c', 'd'] }, MAIN))
      .rejects.toThrow(/tags 最多 3 个（当前 4 个）/)
    const g = await fake.toolDefs.get('memory_get').execute({ key: 'rule.tags4' })
    expect(g.found).toBe(false)
  })

  it('tags 正好 3 个 → 允许；空白标签被 trim 后不计入上限', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const r1 = await setTool.execute({ key: 'rule.tags3', value: '第一条内容', tags: ['a', 'b', 'c'] }, MAIN)
    expect(r1.ok).toBe(true)
    const r2 = await setTool.execute({ key: 'rule.tags3b', value: '第二条内容', tags: ['a', 'b', 'c', '   ', ''] }, MAIN)
    expect(r2.ok).toBe(true)
    const g = await fake.toolDefs.get('memory_get').execute({ key: 'rule.tags3b' })
    expect(g.tags).toEqual(['a', 'b', 'c'])
  })
})

// ── 2) 写侧闸门：dedupeOnSet=false 时相似 key 新建而非合并 ──────────────
describe('M9 写侧闸门：dedupeOnSet=false 相似 key 不合并', () => {
  it('upsertMemory(dedupe=false)：相似 key 新建（created=true / mergedKey 空 / 条数 +1）', () => {
    const items = [mkItem({ key: 'env.node-version', value: 'Node 22' })]
    const r = upsertMemory(items, upsertInput({ key: 'env.nodejs-version', value: 'Node 24' }), { dedupe: false, makeId: () => 'id-new' })
    expect(r.created).toBe(true)
    expect(r.mergedKey).toBe('')
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.key)).toEqual(['env.node-version', 'env.nodejs-version'])
    expect(items.map((i) => i.value)).toEqual(['Node 22', 'Node 24'])
  })

  it('upsertMemory(dedupe=true)：同一输入就地合并（对照组，证明开关是唯一变量）', () => {
    const items = [mkItem({ key: 'env.node-version', value: 'Node 22' })]
    const r = upsertMemory(items, upsertInput({ key: 'env.nodejs-version', value: 'Node 24' }), { dedupe: true, makeId: () => 'id-new' })
    expect(r.created).toBe(false)
    expect(r.mergedKey).toBe('env.node-version')
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe('env.node-version')
    expect(items[0].value).toBe('Node 24')
  })

  it('工具级 dedupeOnSet=false：相似 key 落成两条（memory_search 能查到 2 条）', async () => {
    const { fake } = setup({ dedupeOnSet: false })
    const setTool = fake.toolDefs.get('memory_set')
    const r1 = await setTool.execute({ key: 'env.node-version', value: 'Node 版本 22' }, MAIN)
    expect(r1.created).toBe(true)
    const r2 = await setTool.execute({ key: 'env.nodejs-version', value: 'Node 版本 24' }, MAIN)
    expect(r2.created).toBe(true)
    expect(r2.mergedKey).toBe('')
    const search = await fake.toolDefs.get('memory_search').execute({ query: 'node' }, MAIN)
    expect(search.count).toBe(2)
    expect(search.items.map((i: any) => i.key).sort()).toEqual(['env.node-version', 'env.nodejs-version'])
  })
})

// ── 3) 写侧闸门：内容冲突检测（≥55% → clashKey/clashSim 警告）──────────
describe('M9 写侧闸门：内容冲突检测 ≥55%', () => {
  it('upsertMemory：相似度 ≥55% → 返回 clashKey/clashSim，条目仍新建（不静默并存另一条也不吞掉新条）', () => {
    const items = [mkItem({ key: 'rule.weather', value: '今天天气很好呀' })]
    const r = upsertMemory(items, upsertInput({ key: 'rule.other', value: '今天天气很好' }), { dedupe: true, makeId: () => 'id-new' })
    expect(r.created).toBe(true)
    expect(r.clashKey).toBe('rule.weather')
    expect(r.clashSim).toBeCloseTo(5 / 6, 6)
    expect(r.clashSim).toBeGreaterThanOrEqual(0.55)
    expect(items).toHaveLength(2)
  })

  it('upsertMemory：相似度 <55% → 不返回 clashKey（key 前缀相同只有 0.5，差 0.05 就跨过门槛）', () => {
    const items = [mkItem({ key: 'rule.weather', value: '今天天气很好呀' })]
    const r = upsertMemory(items, upsertInput({ key: 'rule.other', value: 'unsupported zipcode' }), { dedupe: true, makeId: () => 'id-new' })
    expect(r.clashKey).toBeUndefined()
    expect(r.clashSim).toBeUndefined()
    expect(items).toHaveLength(2)
    expect(contentSimilarity(items[0], mkItem({ key: 'rule.other', value: 'unsupported zipcode' }))).toBe(0.5)
  })

  it('工具级：新建条目时 warnings 带 clashKey 警告文案（≥55%）', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.sunny', value: '今天天气很好呀，适合出门散步' }, MAIN)
    const r = await setTool.execute({ key: 'rule.rainy', value: '今天天气很好呀，适合出门散步。' }, MAIN)
    expect(r.created).toBe(true)
    expect(Array.isArray(r.warnings)).toBe(true)
    expect(r.warnings.some((w: string) => w.includes('内容高度相似') && w.includes('rule.sunny'))).toBe(true)
  })
})

// ── 4) 写侧闸门：value 超长 → 摘要 + full 归档原文 ─────────────────────
describe('M9 写侧闸门：value 超长截断后 full 归档', () => {
  it('value > valueMaxChars：摘要落盘 ≤ 上限+省略号，full 带时间戳归档完整原文', async () => {
    const { fake, dir } = setup({ valueMaxChars: 120 })
    const longValue = '第一句话讲清楚了背景。' + '第二段补充细节与原因，包含文件名 src/index.ts 与命令。'.repeat(6)
    expect(longValue.length).toBeGreaterThan(120)
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'rule.long', value: longValue }, MAIN)
    expect(r.ok).toBe(true)
    expect(r.warnings?.some((w: string) => w.includes('已截断为摘要'))).toBe(true)

    const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8')
    const stored = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l)).find((x: any) => x.key === 'rule.long')
    expect(stored).toBeTruthy()
    expect(stored.value.length).toBeLessThanOrEqual(121)
    expect(stored.value.endsWith('…')).toBe(true)
    expect(longValue.startsWith(stored.value.slice(0, -1))).toBe(true)
    expect(stored.full.startsWith('<!-- ')).toBe(true)
    expect(stored.full).toContain(longValue)

    // memory_get 输出面过 sanitizeValue：NFKC 归一（全角 ，→ , ；省略号 … → ...）
    const g = await fake.toolDefs.get('memory_get').execute({ key: 'rule.long', includeFull: true })
    expect(g.found).toBe(true)
    expect(g.value).toBe(stored.value.normalize('NFKC'))
    expect(g.value.endsWith('...')).toBe(true)
    expect(g.full.startsWith('<!-- ')).toBe(true)
    expect(g.full).toContain(longValue.normalize('NFKC'))
  })

  it('value 正好等于 valueMaxChars：不截断、不产生 warnings', async () => {
    const { fake, dir } = setup({ valueMaxChars: 120 })
    const exact = '甲'.repeat(120)
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'rule.exact', value: exact }, MAIN)
    expect(r.ok).toBe(true)
    expect(r.warnings).toBeUndefined()
    const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8')
    const stored = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l)).find((x: any) => x.key === 'rule.exact')
    expect(stored.value).toBe(exact)
    expect(stored.full).toBeUndefined()
  })
})

// ── 5) 相似度函数边界：空串 / 纯符号 / 中英混合 / 1 与 0 ────────────────
describe('M9 相似度函数边界', () => {
  it('keySimilarity：空串与纯符号 → 0；完全相同（含大小写）→ 1；部分重叠 → 交集/最大词元数', () => {
    expect(keySimilarity('', 'rule.x')).toBe(0)
    expect(keySimilarity('rule.x', '')).toBe(0)
    expect(keySimilarity('', '')).toBe(0)
    expect(keySimilarity('!!!', '???')).toBe(0)
    expect(keySimilarity('!!!', '!!!')).toBe(0)
    expect(keySimilarity('rule.a', 'rule.a')).toBe(1)
    expect(keySimilarity('Rule.A', 'rule.a')).toBe(1)
    expect(keySimilarity('env.node', 'tool.node')).toBe(0.5)
    expect(keySimilarity('环境.node', 'env.node')).toBe(0.5)
    expect(keySimilarity('rule.alpha', 'rule.alpha.beta')).toBeCloseTo(2 / 3, 6)
  })

  it('bigramJaccard：空串/纯符号 → 0；完全相同 → 1；完全不重叠 → 0；中英混合仍能算重叠', () => {
    expect(bigramJaccard('', '')).toBe(0)
    expect(bigramJaccard('', '今天天气')).toBe(0)
    expect(bigramJaccard('今天天气', '')).toBe(0)
    expect(bigramJaccard('!!!', '???')).toBe(0)
    expect(bigramJaccard('今天天气很好', '今天天气很好')).toBe(1)
    expect(bigramJaccard('abc def', 'xyz uvw')).toBe(0)
    expect(bigramJaccard('今天天气很好', 'today is sunny')).toBe(0)
    expect(bigramJaccard('使用 pwsh 运行测试', 'pwsh 测试运行')).toBeGreaterThan(0)
  })

  it('semanticOverlap：共享二元组/词元计数；空串与单字母英文词元 → 0', () => {
    expect(semanticOverlap('', '今天天气')).toBe(0)
    expect(semanticOverlap('今天天气', '')).toBe(0)
    expect(semanticOverlap('!!!', '???')).toBe(0)
    expect(semanticOverlap('a', 'a')).toBe(0)
    expect(semanticOverlap('pwsh', 'pwsh test')).toBe(1)
    expect(semanticOverlap('运行测试', '运行测试通过')).toBe(3)
    expect(semanticOverlap('运行测试', '完全不同的一段内容')).toBe(0)
  })

  it('contentSimilarity：取 value 二元组与 key 相似的高者；同条目 → 1；完全无关 → 0', () => {
    const a = mkItem({ key: 'rule.weather', value: '今天天气很好呀' })
    expect(contentSimilarity(a, mkItem({ key: 'rule.weather', value: '今天天气很好呀' }))).toBe(1)
    expect(contentSimilarity(a, mkItem({ key: 'tool.pwsh', value: 'unsupported zipcode' }))).toBe(0)
    expect(contentSimilarity(a, mkItem({ key: 'rule.weather', value: '完全不同的一段内容' }))).toBe(1)
    expect(contentSimilarity(a, mkItem({ key: 'rule.other', value: 'unsupported zipcode' }))).toBe(0.5)
  })
})

// ── 6) truncate 边界 ──────────────────────────────────────────────
describe('M9 truncate 边界', () => {
  it('短于或正好等于上限 → 原样返回', () => {
    expect(truncate('abc', 10)).toBe('abc')
    expect(truncate('abcdefghij', 10)).toBe('abcdefghij')
    expect(truncate('', 5)).toBe('')
  })

  it('长文本：在 。；！？ 与换行边界截断并补省略号', () => {
    expect(truncate('第一句。后面还有很多很多内容', 5)).toBe('第一句。…')
    expect(truncate('前缀足够长的；后续内容也要足够长', 8)).toBe('前缀足够长的；…')
    expect(truncate('注意安全！后面还有很多内容', 6)).toBe('注意安全！…')
    expect(truncate('这样可以吗？后面还有很多内容', 7)).toBe('这样可以吗？…')
    expect(truncate('第一行内容\n第二行内容还在继续', 7)).toBe('第一行内容\n…')
  })

  it('英文 ". " 句边界同样生效（在 "." 之后截断，边界里的空格被吃掉）', () => {
    expect(truncate('hello world. more text follows here', 14)).toBe('hello world.…')
  })

  it('边界位置 ≤ max*0.5 或不在切片内 → 走硬截断（长度 = max + 省略号）', () => {
    const early = truncate('a. ' + 'b'.repeat(16), 12)
    expect(early).toBe('a. ' + 'b'.repeat(9) + '…')
    expect(early.length).toBe(13)
    // 若走边界分支结果会是 'a. …'（4 字）；硬截断保留满 max 个字符
    expect(early.slice(0, 3)).toBe('a. ')
    expect(early.slice(3)).toBe('b'.repeat(9) + '…')
    expect(truncate('abcd。efghijklmnop', 8)).toBe('abcd。efg…')
    expect(truncate('abcdefghij. klmnop', 10)).toBe('abcdefghij…')
  })
})

// ── 7) ageLabel 天龄边界 ──────────────────────────────────────────
describe('M9 ageLabel 天龄边界', () => {
  it('今天 / 昨天 / 2 天前 / 30 天前', () => {
    expect(ageLabel(new Date().toISOString())).toBe('今天')
    expect(ageLabel(new Date(Date.now() - 86_400_000).toISOString())).toBe('昨天')
    expect(ageLabel(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2 天前')
    expect(ageLabel(new Date(Date.now() - 30 * 86_400_000).toISOString())).toBe('30 天前')
  })

  it('未来时间钳到 0 → 今天；非法时间串 → 今天', () => {
    expect(ageLabel(new Date(Date.now() + 86_400_000).toISOString())).toBe('今天')
    expect(ageLabel('不是时间')).toBe('今天')
  })
})

// ── 8) pickRecallItems：fallback 补最近 / hasImage 不影响词法路径 ───────
const RECALL_ENV: RecallEnv = {
  synonymExpansion: true,
  taskTtlDays: 30,
  workspaceScopes: [],
  autoRecallScope: '',
  minScore: 3,
  relativeFloor: 0,
  rrfRecall: false,
  rrfFirstTurnOnly: true,
}

describe('M9 pickRecallItems：fallback 与 hasImage', () => {
  const items = [
    mkItem({ id: 'a', key: 'env.pwsh', value: 'PowerShell 运行脚本', tags: ['pwsh'], updatedAt: '2026-09-01T00:00:00.000Z' }),
    mkItem({ id: 'b', key: 'tool.zip', value: '压缩工具', updatedAt: '2026-09-10T00:00:00.000Z' }),
    mkItem({ id: 'c', key: 'rule.other', value: '别的事情', updatedAt: '2026-09-05T00:00:00.000Z' }),
  ]

  it('autoRecallFallback=true（非首轮）：命中项在前，其余按 updatedAt 倒序补齐到 limit', () => {
    const hit = pickRecallItems(items, 'pwsh', 3, true, false, false, RECALL_ENV)
    expect(hit.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('autoRecallFallback=false：只返回词法命中项', () => {
    const hit = pickRecallItems(items, 'pwsh', 3, false, false, false, RECALL_ENV)
    expect(hit.map((i) => i.id)).toEqual(['a'])
  })

  it('首轮（isFirstTurn=true）不启用 fallback：阈值 6 分只放行 key 命中+标签条目', () => {
    const hit = pickRecallItems(items, 'pwsh', 3, true, true, false, RECALL_ENV)
    expect(hit.map((i) => i.id)).toEqual(['a'])
  })

  it('hasImage 不影响词法路径：true/false 结果逐项一致', () => {
    const withImage = pickRecallItems(items, 'pwsh', 3, true, false, true, RECALL_ENV)
    const withoutImage = pickRecallItems(items, 'pwsh', 3, true, false, false, RECALL_ENV)
    expect(withImage.map((i) => i.id)).toEqual(withoutImage.map((i) => i.id))
    expect(withImage).toHaveLength(3)
  })

  it('autoRecallScope 生效：只返回该 scope 的条目', () => {
    const scoped = [
      mkItem({ id: 'g', key: 'env.pwsh', value: 'PowerShell 全局', scope: 'global', tags: ['pwsh'] }),
      mkItem({ id: 'p', key: 'env.pwsh', value: 'PowerShell 项目', scope: 'proj-x', tags: ['pwsh'] }),
    ]
    const hit = pickRecallItems(scoped, 'pwsh', 3, false, false, false, { ...RECALL_ENV, workspaceScopes: ['proj-x'], autoRecallScope: 'proj-x' })
    expect(hit.map((i) => i.id)).toEqual(['p'])
  })
})

// ── 9) sanitizeValue：URL/盘符路径不受损 + 控制字符移除 ─────────────────
describe('M9 sanitizeValue 路径与 URL 回归', () => {
  it('http(s) URL 原样保留', () => {
    expect(sanitizeValue('http://127.0.0.1:3080/web?q=1&r=2#h')).toBe('http://127.0.0.1:3080/web?q=1&r=2#h')
    expect(sanitizeValue('见 https://example.com/a/b.ts')).toBe('见 https://example.com/a/b.ts')
  })

  it('盘符路径 E:/ 与 D:\\ 原样保留（重要回归点）', () => {
    expect(sanitizeValue('E:/dsh/workspace/memory.jsonl')).toBe('E:/dsh/workspace/memory.jsonl')
    expect(sanitizeValue('D:\\改着玩\\dsh-persistent-memory\\src\\index.ts')).toBe('D:\\改着玩\\dsh-persistent-memory\\src\\index.ts')
    expect(sanitizeValue('dataDir=D:\\改着玩\\dsh-persistent-memory 且 E:/tmp/x')).toBe('dataDir=D:\\改着玩\\dsh-persistent-memory 且 E:/tmp/x')
    expect(sanitizeValue('E:/a/b')).not.toContain('\u02d0')
  })

  it('控制字符被移除，制表/换行/回车保留', () => {
    expect(sanitizeValue('a\x00b\x07c\x0Bd\x0Ce\x1Ff\x7Fg')).toBe('abcdefg')
    expect(sanitizeValue('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })
})

// ── 10) readItems 容错（建 store + 注入 fs 桩）─────────────────────────
describe('M9 readItems 容错', () => {
  it('空文件 → [] 且 dropped 0', async () => {
    const store = readStore('')
    expect(await store.readItems()).toEqual([])
    expect(store.getDropped()).toBe(0)
  })

  it('只有换行/空白行 → [] 且 dropped 0', async () => {
    const store = readStore('\n\n\r\n   \n\t\n')
    expect(await store.readItems()).toEqual([])
    expect(store.getDropped()).toBe(0)
  })

  it('只有 schema 哨兵行 → [] 且不计入坏行（dropped 0）', async () => {
    const store = readStore('{"__schema":1}\n')
    expect(await store.readItems()).toEqual([])
    expect(store.getDropped()).toBe(0)
  })

  it('JSON 语法错误行 → 只丢坏行，正常行仍可读（dropped 1）', async () => {
    const good = JSON.stringify({ key: 'rule.ok', value: '正常内容', scope: 'global', tags: [] })
    const store = readStore('{不是合法 JSON}\n' + good + '\n')
    const items = await store.readItems()
    expect(items.map((i) => i.key)).toEqual(['rule.ok'])
    expect(items[0].value).toBe('正常内容')
    expect(store.getDropped()).toBe(1)
  })

  it('tags 为非数组 → 整行丢弃并 dropped 1', async () => {
    const store = readStore(JSON.stringify({ key: 'rule.badtags', value: 'v', scope: 'global', tags: 'not-array' }) + '\n')
    expect(await store.readItems()).toEqual([])
    expect(store.getDropped()).toBe(1)
  })

  it('links 含非字符串 → 过滤后保留字符串元素，行不丢弃', async () => {
    const line = JSON.stringify({ key: 'rule.links', value: 'v', scope: 'global', links: ['a', 1, null, 'b', {}, true] })
    const store = readStore(line + '\n')
    const items = await store.readItems()
    expect(items).toHaveLength(1)
    expect(items[0].links).toEqual(['a', 'b'])
    expect(store.getDropped()).toBe(0)
  })
})