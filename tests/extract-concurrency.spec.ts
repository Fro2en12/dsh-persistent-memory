import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M5：提取器并发粒度——per-session 互斥 + 全局上限 2；被上限拒绝的会话不记冷却（下轮可重试）

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

function setup() {
  const gates: Array<() => void> = []
  const startedSessions: string[] = []
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx({}, {
    llm: {
      stream: async function* (req: any) {
        startedSessions.push(String(req?.messages?.[0]?.content?.[0]?.text ?? '').slice(0, 0) || 'x')
        await new Promise<void>((resolve) => gates.push(resolve))
        yield { type: 'text-delta', text: '{"memories":[]}' }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
  return { fake, gates, startedSessions, dir }
}

function feedTurn(fake: any, sid: string) {
  const session = { id: sid }
  const onEvent = fake.handlers.get('session/event')[0]
  const onTurn = fake.handlers.get('agent/turn-stopping')[0]
  onEvent(session, { type: 'turn/start' })
  onEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text: '记住这个 ' + sid }] } })
  onTurn({ agent: { session: { id: sid, header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } })
}

const tick = () => new Promise((r) => setTimeout(r, 50))

describe('M5 提取并发粒度', () => {
  it('3 会话并发触发 → 最多 2 次提取在飞（全局上限）', async () => {
    const { fake, gates } = setup()
    feedTurn(fake, 's1')
    feedTurn(fake, 's2')
    feedTurn(fake, 's3')
    await tick()
    expect(gates.length).toBe(2)
    // 放行在飞的两次
    for (const g of gates.splice(0)) g()
    await tick()
  })

  it('被全局上限拒绝的会话下轮可重试（不写冷却）', async () => {
    const { fake, gates } = setup()
    feedTurn(fake, 's1')
    feedTurn(fake, 's2')
    feedTurn(fake, 's3')          // 被上限拒绝，且不应记 lastExtractAt
    await tick()
    expect(gates.length).toBe(2)
    // 放行，腾出并发额度
    for (const g of gates.splice(0)) g()
    await tick()
    // 第三会话重试：应真正发起提取
    feedTurn(fake, 's3')
    await tick()
    expect(gates.length).toBe(1)
    for (const g of gates.splice(0)) g()
    await tick()
  })

  it('同一会话在飞期间不重入（per-session 互斥）', async () => {
    const { fake, gates } = setup()
    feedTurn(fake, 'sx')
    await tick()
    expect(gates.length).toBe(1)
    feedTurn(fake, 'sx')          // 同会话再次结束回合：应被 per-session 互斥挡住
    await tick()
    expect(gates.length).toBe(1)
    for (const g of gates.splice(0)) g()
    await tick()
  })
})
