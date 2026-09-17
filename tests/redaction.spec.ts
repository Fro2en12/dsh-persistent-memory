import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync as writeFs } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { maskCredential } from '../src/write-gate'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// C7（报告 Critical，未列入用户修复清单的缺口，主线程补充最小实现）：
// 记忆原文经工具通道进入上下文并随请求外发至 LLM provider —— 工具返回面对
// auth.* 与疑似凭据内容做掩码，仅显式 confirmed:true 时返回原文。

const tmpDirs: string[] = []
function setup(seed?: unknown[]) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  if (seed) writeFs(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false })
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

  it('memory_get 读 auth.* 默认掩码，confirmed:true 才返回原文', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.token', value: SECRET }, MAIN)
    const getTool = fake.toolDefs.get('memory_get')
    const masked = await getTool.execute({ key: 'auth.token', includeFull: true }, MAIN)
    expect(masked.found).toBe(true)
    expect(masked.value).not.toContain('SuperSecret123')
    expect(masked.value).toContain('掩码')
    expect(masked.full).toBeUndefined()
    const revealed = await getTool.execute({ key: 'auth.token', includeFull: true, confirmed: true }, MAIN)
    expect(revealed.value).toBe(SECRET)
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
