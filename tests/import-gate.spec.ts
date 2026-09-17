import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// C3：导入路径白名单（realpath 防 symlink 逃逸 + 拒绝 \\?\/UNC/设备路径）
// M6：大小上限 2MB + 凭据闸门（命中整条丢弃）+ full 长度约束 + 默认 scope 改工作区

const tmpDirs: string[] = []
function setup(config: Record<string, unknown> = {}) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false, ...config })
  return { fake, dir }
}
function wsDir() {
  const dir = makeTempDir('dspm-ws')
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
  delete process.env.DSH_WORKSPACE
  delete process.env.DSH_WORKSPACE_NAME
})

function memFile(ws: string, name: string, content: string): string {
  const p = join(ws, name)
  writeFileSync(p, content, 'utf8')
  return p
}

describe('C3 导入路径白名单', () => {
  it('工作区外路径抛错', async () => {
    process.env.DSH_WORKSPACE = wsDir()
    const { fake } = setup()
    const outside = makeTempDir('dspm-outside')
    tmpDirs.push(outside)
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, '# x\n\n内容', 'utf8')
    const tool = fake.toolDefs.get('memory_import')
    await expect(tool.execute({ path: outsideFile })).rejects.toThrow(/只允许导入工作区内的文件/)
  })

  it('工作区内文件可导入', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'inside.md', '# 规则\n必须用 UTF8')
    const tool = fake.toolDefs.get('memory_import')
    const r = await tool.execute({ path: p, scope: 'global' })
    expect(r.imported).toBe(1)
  })

  it('symlink 指向工作区外被拒绝（realpath 后前缀判断）', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const outside = makeTempDir('dspm-outside2')
    tmpDirs.push(outside)
    writeFileSync(join(outside, 'secret.md'), '# x\n\n秘密内容', 'utf8')
    // Windows 免管理员：junction（目录链接）
    symlinkSync(outside, join(ws, 'link'), 'junction')
    const tool = fake.toolDefs.get('memory_import')
    await expect(tool.execute({ path: join(ws, 'link', 'secret.md') })).rejects.toThrow(/只允许导入工作区内的文件/)
  })

  it('拒绝 UNC 路径', async () => {
    process.env.DSH_WORKSPACE = wsDir()
    const { fake } = setup()
    const tool = fake.toolDefs.get('memory_import')
    await expect(tool.execute({ path: '\\\\server\\share\\x.md' })).rejects.toThrow(/UNC|设备路径/)
  })
})

describe('M6 导入限制', () => {
  it('超过 2MB 抛错', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'big.md', '# 大文件\n\n' + 'a'.repeat(2 * 1024 * 1024 + 1))
    const tool = fake.toolDefs.get('memory_import')
    await expect(tool.execute({ path: p })).rejects.toThrow(/字节上限/)
  })

  it('含 PRIVATE KEY 的文件 imported:0（凭据闸门整条丢弃）', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'key.md', '# 密钥\n\n-----BEGIN PRIVATE KEY-----\nMIIabc123\n-----END PRIVATE KEY-----')
    const tool = fake.toolDefs.get('memory_import')
    const r = await tool.execute({ path: p, scope: 'global' })
    expect(r.imported).toBe(0)
    expect(r.rejected).toBeGreaterThanOrEqual(1)
  })

  it('含 token 明文的内容同样被拒绝', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'tok.md', '# env\nsk-1234567890abcdef')
    const tool = fake.toolDefs.get('memory_import')
    const r = await tool.execute({ path: p, scope: 'global' })
    expect(r.imported).toBe(0)
    expect(r.rejected).toBeGreaterThanOrEqual(1)
  })

  it('JSON 导入的 full 字段施加 valueMaxChars 截断', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const long = 'x'.repeat(500)
    const p = memFile(ws, 'mem.json', JSON.stringify([{ key: 'ref.long', value: '摘要', full: long }]))
    const tool = fake.toolDefs.get('memory_import')
    await tool.execute({ path: p, scope: 'global' })
    const getTool = fake.toolDefs.get('memory_get')
    const g = await getTool.execute({ key: 'import-0.ref-long', includeFull: true })
    expect(g.found).toBe(true)
    expect(g.full.length).toBeLessThanOrEqual(241)   // 240 + 结尾省略号
  })

  it('导入默认 scope 为工作区 scope 而非 global', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    process.env.DSH_WORKSPACE_NAME = 'my-project'
    const { fake } = setup()
    const p = memFile(ws, 'note.md', '# 注意\n这是个坑')
    const tool = fake.toolDefs.get('memory_import')
    const r = await tool.execute({ path: p })
    expect(r.summary).toContain('my-project')
    const statsTool = fake.toolDefs.get('memory_stats')
    const s = await statsTool.execute({})
    expect(s.scopes['my-project']).toBe(1)
    expect(s.scopes.global).toBeUndefined()
  })
})
