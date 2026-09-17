import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { findCredentialMatch } from '../src/write-gate'
import { cleanTempDir, findPluginMessages, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// M2：凭据正则升级为拒绝（8+ 种形态）；提取器复用同一份正则；出库侧 excludeCredentials 兜底

const CRED_FORMS: Array<[string, string]> = [
  ['token=abc123', 'token'],
  ['my secret is xyz', 'secret'],
  ['api_key=abc', 'api_key'],
  ['api-key: xyz', 'api-key'],
  ['Bearer abcdefghijklmnopqrstuvwxyz', 'bearer 长串'],
  ['sk-1234567890abcdef', 'sk- 形态'],
  ['ghp_1234567890abcdefghij', 'ghp_ 形态'],
  ['AKIA1234567890ABCDEF', 'AKIA 形态'],
  ['-----BEGIN PRIVATE KEY-----', 'PRIVATE KEY'],
  ['password=123', 'password'],
  ['密码是123456', '中文口令'],
]

const tmpDirs: string[] = []
function setup() {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: true, autoCapture: false, autoRecallRerank: false, autoExtract: false })
  return { fake, dir }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})
const MAIN = { agent: { session: { id: 'main-1', header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } }

describe('M2 凭据正则统一（write-gate）', () => {
  it('11 种凭据形态全部命中 CREDENTIAL_RE', () => {
    for (const [form, label] of CRED_FORMS) {
      expect(findCredentialMatch(form), '未命中: ' + label).not.toBeNull()
    }
    expect(findCredentialMatch('PowerShell 写中文加 -Encoding UTF8')).toBeNull()
  })
})

describe('M2 memory_set 凭据拒绝', () => {
  it('11 种凭据形态在非 auth.* 前缀下全部抛错', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    for (const [form, label] of CRED_FORMS) {
      await expect(setTool.execute({ key: 'env.probe', value: form }, MAIN), '未拒绝: ' + label).rejects.toThrow(/明文凭据|凭据类记忆/)
    }
  })

  it('auth.* 前缀豁免凭据闸门（用户明确要求记住时才写）', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'auth.platforms', value: 'password=123' }, MAIN)
    expect(r.ok).toBe(true)
  })

  it('正常内容不受影响', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'env.utf8', value: 'PowerShell 写中文加 -Encoding UTF8' }, MAIN)
    expect(r.ok).toBe(true)
  })
})

describe('M2 提取器复用同一份正则', () => {
  function makeExtractCtx(llmText: string) {
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: llmText } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    return { fake, dir }
  }
  function feedTurn(fake: any, sid: string, text: string) {
    const session = { id: sid }
    const onEvent = fake.handlers.get('session/event')[0]
    const onTurn = fake.handlers.get('agent/turn-stopping')[0]
    onEvent(session, { type: 'turn/start' })
    onEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text }] } })
    onTurn({ agent: { session: { id: sid, header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } })
  }
  it('提取器候选含 sk- 凭据 → 不落盘', async () => {
    const { fake, dir } = makeExtractCtx('{"memories":[{"key":"env.probe","value":"sk-1234567890abcdef","tags":[]}]}')
    feedTurn(fake, 'sess-x', '记住这个')
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(join(dir, 'memory.jsonl'))).toBe(false)
  })
  it('提取器正常候选 → 落盘', async () => {
    const { fake, dir } = makeExtractCtx('{"memories":[{"key":"rule.utf8","value":"PowerShell 写中文加 -Encoding UTF8","tags":[]}]}')
    feedTurn(fake, 'sess-y', '记住这个')
    await new Promise((r) => setTimeout(r, 300))
    const file = join(dir, 'memory.jsonl')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('rule.utf8')
  })
})

describe('M2 出库侧兜底 excludeCredentials', () => {
  it('凭据条目不进入自动召回通道（词法直中也不注入）', async () => {
    const { fake, dir } = setup()
    // 直接写文件种入历史遗留的含凭据条目（写侧闸门已拒绝，绕过写侧模拟旧库）
    const legacy = { id: 'legacy-1', key: 'env.old', value: 'sk-1234567890abcdef', scope: 'global', tags: [], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'memory.jsonl'), JSON.stringify(legacy) + '\n', 'utf8')
    const payload = {
      agent: { session: { id: 'sess-z', header: { delegationDepth: 0 }, surface: undefined, events: undefined }, options: { subagentDepth: 0 } },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'env.old' }] }],
      step: 1,
      signal: undefined,
    }
    const d = await runPreStep(fake.handlers, payload)
    expect(findPluginMessages(d, 'memory-recall')).toHaveLength(0)
    expect(findPluginMessages(d, 'memory-index')).toHaveLength(0)
  })
})
