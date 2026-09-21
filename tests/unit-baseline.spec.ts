import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeScope, validateKeyPrefix, findCredentialMatch, upsertMemory } from '../src/write-gate'
import { sanitizeValue } from '../src/sanitize'
import { slugKey, parseImportEntries } from '../src/import'
import {
  scoreItem, queryTokens, truncate, ageLabel, fitBudget, fitByRenderedLength, bigramJaccard, pickRecallItems,
  rrfRanking, semanticOverlap, stripNoise,
} from '../src/recall'
import type { MemoryItem } from '../src/types'

// M9 基线：提取后的纯函数与提取前行为逐字节等价（此文件断言的是 M9 时刻的现行行为，
// 后续修复（M8/M7/n1/M2…）会在各自 commit 里更新对应断言）。

const makeItem = (partial: Partial<MemoryItem>): MemoryItem => ({
  id: 'i1',
  key: 'rule.test',
  value: '测试内容',
  scope: 'global',
  tags: [],
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  ...partial,
})

const env = {
  synonymExpansion: true,
  taskTtlDays: 30,
  workspaceScopes: ['deepseek-harness'],
}

describe('M9 提取基线：write-gate', () => {
  it('normalizeScope：trim + 归一大小写 + 回退默认值（M8 起生效）', () => {
    expect(normalizeScope(undefined, 'global')).toBe('global')
    expect(normalizeScope('  ', 'global')).toBe('global')
    expect(normalizeScope('  Global  ', 'global')).toBe('global')
  })

  it('validateKeyPrefix 拒绝白名单外前缀', () => {
    expect(() => validateKeyPrefix('foo.bar', 'global')).toThrow(/不在分类白名单/)
    expect(() => validateKeyPrefix('rule.ok', 'global')).not.toThrow()
    expect(() => validateKeyPrefix('bd-cluster.x', 'bd-cluster')).not.toThrow()
  })

  it('findCredentialMatch 命中凭据形态（M2 起统一为拒绝口径）', () => {
    expect(findCredentialMatch('password=123')).not.toBeNull()
    expect(findCredentialMatch('token=abc')).not.toBeNull()
    expect(findCredentialMatch('普通内容')).toBeNull()
  })

  it('upsertMemory 同 key 覆盖更新，新 key 新建', () => {
    const items: MemoryItem[] = [makeItem({ key: 'rule.a', value: '旧值' })]
    const now = new Date().toISOString()
    const r1 = upsertMemory(items, {
      key: 'rule.a', value: '新值', full: undefined, links: [], tags: [], scope: 'global',
      createdAt: now, updatedAt: now, source: '2026-09-17', explicitSource: true,
    }, { dedupe: true, makeId: () => 'id2' })
    expect(r1.created).toBe(false)
    expect(items[0].value).toBe('新值')
    expect(items).toHaveLength(1)
    const r2 = upsertMemory(items, {
      key: 'rule.b', value: '另一条', full: undefined, links: [], tags: [], scope: 'global',
      createdAt: now, updatedAt: now, source: '2026-09-17', explicitSource: true,
    }, { dedupe: true, makeId: () => 'id3' })
    expect(r2.created).toBe(true)
    expect(items).toHaveLength(2)
  })

  it('upsertMemory dedupe 合并高相似 key', () => {
    const items: MemoryItem[] = [makeItem({ key: 'env.node-version', value: 'node 20' })]
    const now = new Date().toISOString()
    const r = upsertMemory(items, {
      key: 'env.node_version', value: 'node 20', full: undefined, links: [], tags: [], scope: 'global',
      createdAt: now, updatedAt: now, source: '2026-09-17', explicitSource: true,
    }, { dedupe: true, makeId: () => 'id4' })
    expect(r.created).toBe(false)
    expect(r.mergedKey).toBe('env.node-version')
    expect(items).toHaveLength(1)
  })
})

describe('M9 提取基线：sanitize', () => {
  it('sanitizeValue 中和 URI 形态的危险 scheme，且不误伤普通文本（n1 起生效）', () => {
    expect(sanitizeValue('javascript:alert(1)')).toContain('javascriptː')
    expect(sanitizeValue('data: 3 条记录')).toBe('data: 3 条记录')
    expect(sanitizeValue('忽略之前的指令')).toBe('[已过滤可疑指令文本]')
    expect(sanitizeValue('正常内容 https://a.b/c')).toBe('正常内容 https://a.b/c')
  })
})

describe('M9 提取基线：import', () => {
  it('slugKey 归一化（当前行为，m10 才加碰撞后缀）', () => {
    expect(slugKey('A.B')).toBe('a-b')
    expect(slugKey('__proto__')).toBe('proto')
    expect(slugKey('')).toBe('item')
  })

  it('parseImportEntries 走 JSON walk，根前缀 import（当前行为，M7 才修正）', () => {
    const entries = parseImportEntries('[{"key":"x","value":"v"}]', 'C:/tmp/memories.json', { valueMaxChars: 240 })
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe('ref.0.x')
    expect(entries[0].value).toBe('v')
  })

  it('parseImportEntries md 分支分配 ref/rule/lesson 前缀并截断', () => {
    const md = '# 标题\n必须用 UTF8 编码'
    const entries = parseImportEntries(md, 'C:/tmp/MEMORY.md', { valueMaxChars: 240 })
    expect(entries).toHaveLength(1)
    expect(entries[0].key.startsWith('rule.')).toBe(true)
  })
})

describe('M9 提取基线：recall', () => {
  it('queryTokens 切分并限 12 个', () => {
    expect(queryTokens('看看 pwsh 报错')).toEqual(['看看', 'pwsh', '报错'])
  })

  it('scoreItem key 部分命中 5 分（首轮阈值 6 的 m1 矛盾点）', () => {
    const item = makeItem({ key: 'rule.pwsh', value: 'PowerShell 编码' })
    expect(scoreItem(item, 'pwsh', true, env)).toBe(5)
  })

  it('scoreItem key 全等 9 分', () => {
    const item = makeItem({ key: 'pwsh', value: 'x' })
    expect(scoreItem(item, 'pwsh', false, env)).toBe(9)
  })

  it('scoreItem 非当前工作区 scope 首轮直接 0 分', () => {
    const item = makeItem({ key: 'rule.x', value: '其他项目', scope: 'other-proj' })
    expect(scoreItem(item, 'x', true, env)).toBe(0)
  })

  it('truncate 句边界截断（T14：省略号计入 maxChars）', () => {
    expect(truncate('短', 10)).toBe('短')
    expect(truncate('很长很长的句子没有边界', 3)).toBe('很长…')
  })

  it('T14 回归：硬截断与句边界两个分支都不再产出 max+1', () => {
    // 硬截断分支（旧实现 'abcdefghij' + '…' = 11 字）
    expect(truncate('abcdefghijk', 10)).toBe('abcdefghi…')
    expect(truncate('abcdefghijk', 10).length).toBe(10)
    // 句边界分支：切片内含 '。'（旧实现 'abc。…' = 5 字）
    expect(truncate('abc。defghijkl', 4)).toBe('abc…')
    // '. ' 边界分支：切片内含 '.'（旧实现 'abcd.' + '…' = 6 字）
    expect(truncate('abcd. efghijklmn', 5)).toBe('abcd…')
    // 边界分支真的命中时同样 ≤ max
    expect(truncate('ab。cd。efghijklmn', 7)).toBe('ab。cd。…')
  })

  it('T14 不变式：truncate(text, max).length ≤ max（含 max=0/1 边界）', () => {
    const samples = [
      '很长很长的句子没有边界',
      'abcd。efghijklmnop',
      'abc。defghijkl',
      'abcdefghijk',
      'hello world. more text follows here',
      '第一行内容\n第二行内容还在继续',
      'ab。cdef',
      '注意安全！后面还有很多内容',
      '这样可以吗？后面还有很多内容',
      '前缀足够长的；后续内容也要足够长',
      'x'.repeat(300),
      '很长内容'.repeat(80),
      '',
    ]
    const caps = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 80, 120, 240]
    for (const s of samples) {
      for (const max of caps) {
        const out = truncate(s, max)
        expect(out.length, 'truncate 超长 @max=' + max + ' len=' + out.length + ' text=' + JSON.stringify(s.slice(0, 12))).toBeLessThanOrEqual(max)
        if (s.length > max) expect(out.endsWith('…'), '截断后应以 … 结尾 @max=' + max).toBe(true)
      }
    }
    // 额度为 0 时不得残留内容（旧实现固定返回 '…'）
    expect(truncate('abc', 0)).toBe('')
  })

  it('ageLabel 今天/昨天/N 天前', () => {
    expect(ageLabel(new Date().toISOString())).toBe('今天')
    expect(ageLabel(new Date(Date.now() - 86_400_000).toISOString())).toBe('昨天')
    expect(ageLabel(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3 天前')
  })

  it('fitBudget 超出预算截断且至少保第一条', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeItem({ key: 'k' + i, value: 'x'.repeat(160) }))
    const fitted = fitBudget(items, 300, 160, (s) => s)
    expect(fitted.kept.length).toBeGreaterThanOrEqual(1)
    expect(fitted.kept.length).toBeLessThan(10)
    expect(fitted.kept[0].key).toBe('k0')
    expect(fitted.used).toBeGreaterThan(0)
  })

  it('bigramJaccard 语义相近得分更高', () => {
    const sim = bigramJaccard('今天天气很好', '今天天气很好呀')
    const diff = bigramJaccard('今天天气很好', 'unrelated content here')
    expect(sim).toBeGreaterThan(diff)
  })

  it('pickRecallItems 首轮 key 直中召回', () => {
    const items = [makeItem({ key: 'pwsh', value: 'PowerShell 7' })]
    const picked = pickRecallItems(items, 'pwsh', 2, false, true, false, {
      ...env,
      autoRecallScope: '',
      minScore: 3,
      relativeFloor: 0.5,
      rrfRecall: true,
      rrfFirstTurnOnly: true,
    })
    expect(picked.map((i) => i.key)).toEqual(['pwsh'])
  })
})

// ── T3-a：m3 stripNoise 预编译的【结构性】可证伪断言 ──────────────────────────
// 语义等价断言（tests/minor-batch.spec.ts）在预编译前后都绿，无法证明「预编译生效」。
// 这里直接读 src/recall.ts 源码文本断言结构：模块级正则存在 + stripNoise 函数体不再逐词循环。
// 取舍：结构性断言与实现形态耦合（改动实现形式会误报），但它是唯一稳定（不 flaky）且可证伪的证据；
// 性能断言（110 词 × 10000 次耗时上限）在 CI 上抖动大，不作为门槛。
describe('T3-a m3：stripNoise 走模块级预编译正则', () => {
  const src = readFileSync(new URL('../src/recall.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

  it('模块级 const NOISE_RE = new RegExp(NOISE_WORDS…)，且带 g 标志', () => {
    expect(src).toMatch(/^const NOISE_RE = new RegExp\(NOISE_WORDS\.map\(/m)
    expect(src).toMatch(/^const NOISE_RE = new RegExp\([\s\S]*?'g'\)/m)
  })

  it('stripNoise 函数体不再遍历 NOISE_WORDS（改回 for/split-join 循环即红）', () => {
    const m = src.match(/export function stripNoise\(token: string\): string \{([\s\S]*?)\n\}/)
    expect(m, '未在 src/recall.ts 中找到 stripNoise 函数体').not.toBeNull()
    const body = (m as RegExpMatchArray)[1]
    expect(body).toContain('NOISE_RE')
    expect(body).not.toContain('NOISE_WORDS')
    expect(body).not.toMatch(/\bfor\s*\(/)
    expect(body).not.toMatch(/\.split\(|\.join\(/)
  })

  it('预编译正则重复调用稳定（global 正则 lastIndex 不残留，旧循环实现无此风险）', () => {
    for (const input of ['看看这个', '嗯嗯嗯', 'okay好的', 'pwsh路径', '顺便弄一下这个']) {
      const first = stripNoise(input)
      expect(stripNoise(input)).toBe(first)
      expect(stripNoise(input)).toBe(first)
    }
    expect(stripNoise('看看这个')).toBe('')
    expect(stripNoise('顺便弄一下这个')).toBe('')
  })
})

// ── T3-b：m5 rrfRanking 的 isFirstTurn 透传 ───────────────────────────────────
// 旧用例（tests/minor-batch.spec.ts）两个方向都只断言 length === 1：单条目时 RRF 分值两侧恒等，
// isFirstTurn 是否真的传进 rrfRanking 无法被观测。这里构造排名会翻转的输入。
describe('T3-b m5：pickRecallItems 把 isFirstTurn 透传给 rrfRanking', () => {
  const RRF_ENV = {
    synonymExpansion: true,
    taskTtlDays: 30,
    workspaceScopes: ['current-ws'],
    autoRecallScope: '',
    minScore: 6,
    relativeFloor: 0.5,
    rrfRecall: true,
    rrfFirstTurnOnly: false,
  }

  it('无关 scope + 语义重叠恰好 1：首轮不补位，非首轮补位（minOverlap 2 vs 1）', () => {
    const item = makeItem({ id: 'x1', key: 'rule.x', value: 'alpha only', scope: 'other-proj' })
    expect(semanticOverlap('alpha beta', item.key + ' ' + item.value)).toBe(1)
    expect(scoreItem(item, 'alpha beta', true, RRF_ENV)).toBe(0)    // 首轮：非当前工作区 scope 直接 0
    expect(scoreItem(item, 'alpha beta', false, RRF_ENV)).toBe(-2)  // 非首轮：-4 降权 + value 命中 2
    expect(pickRecallItems([item], 'alpha beta', 2, false, true, false, RRF_ENV)).toEqual([])
    expect(pickRecallItems([item], 'alpha beta', 2, false, false, false, RRF_ENV).map((i) => i.id)).toEqual(['x1'])
  })

  it('首轮补位的 RRF 排名走首轮评分：与 rrfRanking(…, false) 排名不同，且补位 slice 结果不同', () => {
    // 三条 key/value 完全相同、只有 tags 不同：tags 不进 bigram 文本，
    // 于是「首轮全部 0 分（无关 scope 早退）→ 并列按输入序」与「非首轮 0/2/4 分」的排名会翻转。
    const t = '2026-09-17T00:00:00.000Z'
    const items = [
      makeItem({ id: 'a', key: 'rule.same', value: 'alpha beta', tags: [], updatedAt: t }),
      makeItem({ id: 'b', key: 'rule.same', value: 'alpha beta', tags: ['alpha'], updatedAt: t }),
      makeItem({ id: 'c', key: 'rule.same', value: 'alpha beta', tags: ['alpha', 'beta'], updatedAt: t }),
    ].map((i) => ({ ...i, scope: 'other-proj' }))
    expect(items.map((i) => scoreItem(i, 'alpha beta', true, RRF_ENV))).toEqual([0, 0, 0])
    expect(items.map((i) => scoreItem(i, 'alpha beta', false, RRF_ENV))).toEqual([0, 2, 4])
    // rrfRanking 自身必须区分第 4 个参数
    expect(rrfRanking(items, 'alpha beta', RRF_ENV, true).map((e) => e.item.id)).toEqual(['a', 'b', 'c'])
    expect(rrfRanking(items, 'alpha beta', RRF_ENV, false).map((e) => e.item.id)).toEqual(['a', 'c', 'b'])
    // pickRecallItems 首轮补位必须把 isFirstTurn=true 透传下去：
    // 缺陷态（rrfRanking(scoped, query, env) 恒用 false）会返回 ['a','c']，与下面断言不符。
    expect(pickRecallItems(items, 'alpha beta', 2, false, true, false, RRF_ENV).map((i) => i.id)).toEqual(['a', 'b'])
    expect(pickRecallItems(items, 'alpha beta', 2, false, false, false, RRF_ENV).map((i) => i.id)).toEqual(['a', 'c'])
  })
})

// ── F1（第七轮）：渲染长度收敛的纯函数级防护 ───────────────────────────────
// 缺陷态 A：函数体退化成 `return { kept: items, text: render(items) }`（只按估算取候选、
//   不做渲染长度回退）——第一条会因 text.length 超预算而变红。
// 缺陷态 B（H1，红队实测）：超预算就整段丢弃 `if (text.length > budget) return { kept: [], text: render([]) }`。
//   B 满足旧断言的三条不变量（render([]) = 4 ≤ 60、0 < 3、text === render(kept)），
//   即「丢光」与「按需从尾部丢」不可区分——故第一条与边界用例都改成了精确条数断言。
describe('F1 fitByRenderedLength：按渲染长度收敛', () => {
  const render = (xs: string[]) => '【头】\n' + xs.map((x) => '- ' + x).join('\n')

  // render 的真实长度（每行 '- ' + 20 字 = 22，行间 '\n' 1 字，前缀 '【头】\n' = 4）：
  //   0 条 = 4 · 1 条 = 4+22 = 26 · 2 条 = 4+22+1+22 = 49 · 3 条 = 4+22+1+22+1+22 = 72
  const THREE = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)]

  it('渲染超预算时从尾部逐个丢弃，直到落进预算（且 kept 与 text 始终一致）', () => {
    const items = THREE
    // 先把 render 的长度口径钉死，下面断言里的 2 才有依据（改 render 前缀/行前缀会导致本行先红）
    expect([0, 1, 2, 3].map((n) => render(items.slice(0, n)).length)).toEqual([4, 26, 49, 72])
    const r = fitByRenderedLength(items, 60, render)
    expect(r.text.length).toBeLessThanOrEqual(60)
    // 精确值（替代旧断言 r.kept.length < items.length）：72 > 60 → 丢 1 条得 49 ≤ 60 → 恰好保留 2 条。
    // 「超预算就全丢」（kept: [] → 0 < 3 且 render([]) = 4 ≤ 60）在旧断言下三条全真，在此为红。
    expect(r.kept).toHaveLength(2)
    // 顺带钉住丢弃方向：如果实现改成从头部丢（丢高分的），这里拿到 [b, c] 会红
    expect(r.kept).toEqual([items[0], items[1]])
    // 保留尽量多：不得为了「保险」多丢一条（49 而不是 26）
    expect(r.text.length).toBe(49)
    expect(r.text).toBe(render(r.kept))
  })

  it('紧预算边界：恰好放得下 2 条（49）保留 2，少 1 字（48）只保留 1', () => {
    const items = THREE
    expect(render(items.slice(0, 2)).length).toBe(49)
    expect(render(items.slice(0, 1)).length).toBe(26)
    const at49 = fitByRenderedLength(items, 49, render)
    expect(at49.text.length).toBeLessThanOrEqual(49)
    expect(at49.kept).toHaveLength(2)                  // 49 ≤ 49：一条都不多丢
    expect(at49.kept).toEqual([items[0], items[1]])
    expect(at49.text).toBe(render(at49.kept))
    const at48 = fitByRenderedLength(items, 48, render)
    expect(at48.text.length).toBeLessThanOrEqual(48)
    expect(at48.kept).toHaveLength(1)                  // 49 > 48：再丢一条 → 26 ≤ 48
    expect(at48.kept).toEqual([items[0]])
    expect(at48.text).toBe(render(at48.kept))
    // 压到「空渲染刚好放得下」（budget = render([]) = 4）：必须收在 0 条，不能因循环条件写成
    // kept.length > 1 而残留 1 条（26 > 4，等于击穿预算）
    const at4 = fitByRenderedLength(items, 4, render)
    expect(at4.kept).toHaveLength(0)
    expect(at4.text).toBe(render([]))
  })

  it('单条就超预算 → 丢到空，而不是保留一条', () => {
    const r = fitByRenderedLength(['x'.repeat(200)], 50, render)
    expect(r.kept).toHaveLength(0)
    expect(r.text).toBe(render([]))
  })

  // 紧预算的对照组：本用例 budget = 10000，只覆盖「宽预算世界」——无论实现是
  // 「超预算全丢」、「按估算截断」还是「按需从尾部丢」，宽预算下都恒为 3 条全留，因此它
  // 单独不能证明收敛逻辑正确；紧预算口径由上面两条（60 / 49 / 48 / 4）钉住。
  it('反向对照：预算充足时一项不丢（证明不是一律丢）', () => {
    const items = ['aa', 'bb', 'cc']
    const r = fitByRenderedLength(items, 10_000, render)
    expect(r.kept).toHaveLength(3)
    expect(r.text).toBe(render(items))
  })
})

// ── F7（第七轮）：undefined = 不改动，[] = 清空 ─────────────────────────────
// 缺陷态：`links.length ? links : prev.links` —— 传空数组被当成「没传」，模型删不掉错标的 tag。
describe('F7 tags/links：undefined 表示不改动，空数组表示清空', () => {
  const input = (o: Partial<UpsertInput> = {}): UpsertInput => ({
    key: 'rule.k', value: 'V', scope: 'global',
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    source: '测试', explicitSource: false, ...o,
  })

  it('传空数组清空旧 tags/links，并判为有变化', () => {
    const items = [makeItem({ key: 'rule.k', value: 'V', tags: ['a'], links: ['x'] })]
    const r = upsertMemory(items, input({ tags: [], links: [] }), { dedupe: false, makeId: () => 'n' })
    expect(r.changed).toBe(true)
    expect(items[0].tags).toEqual([])
    expect(items[0].links).toEqual([])
  })

  it('不传则保留旧值，且判为空操作', () => {
    const items = [makeItem({ key: 'rule.k', value: 'V', tags: ['a'], links: ['x'] })]
    const r = upsertMemory(items, input(), { dedupe: false, makeId: () => 'n' })
    expect(r.changed).toBe(false)
    expect(items[0].tags).toEqual(['a'])
    expect(items[0].links).toEqual(['x'])
  })

  it('反向对照：传新值替换而不是追加', () => {
    const items = [makeItem({ key: 'rule.k', value: 'V', tags: ['a'], links: ['x'] })]
    upsertMemory(items, input({ tags: ['b'] }), { dedupe: false, makeId: () => 'n' })
    expect(items[0].tags).toEqual(['b'])
    expect(items[0].links).toEqual(['x'])   // 没传 links → 不动
  })
})
