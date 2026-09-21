import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync as writeFs } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { maskCredential } from '../src/write-gate'
import { sanitizeValue } from '../src/sanitize'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// C7（报告 Critical，未列入用户修复清单的缺口，主线程补充最小实现）：
// 记忆原文经工具通道进入上下文并随请求外发至 LLM provider —— 工具返回面对
// auth.* 与疑似凭据内容做掩码，仅显式 confirmed:true 时返回原文。

const tmpDirs: string[] = []
function setup(seed?: unknown[], config: Record<string, unknown> = {}) {
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
const SECRET = 'password=SuperSecret123'

describe('C7 凭据掩码（工具出库面）', () => {
  it('maskCredential 保留可识别前缀并标注已掩码', () => {
    expect(maskCredential('sk-1234567890abcdef')).toContain('sk-')
    expect(maskCredential('sk-1234567890abcdef')).not.toContain('1234567890abcdef')
    expect(maskCredential('普通口令文本')).not.toContain('普通口令文本')
    expect(maskCredential(SECRET)).not.toContain('SuperSecret123')
  })

  it('memory_get 读 auth.* 默认掩码', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.token', value: SECRET }, MAIN)
    const getTool = fake.toolDefs.get('memory_get')
    const masked = await getTool.execute({ key: 'auth.token', includeFull: true }, MAIN)
    expect(masked.found).toBe(true)
    expect(masked.value).not.toContain('SuperSecret123')
    expect(masked.value).toContain('掩码')
    expect(masked.full).toBeUndefined()
  })

  // T10（第五轮收口）：confirmed 是模型自己填的 schema 参数，不构成用户授权——
  // 默认配置下即使 confirmed:true 也只回掩码；只有部署者显式开启 allowCredentialReveal 才可取回。
  it('T10：默认配置下 confirmed:true 也不能取回 auth.* 原文（模型自述不等于授权）', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.token', value: SECRET }, MAIN)
    const getTool = fake.toolDefs.get('memory_get')
    const masked = await getTool.execute({ key: 'auth.token', includeFull: true, confirmed: true }, MAIN)
    expect(masked.masked).toBe(true)
    expect(masked.value).not.toContain('SuperSecret123')
    expect(masked.full).toBeUndefined()
  })

  it('T10：显式 allowCredentialReveal:true（部署者授权）时 confirmed 可取回原文', async () => {
    const { fake } = setup(undefined, { allowCredentialReveal: true })
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.token', value: SECRET }, MAIN)
    const getTool = fake.toolDefs.get('memory_get')
    const revealed = await getTool.execute({ key: 'auth.token', includeFull: true, confirmed: true }, MAIN)
    expect(revealed.value).toBe(SECRET)
    // 未带 confirmed 时仍然掩码
    const stillMasked = await getTool.execute({ key: 'auth.token' }, MAIN)
    expect(stillMasked.value).not.toContain('SuperSecret123')
  })

  // T11（第五轮补齐报告 C7 建议 3）：自定义敏感词（redactPatterns）与固定凭据正则取并集
  it('T11：redactPatterns 命中的自定义敏感内容出库掩码（写侧不拒绝）', async () => {
    const { fake } = setup(undefined, { redactPatterns: ['PROJECT-FALCON-9'] })
    const setTool = fake.toolDefs.get('memory_set')
    const writeResult = await setTool.execute({ key: 'project.codename', value: '内部代号 PROJECT-FALCON-9 的项目，时间 2026-09-17' }, MAIN)
    expect(writeResult.ok).toBe(true)   // 写侧不拒绝：redactPatterns 是出库掩码而非写侧闸门
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'project.codename' }, MAIN)
    expect(g.value).not.toContain('PROJECT-FALCON-9')
    expect(g.value).toContain('掩码')
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({ query: '内部代号' }, MAIN)
    const hit = s.items.find((i: any) => i.key === 'project.codename')
    expect(hit).toBeTruthy()
    expect(hit.value).not.toContain('PROJECT-FALCON-9')
  })

  it('T11：未配置 redactPatterns 时普通内容不受影响；非法正则被忽略不抛错', async () => {
    const { fake } = setup(undefined, { redactPatterns: ['[unclosed'] })   // 非法正则
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.normal', value: '普通内容 [unclosed 字样' }, MAIN)
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'rule.normal' }, MAIN)
    expect(g.value).toContain('普通内容')
  })

  it('非 auth.* 的普通记忆不受掩码影响', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.plain', value: '普通规则内容' }, MAIN)
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'rule.plain' }, MAIN)
    expect(g.value).toBe('普通规则内容')
  })

  it('memory_search 结果中 auth.* 与命中凭据正则的历史条目 value 掩码', async () => {
    const { fake, dir } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.platforms', value: SECRET }, MAIN)
    // 历史遗留条目（写侧闸门已拒绝此类写入，绕过写侧种入）：
    const now = '2026-09-17T00:00:00.000Z'
    const legacy = { id: 'legacy', key: 'env.old-cred', value: SECRET, scope: 'global', tags: [], createdAt: now, updatedAt: now }
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(dir, 'memory.jsonl'), JSON.stringify(legacy) + '\n', 'utf8')
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({ query: 'password' }, MAIN)
    const authItem = s.items.find((i: any) => i.key === 'auth.platforms')
    const legacyItem = s.items.find((i: any) => i.key === 'env.old-cred')
    expect(authItem).toBeTruthy()
    expect(authItem.value).not.toContain('SuperSecret123')
    expect(authItem.value).toContain('掩码')
    expect(legacyItem).toBeTruthy()
    expect(legacyItem.value).not.toContain('SuperSecret123')
  })
})

// ── S5：新增凭据形态的掩码（工具出库面）────────────────────────────────────
// S5：复核列出的 14 类形态（与 tests/credential-gate.spec.ts 的 S5_FORMS 同源）
const S5_SECRETS = [
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
  'postgres://user:s3cretpw@db.example.com:5432/app',
  'xoxb-123456789012-abcdefghijklmnopqrstuvwx',
  'sk_live_51H8xYzABCdefGHIJKLmnopqrstuv',
  'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
  'glpat-abcdefghijklmnopqrst',
  'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  'AccountKey=abcdefghijklmnopqrstuvwxyz0123456789==',
  'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
  'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm',
  'a3f1c9e7b5d24680ace13579bdf02468ace13579',
]

describe('S5 新增凭据形态的掩码', () => {
  it('maskCredential 对新增形态不泄漏原文', () => {
    for (const secret of S5_SECRETS) {
      expect(maskCredential(secret), '泄漏: ' + secret).not.toContain(secret)
      expect(maskCredential(secret)).toContain('掩码')
    }
  })

  it('memory_get 对历史遗留的新形态条目默认掩码（T10 收口后 confirmed 默认无效，需部署者开启 allowCredentialReveal）', async () => {
    // T10（第五轮）：confirmed 是模型自述，默认配置下即使 confirmed:true 也只回掩码；
    // 本条改为在部署者显式授权（allowCredentialReveal:true）下验证取回路径。
    const { fake, dir } = setup(undefined, { allowCredentialReveal: true })
    const now = '2026-09-17T00:00:00.000Z'
    const { appendFileSync } = await import('node:fs')
    for (const [i, secret] of S5_SECRETS.entries()) {
      appendFileSync(join(dir, 'memory.jsonl'), JSON.stringify({ id: 's5-' + i, key: 'env.s5-' + i, value: secret, scope: 'global', tags: [], createdAt: now, updatedAt: now }) + '\n', 'utf8')
    }
    const getTool = fake.toolDefs.get('memory_get')
    for (const [i, secret] of S5_SECRETS.entries()) {
      const key = 'env.s5-' + i
      const masked = await getTool.execute({ key }, MAIN)
      expect(masked.found, '未找到: ' + key).toBe(true)
      expect(masked.value, '未掩码: ' + secret).not.toContain(secret)
      expect(masked.value).toContain('掩码')
      const revealed = await getTool.execute({ key, confirmed: true }, MAIN)
      // 取回路径仍过 C4 清洗（postgres:// 的 scheme 会被中和），故与 sanitizeValue 对齐
      expect(revealed.value).toBe(sanitizeValue(secret))
    }
  })

  it('memory_search 对历史遗留的新形态条目掩码', async () => {
    const { fake, dir } = setup()
    const now = '2026-09-17T00:00:00.000Z'
    const { appendFileSync } = await import('node:fs')
    for (const [i, secret] of S5_SECRETS.entries()) {
      appendFileSync(join(dir, 'memory.jsonl'), JSON.stringify({ id: 's5-' + i, key: 'env.s5-' + i, value: secret, scope: 'global', tags: [], createdAt: now, updatedAt: now }) + '\n', 'utf8')
    }
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({ scope: 'global' }, MAIN)
    expect(s.count).toBe(S5_SECRETS.length)
    for (const item of s.items) {
      expect(item.value, '未掩码: ' + item.key).toContain('掩码')
      for (const secret of S5_SECRETS) {
        expect(item.value, '泄漏: ' + item.key).not.toContain(secret)
      }
    }
  })
})

// ── 复审对齐：掩码文案不得承诺一条默认走不通的取回路径 ──────────────────────
describe('复审 掩码文案与实现一致', () => {
  it('不得声称「confirmed:true 可取回原文」（默认 allowCredentialReveal=false 时无效）', () => {
    const t = maskCredential('sk-1234567890abcdef')
    expect(t).toContain('掩码')
    expect(t, '默认配置下 confirmed 无效，文案不能承诺可取回').not.toContain('可取回')
    expect(maskCredential('普通的口令文本')).not.toContain('可取回')
  })
})
