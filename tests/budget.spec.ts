import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync as writeFs } from 'node:fs'
import { join } from 'node:path'
import { apply, Config } from '../src/index'
import { cleanTempDir, findPluginMessages, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// M11：会话级总注入预算（教训/召回/索引串行分配；第六轮起守则不计入）+ 守则只保留完整版

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

function seedItems(extra: unknown[] = []) {
  const now = '2026-09-17T00:00:00.000Z'
  return [
    // 教训通道：rule.*（悔恨/场景信号命中）
    { id: 'l1', key: 'rule.powershell-encoding', value: 'PowerShell 写中文加 -Encoding UTF8。Why: 不指定会乱码。', scope: 'global', tags: ['powershell'], createdAt: now, updatedAt: now },
    { id: 'l2', key: 'rule.path-quoting', value: '路径带空格要加引号。Why: pwsh 会截断参数。', scope: 'global', tags: ['路径'], createdAt: now, updatedAt: now },
    // 召回通道：与 query 词法命中但不是 lesson-like
    { id: 'r1', key: 'env.node-version', value: '本机 Node v26.8.1，装在 D:\\NODE', scope: 'global', tags: [], createdAt: now, updatedAt: now },
    { id: 'r2', key: 'env.python-path', value: 'python 在 D:\\Python312', scope: 'global', tags: [], createdAt: now, updatedAt: now },
    ...extra,
  ]
}

function setup(config: Record<string, unknown> = {}, seed?: unknown[]) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  if (seed) writeFs(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoCapture: true, autoRecall: true, autoRecallRerank: false, autoExtract: false, ...config })
  return { fake, dir }
}

function payload(sid: string, text: string) {
  return {
    agent: { session: { id: sid, header: { delegationDepth: 0 }, surface: undefined, events: undefined }, options: { subagentDepth: 0 } },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    step: 1,
    signal: undefined,
  }
}

function pluginTextLength(decision: any): number {
  return (decision?.messages ?? [])
    .filter((m: any) => m?.source?.kind === 'plugin' && m?.source?.plugin === '@dsh-external/dsh-persistent-memory')
    .reduce((n: number, m: any) => n + (m.content?.[0]?.text?.length ?? 0), 0)
}

/** 除守则外的注入长度（教训+召回+索引）。
 *  第六轮起守则不再计入 injectionBudgetChars——它是每会话固定成本，
 *  占额度只会让大守则静默挤掉记忆通道（实测 3049 字守则曾把 1200 预算吃成负数）。 */
function memoryTextLength(decision: any): number {
  return (decision?.messages ?? [])
    .filter((m: any) => m?.source?.kind === 'plugin'
      && m?.source?.plugin === '@dsh-external/dsh-persistent-memory'
      && m?.source?.form !== 'memory-capture-guide'
      && m?.source?.form !== 'memory-capture-guide-subagent')
    .reduce((n: number, m: any) => n + (m.content?.[0]?.text?.length ?? 0), 0)
}

describe('M11 会话级总注入预算', () => {
  it('守则不计预算：同轮命中教训/召回时，记忆通道总长 ≤ injectionBudgetChars', async () => {
    const { fake } = setup({ injectionBudgetChars: 500 }, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-b1', '又错了，powershell 路径还是不对，node 版本也看下'))
    const forms = (d?.messages ?? []).filter((m: any) => m?.source?.plugin === '@dsh-external/dsh-persistent-memory').map((m: any) => m.source.form)
    expect(forms).toContain('memory-capture-guide')
    expect(memoryTextLength(d)).toBeLessThanOrEqual(500)
  })

  it('预算紧张时守则照常注入，记忆通道按剩余额度裁剪', async () => {
    // 守则每会话固定注入、不受预算约束（第六轮起也不占额度）；
    // injectionBudgetChars 只约束教训/召回/索引。
    const { fake } = setup({ injectionBudgetChars: 300 }, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-b2', '又错了，powershell 路径还是不对，node 版本也看下'))
    const guide = findPluginMessages(d, 'memory-capture-guide')[0]
    expect(guide).toBeTruthy()
    expect(guide.content[0].text.length).toBeGreaterThan(1500)   // 完整守则
    expect(memoryTextLength(d)).toBeLessThanOrEqual(300)
  })

  it('默认预算 1200 时不会无故砍掉单条召回', async () => {
    const { fake } = setup({}, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-b3', 'env.node-version'))   // key 直中（首轮阈值 6 需要 key 命中）
    const recall = findPluginMessages(d, 'memory-recall')
    expect(recall.length).toBeGreaterThanOrEqual(1)
    expect(memoryTextLength(d)).toBeLessThanOrEqual(1200)
  })
})

// ── M11 收口（第六轮）：包装开销必须计入预算 ──────────────────────────
// 修复前 fitBudget 用估算 used（value+key+64）扣减，不含通道标题与行前缀等包装：
// 当时实测「守则 265 + 教训 192 + 索引 91 = 548 > 预算 500」，索引据虚高余额挤入。
// 本轮起守则移出预算体系，下面的断言只针对记忆通道。
describe('M11 收口：真实渲染长度计入会话级预算', () => {
  it('预算取下限 300：教训按真实渲染长度吃满额度，91 字的索引被正确拒绝', async () => {
    // 注：injectionBudgetChars 下限为 300（Math.max(300, …)），传更小的值会被静默提升。
    const { fake } = setup({ injectionBudgetChars: 300 }, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-f1', '又错了，powershell 路径还是不对，node 版本也看下'))
    expect(memoryTextLength(d)).toBeLessThanOrEqual(300)
    expect(findPluginMessages(d, 'memory-lesson').length).toBeGreaterThan(0)   // 教训（255 字）进得来
    expect(findPluginMessages(d, 'memory-index')).toHaveLength(0)              // 索引（91 字）装不下剩余 45
  })

  it('多档预算扫描：除守则自身外，注入总长不越界', async () => {
    for (const b of [300, 400, 500, 600, 800, 1200]) {
      const { fake } = setup({ injectionBudgetChars: b }, seedItems())
      const d = await runPreStep(fake.handlers, payload('sess-scan-' + b, '又错了，powershell 路径还是不对，node 版本也看下'))
      // 守则不计入预算，因此断言的是记忆通道总长 ≤ 预算——
      // 守则再长也不会挤压记忆（这正是本轮修掉的耦合）。
      const memLen = memoryTextLength(d)
      expect(memLen, 'budget=' + b).toBeLessThanOrEqual(b)
      // 反向断言：预算 ≥300 时记忆通道必须真的注入了东西，
      // 否则「0 ≤ b」会让耦合回归时静默通过。
      expect(memLen, 'budget=' + b + ' 应有注入').toBeGreaterThan(0)
    }
  })

  it('对照组：预算充足且无召回命中时，索引照常注入（证明不是一律不注）', async () => {
    const { fake } = setup({ injectionBudgetChars: 1200 }, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-f2', '你好'))
    expect(memoryTextLength(d)).toBeLessThanOrEqual(1200)
    expect(findPluginMessages(d, 'memory-index').length).toBeGreaterThan(0)
  })
})

describe('守则：只保留完整版（第六轮删除 brief）', () => {
  it('默认即注入完整守则（>1500 字）', async () => {
    const { fake } = setup({}, [])
    const d = await runPreStep(fake.handlers, payload('sess-g1', '你好'))
    const text = findPluginMessages(d, 'memory-capture-guide')[0].content[0].text as string
    expect(text.length).toBeGreaterThan(1500)
    expect(text).toContain('记忆使用守则')
    // 空库 → 除守则外无任何注入，总长即守则长度
    expect(pluginTextLength(d)).toBe(text.length)
  })

  it('已删除的 autoCaptureDetail 不再影响行为（传 brief 仍注入完整版，且不报错）', async () => {
    const { fake } = setup({ autoCaptureDetail: 'brief' }, [])
    const d = await runPreStep(fake.handlers, payload('sess-g2', '你好'))
    const text = findPluginMessages(d, 'memory-capture-guide')[0].content[0].text as string
    expect(text.length).toBeGreaterThan(1500)
    expect(text).toContain('记忆使用守则')
  })
})

// ── F1（第七轮）：把「按渲染后真实长度收敛」做成可证伪的回归防护 ──────────────
// 缺陷态是「按 fitBudget 的估算 used 扣减」：估算 = min(value,160)+key+64，不含通道标题
// （召回 9 字）与「· 自<source>」等包装。下面的 fixture 特意落在「估算放得下、
// 渲染放不下」的窗口里，因此缺陷态会真的把超出单通道额度的内容注进去。
//
// 窗口的两个数（对照 src/recall.ts 的 fitBudget 与 src/index.ts 的 formatRecall）：
//   估算 cost = min(value,160) + key.length + 64 = 26 + 16 + 64 = 106 ≤ 120
//   渲染长度  = 标题 9 + '- [global/' 8 + key 16 + ' · ' 3 + 龄标签「今天」2 + '] ' 2
//             + value 26 + ' · 自' 4 + source 66 = 138 > 120
// **source 必带且够长**：它只出现在渲染的行前缀里、完全不进估算，是把渲染顶到单通道额度
// 之上的主要放大项。第八轮之前这里靠「>1 天的时点观察」警告凑长度——那是墙钟依赖：警告一
// 停渲染就掉回 92 ≤ 120，缺陷态也能绿，用例永久失效。现在 updatedAt 取「现在」，与日历无关。
const WINDOW_SOURCE = '2026-09-21 s=sess-f7 · 手工登记：本机 Node 版本号与安装盘符（用户口述后登记，非自动提取，路径原样保留）'

function seedWithSource(): unknown[] {
  // 全部条目统一取「现在」：龄标签恒为「今天」（2 字），mergedDriftNote 只对 >1 天的条目
  // 生效、恒返回空串；索引分组的排序也维持原来「所有条目同一时刻」的口径（并列 → 原序）。
  const now = new Date().toISOString()
  return seedItems().map((s: any) => (s.id === 'r1'
    ? { ...s, source: WINDOW_SOURCE, createdAt: now, updatedAt: now }
    : { ...s, createdAt: now, updatedAt: now }))
}

describe('F1 渲染长度收敛（M11 收口的可证伪保护）', () => {
  it('单通道额度 120：估算 106 放得下、渲染 138 放不下时，召回项必须被丢弃', async () => {
    const { fake } = setup({ injectionBudgetChars: 300, autoRecallBudgetChars: 120 }, seedWithSource())
    const d = await runPreStep(fake.handlers, payload('sess-f7', 'env.node-version'))
    for (const m of findPluginMessages(d, 'memory-recall')) {
      expect((m as any).content[0].text.length, '召回通道渲染长度必须 ≤ autoRecallBudgetChars').toBeLessThanOrEqual(120)
    }
    // 修复态下上面的循环是**空的**（唯一候选 138 > 120 被整条丢弃），空循环恒真——
    // 下面三条才是这条用例真正的判据（H2：补「裁决确实发生过」的正向锚）。
    // ① 越界项确实被裁决掉，而不是「碰巧没命中」：
    expect(findPluginMessages(d, 'memory-recall'), '138 > 120 的召回必须被丢弃，而不是越界注入').toHaveLength(0)
    // ② 召回被丢空 → recallEmpty=true → 索引兜底必须补位注入（实测 99 字 ≤ 剩余 300）。
    //    缺陷态会注入这条 138 字的召回 → recallEmpty=false → 索引不注入 → 这里红。
    expect(findPluginMessages(d, 'memory-index').length, '召回被丢弃后必须有索引兜底，证明裁决真的发生过').toBeGreaterThan(0)
    // ③ 该会话的记忆通道不能是零注入。
    expect(memoryTextLength(d), '该会话记忆通道应有注入').toBeGreaterThan(0)
    expect(memoryTextLength(d)).toBeLessThanOrEqual(300)   // 总预算仍未越界
  })

  it('对照组：同一 fixture 把额度放到 200，召回照常注入（证明上一条不是「一律不注」）', async () => {
    const seed = seedWithSource()
    const { fake } = setup({ injectionBudgetChars: 300, autoRecallBudgetChars: 200 }, seed)
    const d = await runPreStep(fake.handlers, payload('sess-f8', 'env.node-version'))
    const msgs = findPluginMessages(d, 'memory-recall')
    expect(msgs.length, '额度 200 时这条召回必须注入，否则上一条只是空循环').toBeGreaterThan(0)
    const text = (msgs[0] as any).content[0].text as string
    expect(text.length).toBeLessThanOrEqual(200)
    // fixture 有效性自检（照抄 F1-b 的做法）：渲染长度必须仍然 > 120。包装被改短到 ≤120 时
    // 窗口消失、上一条退化成恒真——那时这里要红，提示重算 fixture。
    expect(text.length, 'fixture 必须仍在「估算放得下、渲染放不下」的窗口里').toBeGreaterThan(120)
    // 并且必须脱离墙钟：龄标签恒为「今天」，不出现「时点观察」漂移警告。
    expect(text, 'fixture 的龄标签必须是「今天」').toContain('· 今天 ·')
    expect(text, 'fixture 不得靠 >1 天的漂移警告撑长度（墙钟依赖）').not.toContain('时点观察')
    // 窗口的另一半：估算必须仍 ≤ 120（公式对照 src/recall.ts fitBudget 的 cost）。
    const item: any = (seed as any[]).find((s: any) => s.id === 'r1')
    expect(Math.min(item.value.length, 160) + item.key.length + 64, 'fixture 的估算必须 ≤ 120，否则窗口不成立').toBeLessThanOrEqual(120)
  })
})

// ── F1-b（第八轮）：教训通道的同一收口也必须可证伪 ──────────────────────────
// F1 的 fixture（seedWithSource + 'env.node-version'）只覆盖**召回**通道：把教训通道改回
// 「fitBudget(...).used 估算扣减」后，整个 budget.spec.ts 曾 11 passed 全绿——教训通道的
// 接线当时不可证伪。下面这条 fixture 专门落在教训通道的同一个窗口里。
//
// 窗口是怎么来的（对照 src/index.ts 的 formatLesson 与 src/recall.ts 的 fitBudget）：
//   估算 cost   = min(sanitize(value),160) + key.length + 64 = 64 + 20 + 28 = 112  ≤ 120
//   渲染长度    = 标题 36 + '\n' + 行(90)                    = 127                > 120
//   行 = `- [global/${key} · 今天 · 自${source}] ${value}`，其中「 · 自2026-09-17 s=sess-f9a」
//   这 25 字包装在估算里完全不存在——这正是「估算放得下、渲染放不下」的来源。
// **source 必带**：不带 source 时行前缀更短，渲染会落回估算之下，窗口消失。
function seedLessonWindow(): unknown[] {
  const now = new Date().toISOString()   // 龄标签固定为「今天」（2 字），且不触发时点观察警告
  return [
    {
      id: 'lw1',
      key: 'rule.pwsh-quote-path',
      value: 'pwsh 下路径含空格必须加英文引号，否则参数会被截断。',
      scope: 'global',
      tags: ['powershell'],
      source: '2026-09-17 s=sess-f9a',
      createdAt: now,
      updatedAt: now,
    },
  ]
}

describe('F1-b 教训通道同样按渲染长度收敛（估算扣减必须能被证伪）', () => {
  // 触发条件：payload 同时命中 regretSignal（又…错）与 ruleScene（路径 / powershell），
  // 条目是 rule.* 且 tags 含 powershell → pickLessonItems 的 bonus 10 + 6，必然被选中。
  const LESSON_QUERY = '又错了，powershell 路径还是不对，node 版本也看下'

  it('单通道额度 120：估算 112 放得下、渲染 127 放不下时，教训必须被丢弃而不是越界注入', async () => {
    // 缺陷态（教训通道改回 fitBudget(...).used 估算扣减）不会做渲染收敛，
    // 会把这条 127 字的教训整段注进去 → 下面的断言拿到 127 > 120，本条变红。
    const { fake } = setup({ injectionBudgetChars: 300, autoRecallBudgetChars: 120 }, seedLessonWindow())
    const d = await runPreStep(fake.handlers, payload('sess-f9', LESSON_QUERY))
    // 修复态下这条循环是**空的**（单条 127 > 120 → 整条被丢弃），空循环恒真——
    // 所以非空性由下一条反向对照用例负责，两条合起来才是可证伪的。
    for (const m of findPluginMessages(d, 'memory-lesson')) {
      expect((m as any).content[0].text.length, '教训通道渲染长度必须 ≤ autoRecallBudgetChars').toBeLessThanOrEqual(120)
    }
  })

  it('反向对照：同一 fixture 把额度放到 200，教训确实注入（防止上一条是「一条都没进来」的空循环）', async () => {
    const { fake } = setup({ injectionBudgetChars: 300, autoRecallBudgetChars: 200 }, seedLessonWindow())
    const d = await runPreStep(fake.handlers, payload('sess-f10', LESSON_QUERY))
    const msgs = findPluginMessages(d, 'memory-lesson')
    expect(msgs.length, '额度 200 时这条教训必须注入，否则上一条只是空循环').toBeGreaterThan(0)
    for (const m of msgs) {
      expect((m as any).content[0].text.length).toBeLessThanOrEqual(200)
    }
    // fixture 有效性自检：这条教训的真实渲染长度必须仍然 > 120（实测 127）。
    // 若渲染格式被改短到 ≤120，上一条用例就退化成恒真——那时这里要红，提示换 fixture。
    expect((msgs[0] as any).content[0].text.length, 'fixture 必须仍在「估算放得下、渲染放不下」的窗口里').toBeGreaterThan(120)
  })
})

// ── F4（第七轮）：删掉的配置项必须在 schema 层也被容忍 ──────────────────────
describe('F4 已删除的 autoCaptureDetail 在 Config schema 层被容忍', () => {
  it('schemastery 对未声明键 pass-through：旧 cordis.yml 不会因校验失败而崩', () => {
    // 修复前这条用例只把裸对象传给 apply()，绕过了 Config —— 它证明的是「apply 忽略该字段」，
    // 而不是「旧配置能被 schema 接受」。schemastery 3.18.2 的 object 对未声明键保留且不报错。
    expect(() => (Config as any)({ autoCapture: true, autoCaptureDetail: 'brief' })).not.toThrow()
    expect((Config as any)({ autoCapture: true, autoCaptureDetail: 'brief' }).autoCapture).toBe(true)
  })

  it('Config 仍在做类型校验：声明字段收到错类型必须抛 ValidationError（防 schema 被换成 z.any()）', () => {
    // 负向锚（红队 H3）：把 Config 里所有字段换成 z.any()（键名一个不少）时，上面那条
    // pass-through 用例依然全绿——它只证明了「未声明键被放行」，证明不了 schema 在校验类型。
    // 实测 schemastery 3.18.2（只读 node 探针，输出见交付报告）：z.number()/z.boolean()/
    // z.array() 收到错类型一律抛 ValidationError（"$.<字段> expected <type> but got <值>"），
    // 既不静默回退默认值、也不原样放行；只有 null/undefined 才走 .default() 回退。
    // 而 z.any() 变异体会把 'abc' 原样放行 → 下面三条立刻变红。
    expect(() => (Config as any)({ injectionBudgetChars: 'abc' }), 'number 字段收到字符串必须抛').toThrow(/injectionBudgetChars/)
    expect(() => (Config as any)({ autoRecall: 'yes' }), 'boolean 字段收到字符串必须抛').toThrow(/autoRecall/)
    expect(() => (Config as any)({ importAllowRoots: 'x' }), 'array 字段收到字符串必须抛').toThrow(/importAllowRoots/)
    // 对照组：合法输入不抛且值原样保留——证明上面的 toThrow 不是「凡输入必抛」。
    expect(() => (Config as any)({ injectionBudgetChars: 500 })).not.toThrow()
    expect((Config as any)({ injectionBudgetChars: 500 }).injectionBudgetChars).toBe(500)
  })
})
