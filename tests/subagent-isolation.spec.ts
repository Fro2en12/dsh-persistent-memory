import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { apply } from '../src/index'
import { cleanTempDir, findPluginMessages, makeFakeCtx, makeTempDir, runPreStep } from './helpers'

// C5：子代理探测 fail-closed + auth.* 读取闸门 + 无 scope 检索默认限定 sub:<id> 与工作区
// M10：delegationDepthOf 单调取大（header.delegationDepth=0 + options.subagentDepth=1 → 子代理）
// S1/S2（对抗性复核发现）：import / dream apply 两条写路径的越权写 global 闸门 +
//                          探测改为「能明确证明是主会话才算主会话」，不再依赖上游抛错兜底

const tmpDirs: string[] = []
function setup(seed?: unknown[], config: Record<string, unknown> = {}) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  if (seed) writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false, ...config })
  return { fake, dir }
}
function wsDir() {
  const dir = makeTempDir('dspm-ws')
  tmpDirs.push(dir)
  return dir
}
function memFile(ws: string, name: string, content: string): string {
  const p = join(ws, name)
  writeFileSync(p, content, 'utf8')
  return p
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
  delete process.env.DSH_WORKSPACE
  delete process.env.DSH_WORKSPACE_NAME
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

  // ⚠️ 区分度说明（第三轮复核）：本用例【不】覆盖 auth.* 过滤——子代理不传 scope 时
  // src/index.ts:1522 把 allowedScopes 定为 ['sub:<id>', ...工作区]，global 里的 auth.probe
  // 在到达 1527 的 auth.* 过滤之前就已被 allowedScopes 排除；删掉 auth.* 过滤本用例依旧全绿。
  // 真正有区分度的是下面「显式 scope」那条对照用例。
  it('子代理 memory_search 无 scope 时只返回子代理/工作区条目（auth.* 前置于 allowedScopes 已被排除）', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'auth.probe', value: 'sk-1234567890abcdef', scope: 'global' }, MAIN)
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({ query: 'probe' }, SUB)
    expect(s.count).toBe(0)
    expect(s.items).toEqual([])
  })

  // 对照用例（第三轮复核要求：删掉 src/index.ts 的 auth.* 过滤必红）：
  // 子代理【显式】传 scope:"global" → isSub && !args.scope 为假 → allowedScopes === undefined，
  // global 条目会进入结果集（下面用非 auth.* 条目证明这一点），此时唯一把 auth.* 挡在外面的
  // 就是 src/index.ts:1526-1529 的过滤。删掉它 → s.items 变成长度 2、含 auth.probe → 三条断言全红。
  it('子代理显式 scope:"global"（allowedScopes 旁路）仍看不到 auth.*，非 auth.* 的 global 条目可见', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.global-visible', value: '全局可见内容', scope: 'global' }, MAIN)
    await setTool.execute({ key: 'auth.probe', value: 'sk-1234567890abcdef', scope: 'global' }, MAIN)
    const searchTool = fake.toolDefs.get('memory_search')

    // ① 同一入参在主会话下两条都在（证明这两个条目确实落在 scope=global 且查询命中了它们）
    const asMain = await searchTool.execute({ scope: 'global' }, MAIN)
    expect(asMain.items.map((i: any) => i.key).sort()).toEqual(['auth.probe', 'rule.global-visible'])

    // ② 子代理显式 scope=global：allowedScopes 旁路打开，非 auth.* 条目进结果集 = 旁路确实生效
    const s = await searchTool.execute({ scope: 'global' }, SUB)
    expect(s.items.map((i: any) => ({ key: i.key, scope: i.scope })), 'auth.* 未被掩码/过滤：allowedScopes 旁路下唯一防线是 auth.* 过滤').toEqual([
      { key: 'rule.global-visible', scope: 'global' },
    ])
    expect(s.count).toBe(1)
    expect(s.items.every((i: any) => !i.key.toLowerCase().startsWith('auth.'))).toBe(true)
    // ③ 结果体里连 auth.* 的 key 名都不出现（目录里出现 key 本身就是线索）
    expect(JSON.stringify(s)).not.toContain('auth.probe')
  })
})

// ── S2（对抗性复核）：探测不得依赖上游抛错兜底 ──────────────────────────────
// 复核者实测上游 delegationDepthOf：{session:{header:{}}} 抛 TypeError（旧用例恰好只覆盖了这个形状），
// {session:{header:{}}, options:{}} 返回 0 且不抛 → 旧判据落到 header 判据 → false → 畸形会话被当主会话。
// 新判据：只有「能明确证明是主会话」才放行（会话身份 session.id、header、options 齐备 + 深度 0 +
// 无 origin/parentSession/parentId）；任何一项缺失或不确定 → 按子代理。
const EMPTY_HEADER_EMPTY_OPTIONS = { agent: { session: { header: {} }, options: {} } }
const EMPTY_HEADER_DEPTH0_OPTIONS = { agent: { session: { header: {} }, options: { subagentDepth: 0 } } }
const NO_OPTIONS = { agent: { session: { id: 'sub-no-options', header: {} } } }
const PARENT_ID_ONLY = { agent: { session: { id: 'sub-parent-id', header: { parentId: 'main-1' } }, options: {} } }
// 真实主会话形状：GUI/session-controller 建会话时 meta 只有 cwd/agentPreset（不含 delegationDepth）、
// agentOptions 只有 provider/model（不含 subagentDepth）。这个形状必须放行——否则进程内新建的
// 顶层会话会被判成子代理，主会话将写不进 global（详见 src/index.ts 判据注释）。
const REAL_MAIN = {
  agent: {
    session: {
      id: 'sess-real',
      header: { version: 3, id: 'sess-real', createdAt: 1, isSeeded: false, cwd: 'C:/proj', agentPreset: 'default' },
    },
    options: { provider: 'deepseek', model: 'flash' },
  },
}

describe('S2 探测：只有能明确证明是主会话才放行（不靠上游抛错）', () => {
  it('上游对 {header:{}, options:{}} 返回 0 而不抛错——这正是旧判据 fail-open 的根因', () => {
    expect(delegationDepthOf(EMPTY_HEADER_EMPTY_OPTIONS.agent as never)).toBe(0)
    // 旧实现唯一兜住的形状：options 缺失 → 上游 TypeError
    expect(() => delegationDepthOf(NO_OPTIONS.agent as never)).toThrow(TypeError)
  })

  it('{session:{header:{}}, options:{}} → 视为子代理，拒绝写 global', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await expect(setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, EMPTY_HEADER_EMPTY_OPTIONS)).rejects.toThrow(/子代理会话禁止写入 global/)
  })

  it('{session:{header:{}}, options:{subagentDepth:0}} → 视为子代理，拒绝写 global', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await expect(setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, EMPTY_HEADER_DEPTH0_OPTIONS)).rejects.toThrow(/子代理会话禁止写入 global/)
  })

  it('header.parentId 存在（运行时视图没有持久化 origin/parentSession）→ 视为子代理', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await expect(setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, PARENT_ID_ONLY)).rejects.toThrow(/子代理会话禁止写入 global/)
  })

  it('真实主会话在 pre-step 拿到主会话守则（不被误判为子代理）', async () => {
    const { fake } = setup(undefined, { autoCapture: true })
    const payload = { agent: REAL_MAIN.agent, messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], step: 1, signal: undefined }
    const d = await runPreStep(fake.handlers, payload)
    expect(findPluginMessages(d, 'memory-capture-guide')).toHaveLength(1)
    expect(findPluginMessages(d, 'memory-capture-guide-subagent')).toHaveLength(0)
  })

  it('拿不到会话身份的 agent 在 pre-step 只拿到子代理只读守则', async () => {
    const { fake } = setup(undefined, { autoCapture: true })
    const payload = { agent: EMPTY_HEADER_EMPTY_OPTIONS.agent, messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], step: 1, signal: undefined }
    const d = await runPreStep(fake.handlers, payload)
    expect(findPluginMessages(d, 'memory-capture-guide-subagent')).toHaveLength(1)
    expect(findPluginMessages(d, 'memory-capture-guide')).toHaveLength(0)
  })

  it('真实主会话（session.id + header + options 齐备、depth=0）→ 写 global 放行', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, REAL_MAIN)
    expect(r.ok).toBe(true)
    expect(await setTool.execute({ key: 'rule.x', value: 'v', scope: 'global' }, MAIN).then((x) => x.ok)).toBe(true)
  })
})

// ── S1（对抗性复核）：memory_import 越权写 global ─────────────────────────
const OLD_LONG = '很久以前定下的结论 ' + '细节'.repeat(80)
const oldGlobal = () => [{ id: 'g', key: 'ref.old-global', value: OLD_LONG, scope: 'global', tags: [], createdAt: daysAgo(120), updatedAt: daysAgo(120) }]
const oldSub = () => [{ id: 's', key: 'ref.old-sub', value: OLD_LONG, scope: 'sub:sub-3', tags: [], createdAt: daysAgo(120), updatedAt: daysAgo(120) }]

describe('S1 memory_import：子代理不得写 global', () => {
  it('子代理 memory_import({scope:"global"}) 被拒（与 memory_set 同款硬闸门）', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 's1.md', '# 规则\n\n必须用 UTF8')
    const imp = fake.toolDefs.get('memory_import')
    await expect(imp.execute({ path: p, scope: 'global' }, SUB)).rejects.toThrow(/子代理会话禁止写入 global/)
    // 拒绝必须发生在写库之前：库里不留任何条目
    expect((await fake.toolDefs.get('memory_stats').execute({})).total).toBe(0)
  })

  it('scope 先归一化再判：子代理传 " Global " 同样被拒', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 's1-norm.md', '# 规则\n\n大小写与空格不能绕过闸门')
    const imp = fake.toolDefs.get('memory_import')
    await expect(imp.execute({ path: p, scope: ' Global ' }, SUB)).rejects.toThrow(/子代理会话禁止写入 global/)
  })

  it('子代理导入默认 scope（工作区，非 global）仍可用', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    process.env.DSH_WORKSPACE_NAME = 'proj-s1'
    const { fake } = setup()
    const p = memFile(ws, 'ok.md', '# 注意\n\n这是个坑')
    const imp = fake.toolDefs.get('memory_import')
    const r = await imp.execute({ path: p }, SUB)
    expect(r.imported).toBeGreaterThanOrEqual(1)
    const stats = await fake.toolDefs.get('memory_stats').execute({})
    expect(stats.scopes['proj-s1']).toBeGreaterThanOrEqual(1)
    expect(stats.scopes.global).toBeUndefined()
  })

  it('主会话 memory_import({scope:"global"}) 正常（闸门不误伤主会话）', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'main.md', '# 规则\n\n主会话可以写 global')
    const imp = fake.toolDefs.get('memory_import')
    const r = await imp.execute({ path: p, scope: 'global' }, MAIN)
    expect(r.imported).toBeGreaterThanOrEqual(1)
  })

  it('/memory import（用户亲自输入）不受子代理闸门影响', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'cmd.md', '# 规则\n\n命令路径导入')
    const cmd = fake.commandDefs.find((c) => c.name === 'memory')
    const r = await cmd.handler({ rawInput: `import ${p}` })
    expect(r.kind).toBe('success')
  })
})

// ── S1（对抗性复核）：memory_dream apply 分支越权归档 global ────────────────
describe('S1 memory_dream apply：子代理不得归档 global', () => {
  it('子代理 apply:true 未传 scope（默认遍历全部 scope，含 global）→ 拒绝', async () => {
    const { fake } = setup(oldGlobal())
    const dream = fake.toolDefs.get('memory_dream')
    await expect(dream.execute({ apply: true }, SUB)).rejects.toThrow(/子代理会话禁止归档 global/)
  })

  it('子代理 apply:true + scope:"global" → 拒绝，且 global 条目原样未动', async () => {
    const { fake } = setup(oldGlobal())
    const dream = fake.toolDefs.get('memory_dream')
    await expect(dream.execute({ apply: true, scope: 'global' }, SUB)).rejects.toThrow(/子代理会话禁止归档 global/)
    const item = await fake.toolDefs.get('memory_get').execute({ key: 'ref.old-global' }, MAIN)
    expect(item.value).toBe(OLD_LONG)
  })

  it('子代理 apply:true + scope:"sub:sub-3" 只归档自己的 scope → 允许，且不碰 global', async () => {
    const { fake } = setup([...oldGlobal(), ...oldSub()])
    const dream = fake.toolDefs.get('memory_dream')
    const r = await dream.execute({ apply: true, scope: 'sub:sub-3' }, SUB)
    expect(r.summary).toMatch(/归档/)
    const get = fake.toolDefs.get('memory_get')
    expect((await get.execute({ key: 'ref.old-sub', scope: 'sub:sub-3' }, SUB)).value.length).toBeLessThanOrEqual(80)
    expect((await get.execute({ key: 'ref.old-global' }, MAIN)).value).toBe(OLD_LONG)
  })

  it('子代理只读列候选（apply 缺省 false）仍可用', async () => {
    const { fake } = setup(oldGlobal())
    const dream = fake.toolDefs.get('memory_dream')
    const r = await dream.execute({}, SUB)
    expect(r.candidates.length).toBeGreaterThanOrEqual(1)
  })

  it('主会话 apply:true 归档 global 仍正常（闸门不误伤主会话）', async () => {
    const { fake } = setup(oldGlobal())
    const dream = fake.toolDefs.get('memory_dream')
    const r = await dream.execute({ apply: true }, MAIN)
    expect(r.summary).toMatch(/归档/)
    expect((await fake.toolDefs.get('memory_get').execute({ key: 'ref.old-global', includeFull: true }, MAIN)).value.length).toBeLessThanOrEqual(80)
  })
})
