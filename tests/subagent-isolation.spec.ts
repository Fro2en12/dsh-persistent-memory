import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// C5：子代理探测 fail-closed + auth.* 读取闸门 + 无 scope 检索默认限定 sub:<id> 与工作区
// M10：delegationDepthOf 单调取大（header.delegationDepth=0 + options.subagentDepth=1 → 子代理）

const tmpDirs: string[] = []
function setup() {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false })
  return { fake, dir }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

const MAIN = { agent: { session: { id: 'main-1', header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } }
// M10 场景：header 为 0 但 runtime options 为 1（官方注释的 resumed child）
const DEPTH_MISMATCH = { agent: { session: { id: 'sub-1', header: { delegationDepth: 0 } }, options: { subagentDepth: 1 } } }
// C5 场景：header 空对象（畸形）——探测拿不到信息必须按子代理处理（fail-closed）
const MALFORMED = { agent: { session: { id: 'sub-2', header: {} } } }
const SUB = { agent: { session: { id: 'sub-3', header: { delegationDepth: 1, origin: 'subagent' } }, options: { subagentDepth: 1 } } }

describe('M10 delegationDepthOf 单调取大', () => {
  it('header.delegationDepth=0 + options.subagentDepth=1 → 判定为子代理，拒绝写 global', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await expect(setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, DEPTH_MISMATCH)).rejects.toThrow(/子代理会话禁止写入 global/)
  })

  it('主会话（header 0 + options 0）写 global 正常', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, MAIN)
    expect(r.ok).toBe(true)
  })
})

describe('C5 fail-closed 探测', () => {
  it('畸形 agent（session 有 header 为空对象、无 options）→ 按子代理拒绝写 global', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await expect(setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, MALFORMED)).rejects.toThrow(/子代理会话禁止写入 global/)
  })

  it('子代理可写 scope=sub:<id>', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'rule.sub', value: 'v', scope: 'sub:sub-3' }, SUB)
    expect(r.ok).toBe(true)
  })
})

describe('C5 auth.* 读取闸门 + 检索面限定', () => {
  it('子代理读 auth.* 被拒绝', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.secret', value: 'password123', scope: 'global' }, MAIN)
    const getTool = fake.toolDefs.get('memory_get')
    await expect(getTool.execute({ key: 'auth.secret' }, SUB)).rejects.toThrow(/不可读取凭据类记忆/)
    // 主会话仍可读
    const g = await getTool.execute({ key: 'auth.secret' }, MAIN)
    expect(g.found).toBe(true)
  })

  it('子代理 memory_search 无 scope 时只返回 sub:<id> 与工作区 scope（不含 global）', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.global-only', value: '全局唯一内容', scope: 'global' }, MAIN)
    await setTool.execute({ key: 'rule.sub-only', value: '子代理专属内容', scope: 'sub:sub-3' }, SUB)
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({}, SUB)
    expect(s.count).toBe(1)
    expect(s.items[0].key).toBe('rule.sub-only')
  })

  it('子代理 memory_search 结果排除 auth.* 条目', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.probe', value: 'sk-1234567890abcdef', scope: 'global' }, MAIN)
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({ query: 'probe' }, SUB)
    expect(s.count).toBe(0)
  })
})
