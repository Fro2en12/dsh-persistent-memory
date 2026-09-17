import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M4：轮末提取器复用 upsertMemory 去重（key 漂移不再让库单调膨胀）+ 库容量软上限

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

function feedTurn(fake: any, sid: string, text: string) {
  const session = { id: sid }
  const onEvent = fake.handlers.get('session/event')[0]
  const onTurn = fake.handlers.get('agent/turn-stopping')[0]
  onEvent(session, { type: 'turn/start' })
  onEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text }] } })
  onTurn({ agent: { session: { id: sid, header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } })
}

async function waitFile(dir: string, predicate: (raw: string) => boolean, ms = 2000): Promise<string> {
  let raw = ''
  for (let i = 0; i < ms / 25; i++) {
    await new Promise((r) => setTimeout(r, 25))
    try { raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8') } catch { raw = '' }
    if (predicate(raw)) return raw
  }
  return raw
}

const stats = async (fake: any) => fake.toolDefs.get('memory_stats').execute({})

describe('M4 提取器去重', () => {
  it('同一会话库内顺序提取 3 个等价 key → 合并为 1 条', async () => {
    const llmBox = { text: '' }
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: llmBox.text } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    const cands = ['env.node-version', 'env.nodejs-version', 'tool.node-version']
    for (let i = 0; i < cands.length; i++) {
      llmBox.text = JSON.stringify({ memories: [{ key: cands[i], value: '本机 Node 版本 v26.8.1', tags: [] }] })
      const before = (await stats(fake)).total
      feedTurn(fake, 'sess-' + i, '记住这个')
      await waitFile(dir, (raw) => (raw.match(/\n/g) ?? []).length >= before + 1 || before === 0)
      await new Promise((r) => setTimeout(r, 150))
    }
    const s = await stats(fake)
    expect(s.total).toBe(1)
    const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8')
    expect(raw.trim().split('\n').filter((l) => !l.includes('__schema'))).toHaveLength(1)   // 排除 n3 哨兵行
  })

  it('与已有条目高度相似的候选 → 更新而非新建', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const seed = [{ id: 'x', key: 'env.node-version', value: '旧描述', scope: 'global', tags: [], createdAt: now, updatedAt: now }]
    const dir = makeTempDir()
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'env.nodejs-version', value: '本机 Node 版本 v26.8.1', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-merge', '记住这个')
    await waitFile(dir, (raw) => raw.includes('v26.8.1'))
    const s = await stats(fake)
    expect(s.total).toBe(1)
    expect(readFileSync(join(dir, 'memory.jsonl'), 'utf8')).toContain('v26.8.1')
  })
})

describe('M4 库容量软上限', () => {
  function seedMany(n: number) {
    const now = '2026-09-17T00:00:00.000Z'
    return Array.from({ length: n }, (_, i) => ({
      id: 'i' + i, key: 'task.item-' + i, value: '历史条目 ' + i, scope: 'global', tags: [], createdAt: now, updatedAt: now,
    }))
  }
  it('库超 500 条时拒绝全新的低价值（非 rule/lesson）候选', async () => {
    const seed = seedMany(501)
    const dir = makeTempDir()
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'env.brand-new', value: '全新环境事实', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-cap', '记住这个')
    await new Promise((r) => setTimeout(r, 400))
    const s = await stats(fake)
    expect(s.total).toBe(501)
  })

  it('库超 500 条时 rule.* 高价值候选仍可写入', async () => {
    const seed = seedMany(501)
    const dir = makeTempDir()
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'rule.new-lesson', value: '这是新踩的坑', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-cap2', '记住这个')
    await waitFile(dir, (raw) => raw.includes('rule.new-lesson'))
    const s = await stats(fake)
    expect(s.total).toBe(502)
  })
})
