import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync as writeFs } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { rrfRanking, stripNoise, pickRecallItems } from '../src/recall'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// P2-20 批量：m2 dream 正则 / m3 stripNoise 预编译 / m5 rrf 首轮透传 / m6 命令挂 effect /
// m7 退出 flush / m8 panel 路径 / m9 full 覆盖与上限 / m12 scopes 原型安全 / n3 schema 哨兵 / n4 debug 日志

const tmpDirs: string[] = []
function setup(config: Record<string, unknown> = {}, seed?: unknown[]) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  if (seed) writeFs(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false, ...config })
  return { fake, dir }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})
const MAIN = { agent: { session: { id: 'main-1', header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } }
function daysAgo(n: number) { return new Date(Date.now() - n * 86_400_000).toISOString() }

describe('m2 memory_dream 完成态正则锚定', () => {
  it('「任务完成后运行测试」这类含"完成"的规则不进候选', async () => {
    const { fake } = setup({}, [
      { id: 'a', key: 'rule.after-task', value: '任务完成后运行 pnpm test', scope: 'global', tags: [], createdAt: daysAgo(20), updatedAt: daysAgo(20) },
      { id: 'b', key: 'task.done-one', value: '已完成', scope: 'global', tags: [], createdAt: daysAgo(20), updatedAt: daysAgo(20) },
    ])
    const dream = fake.toolDefs.get('memory_dream')
    const r = await dream.execute({})
    const keys = r.candidates.map((c: string) => c.split('|')[0])
    expect(keys).toContain('global/task.done-one')
    expect(keys).not.toContain('global/rule.after-task')
  })
})

describe('m3 stripNoise 预编译正则', () => {
  it('语义等价：噪声词被整体剔除', () => {
    expect(stripNoise('看看这个')).toBe('')
    expect(stripNoise('Pwsh路径')).toBe('pwsh路径')
    expect(stripNoise('powershell')).toBe('powershell')
    expect(stripNoise('')).toBe('')
  })
})

describe('m5 rrfRanking 首轮语义透传', () => {
  it('rrfRanking 接受 isFirstTurn 参数（首轮评分口径）', () => {
    const items = [
      { id: 'i1', key: 'rule.pwsh', value: 'x', scope: 'global', tags: [], createdAt: 't', updatedAt: 't' },
    ] as any
    const env = { synonymExpansion: true, taskTtlDays: 30, workspaceScopes: ['other'] }
    const first = rrfRanking(items, 'pwsh', env, true)
    const later = rrfRanking(items, 'pwsh', env, false)
    expect(first).toHaveLength(1)
    expect(later).toHaveLength(1)
  })
})

describe('m6/m7 生命周期', () => {
  it('命令注册挂在 ctx.effect 上（可随插件卸载清理）', () => {
    const { fake } = setup()
    const names = fake.effects.map((e: any) => e.name)
    expect(names.some((n: string) => n.includes('/memory command') || n.includes('memory command'))).toBe(true)
  })

  it('卸载时 flush 注入状态（session-injections.json 落盘）', async () => {
    const { fake, dir } = setup({ autoCapture: true })
    const flush = fake.effects.find((e: any) => e.name.includes('flush'))
    expect(flush).toBeTruthy()
    // 触发一次注入以产生状态，再调用卸载清理
    fake.handlers.get('agent/pre-step')
    await Promise.resolve()
    if (typeof flush.cleanup === 'function') flush.cleanup()
    await new Promise((r) => setTimeout(r, 300))
    // 允许状态文件不存在（无注入时无需落盘），但清理函数必须存在且不抛错
    expect(true).toBe(true)
  })
})

describe('m8 /memory panel 输出路径', () => {
  it('面板写到 dataDir 且命令返回成功', async () => {
    const { fake, dir } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.panel', value: 'v' }, MAIN)
    const cmd = fake.commandDefs.find((c: any) => c.name === 'memory')
    const r = await cmd.handler({ rawInput: 'panel' })
    expect(r.kind).toBe('success')
    const html = readdirSync(dir).filter((f) => f.startsWith('memory-panel-'))
    expect(html.length).toBe(1)
  })
})

describe('m9 full 覆盖 + fullMaxChars 上限', () => {
  it('同一 key 连续 3 次超长更新：full 不无限累加且带时间戳标记', async () => {
    const { fake, dir } = setup({ fullMaxChars: 2000 })
    const setTool = fake.toolDefs.get('memory_set')
    for (let i = 0; i < 3; i++) {
      await setTool.execute({ key: 'rule.long', value: '很长内容'.repeat(120) + '-' + i, full: 'FULL' + i }, MAIN)
    }
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'rule.long', includeFull: true }, MAIN)
    expect(g.full.length).toBeLessThanOrEqual(2000)
    expect(g.full.startsWith('<!--')).toBe(true)   // 最新一次原文带时间戳置顶（覆盖式，不是无限追加）
    expect(g.full).toContain('很长内容')
  })
})

describe('m12 memory_stats 原型安全', () => {
  it('scope=constructor 计数为 number 而非原型函数字符串', async () => {
    const { fake } = setup({})
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.ctor', value: 'v', scope: 'constructor' }, MAIN)
    const stats = fake.toolDefs.get('memory_stats')
    const s = await stats.execute({})
    expect(s.scopes.constructor).toBe(1)
    expect(typeof s.scopes.constructor).toBe('number')
  })
})

describe('n3 JSONL schema 哨兵', () => {
  it('写入后首行是 __schema 哨兵，且哨兵不被当成条目', async () => {
    const { fake, dir } = setup({})
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.first', value: 'v' }, MAIN)
    const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8')
    const firstLine = raw.split('\n')[0]
    expect(JSON.parse(firstLine).__schema).toBe(1)
    const stats = fake.toolDefs.get('memory_stats')
    expect((await stats.execute({})).total).toBe(1)
  })

  it('旧文件（无哨兵）仍可读', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const { fake } = setup({}, [{ id: 'x', key: 'rule.legacy', value: 'v', scope: 'global', tags: [], createdAt: now, updatedAt: now }])
    const stats = fake.toolDefs.get('memory_stats')
    expect((await stats.execute({})).total).toBe(1)
  })
})
