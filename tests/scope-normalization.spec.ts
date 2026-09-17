import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { normalizeScope } from '../src/write-gate'
import { cleanTempDir, findPluginMessages, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// M8：scope 大小写归一（normalizeScope + buildIndexBlock 比较口径一致）+ 启动迁移

const tmpDirs: string[] = []
function setup(config: Record<string, unknown> = {}) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false, ...config })
  return { fake, dir }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
  delete process.env.DSH_WORKSPACE_NAME
  delete process.env.DSH_WORKSPACE
})

const MAIN = { agent: { session: { id: 'main-1', header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } }

describe('M8 normalizeScope 归一', () => {
  it('Global / GLOBAL / global 统一为 global', () => {
    expect(normalizeScope('Global', 'global')).toBe('global')
    expect(normalizeScope('GLOBAL', 'global')).toBe('global')
    expect(normalizeScope('  Thesis  ', 'global')).toBe('thesis')
    expect(normalizeScope('', 'global')).toBe('global')
    expect(normalizeScope(undefined, 'global')).toBe('global')
  })
})

describe('M8 同 key 不同大小写 scope 不再裂成多条', () => {
  it('三次写入 Global/GLOBAL/global 同 key → 只有 1 条、只有 1 个 scope', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.probe', value: 'v1', scope: 'Global' }, MAIN)
    await setTool.execute({ key: 'rule.probe', value: 'v2', scope: 'GLOBAL' }, MAIN)
    await setTool.execute({ key: 'rule.probe', value: 'v3', scope: 'global' }, MAIN)
    const statsTool = fake.toolDefs.get('memory_stats')
    const s = await statsTool.execute({})
    expect(s.total).toBe(1)
    expect(Object.keys(s.scopes)).toEqual(['global'])
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'rule.probe', scope: 'global' }, MAIN)
    expect(g.value).toBe('v3')
  })
})

describe('M8 索引块比较口径一致', () => {
  it('scope=Thesis（大写）的条目能进入记忆索引', async () => {
    process.env.DSH_WORKSPACE_NAME = 'thesis'
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const fake = makeFakeCtx()
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: true, autoCapture: false, autoRecallRerank: false, autoExtract: false })
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'task.chapter-1', value: '第一章进展', scope: 'Thesis' }, MAIN)
    const payload = {
      agent: { session: { id: 'sess-idx', header: { delegationDepth: 0 }, surface: undefined, events: undefined }, options: { subagentDepth: 0 } },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'zzz 无关查询' }] }],
      step: 1,
      signal: undefined,
    }
    const d = await runPreStep(fake.handlers, payload)
    const idx = findPluginMessages(d, 'memory-index')
    expect(idx).toHaveLength(1)
    expect(JSON.stringify(idx[0])).toContain('task.chapter-1')
  })
})

describe('M8 启动迁移历史数据', () => {
  it('非规范 scope 被归一为小写，并 warn 列出被改的 key', async () => {
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const now = '2026-09-17T00:00:00.000Z'
    const lines = [
      JSON.stringify({ id: 'a', key: 'rule.a', value: 'v', scope: 'Global', tags: [], createdAt: now, updatedAt: now }),
      JSON.stringify({ id: 'b', key: 'rule.b', value: 'v', scope: 'global', tags: [], createdAt: now, updatedAt: now }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 'memory.jsonl'), lines, 'utf8')
    const fake = makeFakeCtx()
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false })
    // 等迁移（启动异步）落盘 + warn 日志都就绪——写盘与日志之间没有原子性，
    // 只等文件会出现「文件已迁移但 warn 还没打」的 flaky 窗口
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 25))
      const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8')
      const warned = fake.logs.some((l: any) => l.level === 'warn' && l.message.includes('scope'))
      if (raw.includes('"scope":"global"') && !raw.includes('"scope":"Global"') && warned) break
    }
    const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8')
    expect(raw).not.toContain('"scope":"Global"')
    const warn = fake.logs.filter((l: any) => l.level === 'warn' && l.message.includes('scope'))
    expect(warn.length).toBeGreaterThanOrEqual(1)
    expect(warn[0].message).toContain('rule.a')
  })
})
