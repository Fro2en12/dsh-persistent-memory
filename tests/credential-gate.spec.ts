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

// ── S5（复核实测 15 类形态中 14 类漏检）：补齐常见前缀/形态 + 高熵兜底 ──────
const S5_FORMS: Array<[string, string]> = [
  ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AWS secret（无 AKIA 前缀）'],
  ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'JWT（eyJ…）'],
  ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', '私钥体（无 BEGIN 头）'],
  ['postgres://user:s3cretpw@db.example.com:5432/app', 'postgres 连接串'],
  ['xoxb-123456789012-abcdefghijklmnopqrstuvwx', 'Slack xoxb-'],
  ['sk_live_51H8xYzABCdefGHIJKLmnopqrstuv', 'Stripe sk_live_'],
  ['github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEF', 'GitHub github_pat_'],
  ['glpat-abcdefghijklmnopqrst', 'GitLab glpat-'],
  ['npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_ 令牌'],
  ['AccountKey=abcdefghijklmnopqrstuvwxyz0123456789==', 'Azure AccountKey='],
  ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Basic'],
  ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'Anthropic sk-ant-api03-'],
  ['Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm', '无前缀高熵令牌（≥32 且含大小写与数字）'],
  ['a3f1c9e7b5d24680ace13579bdf02468ace13579', 'hex 形态令牌'],
]

// 反向用例：普通长文本（中文正文/英文句子/URL/路径/长驼峰标识）不得判为凭据
const S5_SAFE = [
  'PowerShell 写中文加 -Encoding UTF8',
  '本项目约定：提交前先跑 pnpm test，失败必须先修复再提交，不允许跳过用例',
  '在 Windows 上用 pwsh -NoProfile 执行构建脚本，输出用 UTF8 编码避免中文乱码',
  '仓库地址 https://github.com/Fro2en12/dsh-persistent-memory 里有完整说明',
  '项目路径 E:/Work/persistent-memory-project2/src/index.ts 已经固定',
  'Remember to run the full test suite before every release and fix any failing case first',
  'PowerShellScriptWithLongCamelCaseName',
]

describe('S5 凭据形态补齐（write-gate）', () => {
  it('复核列出的每类形态都命中 findCredentialMatch', () => {
    for (const [form, label] of S5_FORMS) {
      expect(findCredentialMatch(form), '未命中: ' + label + ' = ' + form).not.toBeNull()
    }
  })

  it('普通长文本不误判（中文正文 / 英文句子 / URL / 路径 / 长驼峰标识）', () => {
    for (const text of S5_SAFE) {
      expect(findCredentialMatch(text), '误判为凭据: ' + text).toBeNull()
    }
  })
})

describe('S5 memory_set 凭据拒绝 / 普通长文本放行', () => {
  it('每类形态在非 auth.* 前缀下都被拒绝', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    for (const [form, label] of S5_FORMS) {
      await expect(setTool.execute({ key: 'env.probe', value: form }, MAIN), '未拒绝: ' + label).rejects.toThrow(/明文凭据|凭据类记忆/)
    }
  })

  it('普通长文本仍可写入（不被放大的规则误拒）', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    for (const [i, text] of S5_SAFE.entries()) {
      const r = await setTool.execute({ key: 'rule.safe' + i, value: text }, MAIN)
      expect(r.ok, '被误拒: ' + text).toBe(true)
    }
  })
})
