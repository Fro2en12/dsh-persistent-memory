import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M9 集成冒烟：apply() 在最小 fake ctx 上完成注册，工具可执行、数据落盘。
// 同时证明 vitest 可以加载 index.ts 的运行时依赖（dsh-tools / schemastery / cordis 类型）。

const tmpDirs: string[] = []

function setup(config: Record<string, unknown> = {}) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', ...config })
  return { fake, dir }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanTempDir(dir)
})

const exec = { agent: { session: { id: 'sess-1', header: {} }, options: {} } }

describe('M9 集成冒烟：apply + 工具注册', () => {
  it('apply 注册全部 8 个工具与 /memory 命令', () => {
    const { fake } = setup()
    const names = ['memory_set', 'memory_get', 'memory_search', 'memory_forget', 'memory_stats', 'memory_dream', 'memory_import', 'memory_recall']
    for (const n of names) expect(fake.toolDefs.has(n), '缺少工具 ' + n).toBe(true)
    expect(fake.commandDefs.some((c) => c.name === 'memory')).toBe(true)
  })

  it('memory_set → 落盘 → memory_get → memory_stats 闭环', async () => {
    const { fake, dir } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    const r = await setTool.execute({ key: 'user.name', value: '张三', scope: 'global', tags: ['人'] }, exec)
    expect(r.ok).toBe(true)
    expect(r.created).toBe(true)

    const dataFile = join(dir, 'memory.jsonl')
    expect(existsSync(dataFile)).toBe(true)
    expect(readFileSync(dataFile, 'utf8')).toContain('user.name')

    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'user.name' })
    expect(g.found).toBe(true)
    expect(g.value).toBe('张三')

    const statsTool = fake.toolDefs.get('memory_stats')
    const s = await statsTool.execute({})
    expect(s.total).toBe(1)
    expect(s.scopes.global).toBe(1)
  })

  it('memory_search 命中关键词', async () => {
    const { fake } = setup()
    const setTool = fake.toolDefs.get('memory_set')
    await setTool.execute({ key: 'rule.utf8', value: 'PowerShell 写中文加 -Encoding UTF8' }, exec)
    const searchTool = fake.toolDefs.get('memory_search')
    const s = await searchTool.execute({ query: 'powershell' }, exec)
    expect(s.count).toBe(1)
    expect(s.items[0].key).toBe('rule.utf8')
  })
})
