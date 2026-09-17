import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M3：memory_forget 加子代理隔离 + auth.* 删除需 confirmed + 审计日志
// M14：/memory remember 复用 memory_set 校验（前缀/凭据/长度/tags），approveOnSet 对用户豁免

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
})

const MAIN = { agent: { session: { id: 'main-1', header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } }
const SUB = { agent: { session: { id: 'sub-1', header: { delegationDepth: 1, origin: 'subagent' } }, options: { subagentDepth: 1 } } }

function memoryCmd(fake: any) {
  const cmd = fake.commandDefs.find((c: any) => c.name === 'memory')
  return (raw: string) => cmd.handler({ rawInput: raw })
}

describe('M3 memory_forget 隔离', () => {
  it('子代理删除 global 被拒绝；主会话可删', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const forgetTool = fake.toolDefs.get('memory_forget')
    await setTool.execute({ key: 'rule.tmp', value: 'v' }, MAIN)
    await expect(forgetTool.execute({ key: 'rule.tmp', scope: 'global' }, SUB)).rejects.toThrow(/子代理会话禁止删除 global/)
    const r = await forgetTool.execute({ key: 'rule.tmp', scope: 'global' }, MAIN)
    expect(r.removed).toBe(true)
  })

  it('删除 auth.* 需 confirmed: true', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const forgetTool = fake.toolDefs.get('memory_forget')
    await setTool.execute({ key: 'auth.probe', value: 'password=123' }, MAIN)
    await expect(forgetTool.execute({ key: 'auth.probe' }, MAIN)).rejects.toThrow(/confirmed/)
    const r = await forgetTool.execute({ key: 'auth.probe', confirmed: true }, MAIN)
    expect(r.removed).toBe(true)
  })

  it('删除写审计日志（scope/key/会话）', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const forgetTool = fake.toolDefs.get('memory_forget')
    await setTool.execute({ key: 'rule.audit', value: 'v' }, MAIN)
    await forgetTool.execute({ key: 'rule.audit', scope: 'global' }, MAIN)
    const audit = fake.logs.filter((l: any) => l.level === 'info' && l.message.includes('forget'))
    expect(audit.length).toBeGreaterThanOrEqual(1)
    expect(audit[0].message).toContain('main-1')
  })
})

describe('M14 /memory remember 复用写侧闸门', () => {
  it('非法前缀 → error', async () => {
    const { fake } = setup()
    const r = await memoryCmd(fake)('remember foo.bar 这是一条前缀非法的记忆')
    expect(r.kind).toBe('error')
    expect(r.text).toContain('不在分类白名单')
  })

  it('明文凭据 → error', async () => {
    const { fake } = setup()
    const r = await memoryCmd(fake)('remember env.cred password=123')
    expect(r.kind).toBe('error')
    expect(r.text).toMatch(/明文凭据|凭据类记忆/)
  })

  it('超长 value → 截断并产生 warning', async () => {
    const { fake } = setup()
    const long = '很长的内容'.repeat(80)   // 480 字
    const r = await memoryCmd(fake)(`remember rule.long ${long}`)
    expect(r.kind).toBe('success')
    expect(r.text).toContain('⚠️')
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'rule.long', includeFull: true }, MAIN)
    expect(g.found).toBe(true)
    expect(g.value.length).toBeLessThanOrEqual(243)   // 240 + 省略号（输出面 NFKC 展开 … → ...）
    expect(g.full).toBeTruthy()
  })

  it('合法写入成功', async () => {
    const { fake } = setup()
    const r = await memoryCmd(fake)('remember rule.ok 用 UTF8 编码写中文')
    expect(r.kind).toBe('success')
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'rule.ok' }, MAIN)
    expect(g.found).toBe(true)
    expect(g.value).toBe('用 UTF8 编码写中文')
  })

  it('approveOnSet 开启时用户亲自输入豁免（仍写入）', async () => {
    const { fake } = setup({ approveOnSet: true })
    const r = await memoryCmd(fake)('remember rule.human 用户自己写的')
    expect(r.kind).toBe('success')
    // 模型调用仍需 confirmed
    const setTool = fake.toolDefs.get('memory_set')
    await expect(setTool.execute({ key: 'rule.model', value: 'v' }, MAIN)).rejects.toThrow(/写入审批/)
  })
})
