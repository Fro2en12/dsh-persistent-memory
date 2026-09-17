import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync as writeFs } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, findPluginMessages, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// M11：会话级总注入预算（守则/教训/召回/索引串行分配）+ 守则默认 brief

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

describe('M11 会话级总注入预算', () => {
  it('守则+教训+召回同轮命中时，plugin 消息总长 ≤ injectionBudgetChars', async () => {
    const { fake } = setup({ injectionBudgetChars: 500 }, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-b1', '又错了，powershell 路径还是不对，node 版本也看下'))
    const forms = (d?.messages ?? []).filter((m: any) => m?.source?.plugin === '@dsh-external/dsh-persistent-memory').map((m: any) => m.source.form)
    expect(forms).toContain('memory-capture-guide')
    expect(pluginTextLength(d)).toBeLessThanOrEqual(500)
  })

  it('预算紧张时优先级：守则 > 教训 > 召回', async () => {
    // 守则是静态文案（brief 约 350 字），优先级最高、永不被预算砍；
    // 剩余预算不足时教训/召回被挤掉，而不是反过来砍守则。
    const { fake } = setup({ injectionBudgetChars: 300, autoCaptureDetail: 'brief' }, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-b2', '又错了，powershell 路径还是不对，node 版本也看下'))
    const guide = findPluginMessages(d, 'memory-capture-guide')[0]
    expect(guide).toBeTruthy()
    const guideLen = guide.content[0].text.length
    expect(pluginTextLength(d)).toBe(guideLen)   // 预算不足 → 除守则外没有任何额外注入
    expect(findPluginMessages(d, 'memory-recall')).toHaveLength(0)
    expect(findPluginMessages(d, 'memory-lesson')).toHaveLength(0)
  })

  it('默认预算 1200 时不会无故砍掉单条召回', async () => {
    const { fake } = setup({}, seedItems())
    const d = await runPreStep(fake.handlers, payload('sess-b3', 'env.node-version'))   // key 直中（首轮阈值 6 需要 key 命中）
    const recall = findPluginMessages(d, 'memory-recall')
    expect(recall.length).toBeGreaterThanOrEqual(1)
    expect(pluginTextLength(d)).toBeLessThanOrEqual(1200)
  })
})

describe('M11 守则默认 brief', () => {
  it('默认配置注入精简守则（<600 字）', async () => {
    const { fake } = setup({}, [])
    const d = await runPreStep(fake.handlers, payload('sess-g1', '你好'))
    const guide = findPluginMessages(d, 'memory-capture-guide')[0]
    const text = guide.content[0].text as string
    expect(text.length).toBeLessThan(600)
    expect(text).toContain('记忆守则')
  })

  it('显式 autoCaptureDetail=full 时注入完整守则（>1500 字）', async () => {
    const { fake } = setup({ autoCaptureDetail: 'full' }, [])
    const d = await runPreStep(fake.handlers, payload('sess-g2', '你好'))
    const guide = findPluginMessages(d, 'memory-capture-guide')[0]
    const text = guide.content[0].text as string
    expect(text.length).toBeGreaterThan(1500)
    expect(text).toContain('记忆使用守则')
  })
})
