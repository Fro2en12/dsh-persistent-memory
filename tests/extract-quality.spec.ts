import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// 提取器质量评测（参考 Claude Code extractMemories 的 eval 思路）：
// ① 判据契约——提示词必须含双向记录与 lesson 优先级，且不再自我劝退；
// ② 写入条数——修复前 prompt 与代码双硬上限各为 1 条，两个真实缺陷只能记下半个。

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待异步提取落盘：全量并行时机器更慢，固定 sleep 会 flaky */
async function waitItems(dir: string, min: number, ms = 3000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (readStore(dir).length >= min) return
    if (Date.now() - t0 > ms) return
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

describe('守则契约：只保留完整版，主模型被明确要求自己写', () => {
  it('注入完整守则：含触发信号、责任归属与完整细则，且不再有「你不用重复写」', async () => {
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
    // 只保留完整版：默认即完整细则（brief 版已删除）
    expect(text.length).toBeGreaterThan(1500)
    expect(text).toContain('记忆使用守则')
    expect(text).toContain('## 不要记')
    // 触发与责任——本轮修复的核心，也是上一版 brief 砍错的地方
    expect(text).toContain('三个信号出现就写')
    expect(text).toContain('你是记录的主力')
    expect(text).not.toContain('你不用重复写')
  })
})
