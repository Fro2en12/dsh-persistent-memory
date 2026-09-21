import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// 提取器质量评测（参考 Claude Code extractMemories 的 eval 思路）：
// ① 判据契约——提示词必须含双向记录与 lesson 优先级，且不再自我劝退；
// ② 写入条数——修复前 prompt 与代码双硬上限各为 1 条，两个真实缺陷只能记下半个；
// ③ 守则内容契约——小节结构 / 正文厚度 / 信号→动作 / 责任归属（唯一归口见文件末尾 describe 注释）。

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待异步提取落盘：全量并行时机器更慢，固定 sleep 会 flaky。
 *  超时即抛错（带实际条数）——静默返回会把「提取器根本没写出来」伪装成后面的断言失败。 */
async function waitItems(dir: string, min: number, ms = 3000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const n = readStore(dir).length
    if (n >= min) return
    if (Date.now() - t0 > ms) throw new Error(`waitItems 超时 ${ms}ms：期望 ≥${min} 条，实际 ${n} 条`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

function setupExtract(llmJson: string) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const seen: Array<{ system: string }> = []
  const fake = makeFakeCtx({}, {
    llm: {
      stream: async function* (req: any) {
        seen.push({ system: String(req?.system ?? '') })
        yield { type: 'text-delta', text: llmJson }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  apply(fake.ctx, {
    dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false,
    autoExtract: true, autoExtractCooldownMs: 30000,
  })
  return { fake, seen, dir }
}

function feedTurn(fake: any, sid: string, text: string) {
  const session = { id: sid }
  const onEvent = fake.handlers.get('session/event')[0]
  const onTurn = fake.handlers.get('agent/turn-stopping')[0]
  onEvent(session, { type: 'turn/start' })
  onEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text }] } })
  onTurn({ agent: { session: { id: sid, header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } })
}

function readStore(dir: string): any[] {
  try {
    return readFileSync(join(dir, 'memory.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      // 首行是 schema 标记 {"__schema":1}，不是记忆条目
      .filter((o) => o && typeof o === 'object' && typeof o.key === 'string')
  } catch { return [] }
}

const DIALOGUE = '又踩坑了：vitest 里正则字面量经 oxc 转换后匹配失效，改成 new RegExp 才正常'

describe('提取器判据契约（防回归）', () => {
  it('系统提示含双向记录与 lesson 优先级，且不再出现自我劝退措辞', async () => {
    const { fake, seen } = setupExtract('{"memories":[]}')
    feedTurn(fake, 'q1', DIALOGUE)
    await tick()
    expect(seen.length).toBe(1)
    const sys = seen[0].system
    expect(sys).toContain('失败与成功都要记')
    expect(sys).toContain('lesson.*')
    expect(sys).toContain('优先检查')
    expect(sys).toContain('最多 3 条')
    expect(sys).not.toContain('宁缺毋滥')
    expect(sys).not.toContain('最多 1 条')
  })
})

describe('提取器写入条数（上限 1 → 3）', () => {
  it('返回 3 条 → 全部写入（修复前硬上限 1 条，只会落 1 条）', async () => {
    const json = JSON.stringify({
      memories: [
        { key: 'lesson.vitest-oxc-regex', value: 'vitest 正则字面量经 oxc 转换后匹配失效。Why: 转义被改写。How to apply: 改用 new RegExp。', tags: ['vitest'] },
        { key: 'env.node-bin', value: 'Node 装在 D:\\NODE。Why: 自定义路径。', tags: [] },
        { key: 'rule.report-format', value: '报告先给结论再给证据。Why: 用户要求。', tags: [] },
      ],
    })
    const { fake, dir } = setupExtract(json)
    feedTurn(fake, 'q2', DIALOGUE)
    await waitItems(dir, 3)
    expect(readStore(dir).length).toBe(3)
  })

  it('返回 5 条 → 只落前 3 条（上限仍是 3，不是无限）', async () => {
    const mk = (i: number) => ({ key: 'lesson.k' + i, value: '第 ' + i + ' 条说明。Why: 上限测试。', tags: [] })
    const json = JSON.stringify({ memories: [1, 2, 3, 4, 5].map(mk) })
    const { fake, dir } = setupExtract(json)
    feedTurn(fake, 'q3', DIALOGUE)
    await waitItems(dir, 3)
    expect(readStore(dir).length).toBe(3)
  })

  it('对照组：返回空 → 不落任何条目（证明写入来自提取结果）', async () => {
    const { fake, dir } = setupExtract('{"memories":[]}')
    feedTurn(fake, 'q4', DIALOGUE)
    await tick()
    expect(readStore(dir).length).toBe(0)
  })
})

// ── 守则内容契约的唯一归口是本文件（第七轮审查） ───────────────────────────
// tests/budget.spec.ts 的「守则：只保留完整版」只断言两件事：注入长度 > 1500 与
// `记忆使用守则` 存在——它管「守则有没有被注入、是不是完整版」，**不管守则里写了什么**。
// 内容契约（小节存在性 / 正文厚度 / 信号→动作映射 / 责任归属）全部归口在本 describe：
// 下一轮审查若再觉得「守则内容缺覆盖」，改的是这里，不要另开文件重复一遍。
//
// 断言口径（第七轮：字面量复制 → 结构断言）：
// · 措辞不是契约——改文案不该改测试；契约是结构：小节在不在、正文有没有厚度、
//   有没有「信号 → 动作」而不是纯形容词、责任在不在主模型身上。
//   旧的 toContain('三个信号出现就写') 只能抓「有人改了措辞」，抓不到「有人删了整整一节」。
// · 第八轮补的洞：「标题在场 ≠ 内容还在」。第七轮只验标题在场 + 两节一刀切阈值，
//   标题齐全而整节正文被删光是全绿的——故本轮改成逐节正文厚度下限 + 「不要记」条目计数
//   + 「什么时候写」非空行数下限（三处取法见用例内 ②c / ③ / ③b 注释）。
// · 全用例只保留 2 条硬编码字面量断言：`memory_set`（动作落点必须指向真实工具名）
//   与负向 `你不用重复写`（防「把责任推给提取器」回归）。小节标题走 sectionOf()，
//   按结构断言计——它们是需求指定的硬结构锚点，不是文案。
describe('守则契约：结构完整性 + 责任归属（内容契约唯一归口）', () => {
  /** 取 `## <heading>` 的小节正文（到下一个 `\n## ` 为止）；标题缺失返回 null。 */
  const sectionOf = (doc: string, heading: string): string | null => {
    const at = doc.indexOf(heading)
    if (at < 0) return null
    const rest = doc.slice(at + heading.length)
    const next = rest.indexOf('\n## ')
    return next < 0 ? rest : rest.slice(0, next)
  }

  it('注入完整守则：硬结构小节齐全、正文有实质厚度、信号指向写入动作、责任在主模型', async () => {
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const fake = makeFakeCtx()
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: true, autoExtract: false })
    const decision = await runPreStep(fake.handlers, {
      agent: { session: { id: 'g1', header: { delegationDepth: 0 }, surface: undefined, events: undefined }, options: { subagentDepth: 0 } },
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      step: 1,
      signal: undefined,
    })
    const guide = (decision?.messages ?? []).find((m: any) => m?.source?.form === 'memory-capture-guide')
    expect(guide).toBeTruthy()
    const text = String(guide.content[0].text)

    // ① 只保留完整版：完整版 7 个 `## ` 小节、约 3k 字；子代理版 0 个小节、约 300 字。
    //    用「小节数 + 总长」两条结构证据替代「有没有某句文案」，砍成 brief 或注入成子代理版都会红。
    //    小节数按实测 7 收紧（旧值 5 是「完整版有多个小节」的松口径）：多出小节不影响，短成 brief 版必红。
    expect((text.match(/^## /gm) ?? []).length, '完整版应有 7 个 `## ` 小节').toBeGreaterThanOrEqual(7)
    expect(text.length, '完整守则总长（完整版 ≈3k，brief 版量级远低于 1500）').toBeGreaterThan(1500)

    // ② 硬结构：两个小节标题必须同时存在——这是契约，不是措辞。
    const writeBody = sectionOf(text, '## 什么时候写')
    const skipBody = sectionOf(text, '## 不要记')
    expect(writeBody, '缺 `## 什么时候写` 小节（硬结构，非措辞）').not.toBeNull()
    expect(skipBody, '缺 `## 不要记` 小节（硬结构，非措辞）').not.toBeNull()

    // ②b 七个小节必须全部在场：只锁其中两个时，整节删除检测不到——实测删掉「分类」（674 字）
    //    加「硬闸门」（350 字）共 1024 字（占全文 33%）后，`>1500` 与旧的 `≥5 小节` 两条断言仍然全绿。
    //    按前缀匹配标题，措辞微调（如括号里的补充说明）不影响，整节消失必红。
    //    ⚠ 标题在场 ≠ 内容还在：只删正文、留下标题时这一组断言一条都不会红——正文厚度下限见 ②c。
    const headings = (text.match(/^## .+$/gm) ?? []).map((h) => h.trim())
    for (const h of ['## 什么时候查', '## 什么时候写', '## 怎么写', '## 分类', '## 不要记', '## 记忆会过期', '## 硬闸门']) {
      expect(headings.some((x) => x.startsWith(h)), `缺小节「${h}」——结构契约要求七个小节全部在场`).toBe(true)
    }

    // ②c 逐节正文厚度下限（第八轮补的洞：「标题在场 ≠ 内容还在」）。
    //     旧写法只给「什么时候写」>200 / 「不要记」>120 两条一刀切阈值，红队实测两个漏洞都穿得过去：
    //     漏洞 A——「分类（key 前缀 → 记什么）」整节正文（674 字）删光只留标题：标题仍在场 ✓、`^## ` 仍 7 ✓、
    //       总长仍远超 1500 ✓ → 全绿，而守则丢掉了「什么前缀记什么」这个核心分类契约；
    //     漏洞 B——「什么时候写」删两行（90 字）后 244 > 200 仍绿；「不要记」删掉三条禁止项（剩 2 条）后 149 > 120 仍绿。
    //     取法：下限 = 实测正文长度 × ≈0.6，向下取整到整十——容忍四成改写（改措辞 ±10% 量级打不穿），
    //     但不允许丢掉近半内容；「只剩标题」= 0 字必红。
    //     实测值取自 0.1.26 完整守则（本用例注入形态，无 sessionQuery → 守则不含 recall 行；全文 3066 字，
    //     与 src/index.ts 里「完整守则 3066 字」的注释一致），逐节实测：
    //     什么时候查 296 / 什么时候写 334 / 怎么写 597 / 分类 674 / 不要记 305 / 记忆会过期 257 / 硬闸门 350。
    //     两处偏离 0.6 规则的理由：
    //     ·「什么时候写」按 0.6 算是 200——正好放过漏洞 B 的 244 字，故上调到 250（实测的 75%）把它截住；
    //       同时仍有 84 字余量，上一档 ±10% 措辞波动（≈300 字）不会误红。
    //     ·「硬闸门」正文含 KEY_PREFIX_LIST 与 valueMaxChars 两处插值（≈60 字），代码改前缀清单/长度上限时
    //       该节长度会自然漂移，故下限取 200（实测 350 的 57%，比 0.6 规则更松）避免把正常改动判红。
    const SECTION_FLOOR: Array<[string, number, number]> = [
      // [小节标题（前缀匹配，与 ②b 同一口径）, 0.1.26 实测正文长度, 下限]
      ['## 什么时候查', 296, 180],
      ['## 什么时候写', 334, 250],
      ['## 怎么写', 597, 350],
      ['## 分类', 674, 400],
      ['## 不要记', 305, 200],
      ['## 记忆会过期', 257, 150],
      ['## 硬闸门', 350, 200],
    ]
    for (const [heading, measured, floor] of SECTION_FLOOR) {
      const body = (sectionOf(text, heading) ?? '').trim()
      expect(
        body.length,
        `「${heading}」正文只有 ${body.length} 字（0.1.26 实测 ${measured}，下限 ${floor}）——整节正文被掏空、只剩标题`,
      ).toBeGreaterThanOrEqual(floor)
    }

    // ③ 条目计数：厚度不等于条目还在。「不要记」是 1. … 5. 编号列表，5 条各管一类
    //    （可推断的内容 / 知识库已写的 / 修复配方 / 临时状态 / 密钥原文），正文自己也说「这五条」。
    //    旧断言只有 >120 字：删掉 3 条（剩 2 条、149 字）照样绿；这里直接数编号条目——删掉任意 1 条即红。
    //    实测（0.1.26）= 5 条，与正文自述「这五条」一致；编号列表被改成无序 `- ` 列表时也会红（口径变更是契约变更）。
    const skipItems = ((skipBody ?? '').match(/^\d\. /gm) ?? []).length
    expect(skipItems, `「不要记」的编号禁止项有 ${skipItems} 条（契约 5 条：删掉任意 1 条即红）`).toBe(5)

    // ③b 「什么时候写」非空行数下限：该节实测 5 行（信号清单 / 三条判据 / 结论责任归属 / 流水账处理 / 条数上限）。
    //     下限 4 的取法：删两行 → 3 < 4 必红（红队漏洞 B 就是删两行）；留 1 行余量，容忍「两行合并成一行」的排版改写。
    //     与 ②c 的长度下限互补：行数兜「删两行（不管删的是哪两行）」，长度兜「近半内容被掏空」。
    const writeLines = (writeBody ?? '').trim().split('\n').filter((l) => l.trim().length > 0).length
    expect(
      writeLines,
      `「什么时候写」只剩 ${writeLines} 个非空行（实测 5 行，下限 4）——触发信号/判据被整行删掉`,
    ).toBeGreaterThanOrEqual(4)

    // ④ 至少一条「信号 → 动作」映射（防「整段只剩形容词」）：信号侧与动作侧都必须落在
    //    这一小节内。0.1.26 之前该小节只有「写」这个动作本身、不含工具名（守则自己的
    //    「动作映射」判据不成立），本轮在守则里补上 `memory_set` 后，两侧同节断言才成立——
    //    把小节里的工具名删掉、或把信号措辞改成形容词，都会红。
    expect(writeBody ?? '', '「什么时候写」缺具体信号措辞（只剩形容词）').toMatch(/用户明确说/)
    expect(writeBody ?? '', '「什么时候写」没有把「写」落到 memory_set 工具名上').toContain('memory_set')

    // ⑤ 责任归属：写入责任在主模型，而不是推给后台提取器（措辞可换，语义不能丢）。
    expect(writeBody ?? '', '「什么时候写」没有把写入责任交给主模型').toMatch(/你是记录的主力|本轮结论由你写/)

    // ⑥ 回归护栏：不得出现旧口径「把责任推给提取器」。
    expect(text).not.toContain('你不用重复写')
  })
})
