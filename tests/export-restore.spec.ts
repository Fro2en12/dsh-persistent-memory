import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync as writeFs } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M12：导出/恢复命令 + 写入容量守卫 + memory_dream apply 归档

const tmpDirs: string[] = []
function setup(config: Record<string, unknown> = {}, seed?: unknown[]) {
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
const cmd = (fake: any) => (raw: string) => fake.commandDefs.find((c: any) => c.name === 'memory').handler({ rawInput: raw })
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

describe('M12 导出/恢复', () => {
  it('export → 清空 → restore 后逐字段相等（含 full）', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const seed = [
      { id: 'a', key: 'rule.a', value: '值 A', full: '完整正文 A', scope: 'global', tags: ['x'], createdAt: now, updatedAt: now },
      { id: 'b', key: 'task.b', value: '值 B', scope: 'work', tags: [], createdAt: now, updatedAt: now },
    ]
    const { fake, dir } = setup({}, seed)
    const out = join(dir, 'export.json')
    const r1 = await cmd(fake)(`export ${out}`)
    expect(r1.kind).toBe('success')
    expect(existsSync(out)).toBe(true)
    const exported = JSON.parse(readFileSync(out, 'utf8'))
    expect(exported.items).toHaveLength(2)

    // 清空库（模拟崩溃/误删）
    writeFs(join(dir, 'memory.jsonl'), '', 'utf8')
    const r2 = await cmd(fake)(`restore ${out}`)
    expect(r2.kind).toBe('success')
    const stats = fake.toolDefs.get('memory_stats')
    expect((await stats.execute({})).total).toBe(2)
    const get = fake.toolDefs.get('memory_get')
    const a = await get.execute({ key: 'rule.a', includeFull: true }, MAIN)
    expect(a.value).toBe('值 A')
    expect(a.full).toBe('完整正文 A')
    expect(a.tags).toEqual(['x'])
    const b = await get.execute({ key: 'task.b', scope: 'work' }, MAIN)
    expect(b.found).toBe(true)
  })

  it('restore 前自动备份当前库（带回滚提示）', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const { fake, dir } = setup({}, [{ id: 'a', key: 'rule.a', value: '旧值', scope: 'global', tags: [], createdAt: now, updatedAt: now }])
    const src = join(dir, 'in.json')
    writeFs(src, JSON.stringify({ version: 1, items: [{ id: 'n', key: 'rule.new', value: '新值', scope: 'global', tags: [], createdAt: now, updatedAt: now }] }), 'utf8')
    const r = await cmd(fake)(`restore ${src}`)
    expect(r.kind).toBe('success')
    expect(r.text).toMatch(/备份|回滚/)
    const backups = readdirSync(dir).filter((f) => f.includes('pre-restore'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toContain('旧值')
  })

  it('S7：export 拒绝 UNC/设备路径', async () => {
    const { fake } = setup({}, [{ id: 'a', key: 'rule.a', value: 'v', scope: 'global', tags: [], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' }])
    const r = await cmd(fake)('export ' + '\\\\server\\share\\out.json')
    expect(r.kind).toBe('error')
    expect(r.text).toMatch(/UNC|设备路径/)
  })

  it('S7：restore 拒绝 UNC/设备路径', async () => {
    const { fake } = setup()
    const r = await cmd(fake)('restore ' + '\\\\server\\share\\in.json')
    expect(r.kind).toBe('error')
    expect(r.text).toMatch(/UNC|设备路径/)
    expect((await fake.toolDefs.get('memory_stats').execute({})).total).toBe(0)
  })

  it('S7：restore 拒绝超过 2MB 的导入文件（库不被改动）', async () => {
    const { fake, dir } = setup()
    const big = join(dir, 'big-export.json')
    // 合法 JSON 结构但超过 2MB
    writeFs(big, JSON.stringify({ version: 1, items: [{ id: 'x', key: 'rule.x', value: 'a'.repeat(2 * 1024 * 1024 + 64), scope: 'global', tags: [], createdAt: 't', updatedAt: 't' }] }), 'utf8')
    const r = await cmd(fake)('restore ' + big)
    expect(r.kind).toBe('error')
    expect(r.text).toMatch(/字节上限/)
    expect((await fake.toolDefs.get('memory_stats').execute({})).total).toBe(0)
  })

  it('非法恢复文件报错而非写库', async () => {
    const { fake, dir } = setup()
    const bad = join(dir, 'bad.json')
    writeFs(bad, '{"nonsense":1}', 'utf8')
    const r = await cmd(fake)(`restore ${bad}`)
    expect(r.kind).toBe('error')
    expect((await fake.toolDefs.get('memory_stats').execute({})).total).toBe(0)
  })
})

describe('M12 写入容量守卫', () => {
  it('达到 maxItems 后拒绝新增（提示 memory_dream），但允许更新已有条目', async () => {
    const { fake } = setup({ maxItems: 3 })
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.1', value: 'v1' }, MAIN)
    await setTool.execute({ key: 'rule.2', value: 'v2' }, MAIN)
    await setTool.execute({ key: 'rule.3', value: 'v3' }, MAIN)
    await expect(setTool.execute({ key: 'rule.4', value: 'v4' }, MAIN)).rejects.toThrow(/上限/)
    // 更新已有条目不受限
    const upd = await setTool.execute({ key: 'rule.1', value: 'v1-updated' }, MAIN)
    expect(upd.ok).toBe(true)
    expect((await fake.toolDefs.get('memory_get').execute({ key: 'rule.1' }, MAIN)).value).toBe('v1-updated')
  })
})

describe('M12 memory_dream apply 归档', () => {
  it('apply:true 时 >90 天条目 value 压缩为摘要、原文进 full', async () => {
    const longValue = '很久以前定下的结论：' + '细节'.repeat(80)
    const seed = [{ id: 'o', key: 'ref.old-doc', value: longValue, scope: 'global', tags: [], createdAt: daysAgo(120), updatedAt: daysAgo(120) }]
    const { fake } = setup({}, seed)
    const dream = fake.toolDefs.get('memory_dream')
    const before = await dream.execute({}, MAIN)
    expect(before.candidates.length).toBeGreaterThanOrEqual(1)
    const applied = await dream.execute({ apply: true }, MAIN)
    expect(applied.summary).toMatch(/归档/)
    const get = fake.toolDefs.get('memory_get')
    const item = await get.execute({ key: 'ref.old-doc', includeFull: true }, MAIN)
    expect(item.value.length).toBeLessThanOrEqual(80)
    expect(item.full).toContain('很久以前定下的结论')
  })
})

describe('M12 1000 条库检索性能', () => {
  it('memory_search 在 1000 条库上 < 200ms', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const seed = Array.from({ length: 1000 }, (_, i) => ({
      id: 'i' + i, key: 'task.item-' + i, value: '条目内容 ' + i, scope: 'global', tags: [], createdAt: now, updatedAt: now,
    }))
    const { fake } = setup({}, seed)
    const search = fake.toolDefs.get('memory_search')
    const t0 = Date.now()
    const r = await search.execute({ query: '条目内容 500' }, MAIN)
    const ms = Date.now() - t0
    expect(r.count).toBeGreaterThanOrEqual(1)
    expect(ms).toBeLessThan(200)
  })
})
