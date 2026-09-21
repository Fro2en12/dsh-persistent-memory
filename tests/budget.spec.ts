import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync as writeFs } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
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
