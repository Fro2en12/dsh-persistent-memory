import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { MAX_DEPTH, importPrefixFor, parseImportEntries, slugKey, walk } from '../src/import'
import type { ImportEntry } from '../src/import'
import { KEY_PREFIX_WHITELIST } from '../src/types'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M7：导入 key 的根前缀必须落在 KEY_PREFIX_WHITELIST 内。修复前 JSON 分支硬编码根前缀 'import'，
//     不在白名单 → 导入的记忆成为「只写不改」的孤儿（事后 memory_set 同 key 会被前缀校验拒绝）。
// m10：slugKey 把 a.b / a-b / a_b 折叠成同一 slug，同一路径下的多条条目撞 key，
//      第 2 条起被导入闸门「内容相似 ≥70% 跳过」静默丢弃 → 同一次调用内 key 唯一化。
// m11：walk 无深度上限，5000+ 层嵌套 JSON 会抛 RangeError: Maximum call stack size exceeded。

const tmpDirs: string[] = []
function setup(config: Record<string, unknown> = {}) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false, ...config })
  return { fake, dir }
}
function wsDir(): string {
  const dir = makeTempDir('dspm-ws')
  tmpDirs.push(dir)
  return dir
}
function memFile(ws: string, name: string, content: string): string {
  const p = join(ws, name)
  writeFileSync(p, content, 'utf8')
  return p
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
  delete process.env.DSH_WORKSPACE
  delete process.env.DSH_WORKSPACE_NAME
})

const JSON_OPTS = { valueMaxChars: 240 }
const firstSeg = (key: string): string => key.split('.')[0]
/** 分类首段：'ref.0.x' → 'ref'（'.0' 是 walk 的数组序号段，分类段始终是第一段） */
const categorySeg = (key: string): string => firstSeg(key).split('-')[0]
const keysOf = (entries: ImportEntry[]): string[] => entries.map((e) => e.key)

/** 6000 层嵌套对象链，叶子是带 value 的条目 */
function buildDeep(depth: number): unknown {
  let cur: unknown = { value: '最深层条目' }
  for (let i = 0; i < depth; i++) cur = { ['k' + i]: cur }
  return cur
}
/** 6000 层嵌套的 JSON 文本（叶子是字符串，walk 只递归不产出条目） */
function deepJsonText(depth: number): string {
  return '{"a":'.repeat(depth) + '"v"' + '}'.repeat(depth)
}

describe('M7 导入根前缀必须在白名单内', () => {
  it('嵌套对象根 JSON：每个 key 的首段（split(".")[0]）都在 KEY_PREFIX_WHITELIST 内', () => {
    const raw = JSON.stringify({
      memories: [{ key: 'a.b', value: '必须使用 UTF8 编码' }],
      env: { key: 'node', value: '第二条' },
      deep: { inner: { key: 'x', value: '第三条' } },
    })
    const entries = parseImportEntries(raw, 'C:/tmp/memories.json', JSON_OPTS)
    expect(entries).toHaveLength(3)
    for (const e of entries) expect(KEY_PREFIX_WHITELIST).toContain(firstSeg(e.key))
  })

  it('数组根 JSON：key 形如 ref.0.x，分类首段 ref 在白名单内（修复前是 import-0，非法）', () => {
    const raw = JSON.stringify([
      { key: 'x', value: '必须使用 UTF8 编码' },
      { key: 'y', value: '普通说明文本' },
    ])
    const entries = parseImportEntries(raw, 'C:/tmp/memories.json', JSON_OPTS)
    expect(keysOf(entries)).toEqual(['ref.0.x', 'ref.1.y'])
    for (const e of entries) expect(KEY_PREFIX_WHITELIST).toContain(categorySeg(e.key))
    for (const e of entries) expect(e.key.startsWith('import')).toBe(false)
  })

  it('JSON 根前缀不再是 import（否则 key 首段非法，memory_set 无法更新）', () => {
    const entries = parseImportEntries(JSON.stringify({ prefs: { key: 'x', value: 'v' } }), 'C:/tmp/memories.json', JSON_OPTS)
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe('ref.prefs.x')
    expect(firstSeg(entries[0].key)).toBe('ref')
  })

  it('工具级：对象根导入的 key 可用 memory_set 同 key 更新（不再是只写不改的孤儿）', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'memories.json', JSON.stringify({ prefs: { key: 'x', value: '初始值' } }))
    const imp = fake.toolDefs.get('memory_import')
    const r = await imp.execute({ path: p, scope: 'my-project' })
    expect(r.imported).toBe(1)
    const get = fake.toolDefs.get('memory_get')
    expect((await get.execute({ key: 'ref.prefs.x', scope: 'my-project' })).found).toBe(true)
    // 修复前 key 是 import.prefs.x → 这里会以「key 前缀 import 不在分类白名单」被拒
    const set = fake.toolDefs.get('memory_set')
    const upd = await set.execute({ key: 'ref.prefs.x', value: '更新后的值', scope: 'my-project' })
    expect(upd.ok).toBe(true)
    expect(upd.key).toBe('ref.prefs.x')
  })

  it('数组根导入的 key 可用 memory_set 同 key 更新（不再是只写不改的孤儿）', async () => {
    // walk 的数组序号改用 '.' 拼接后 key 形如 ref.0.x，首段 'ref' 在白名单内：
    // 数组根 JSON 正是 Claude Code memories.json 的形态，必须可事后维护。
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'array.json', JSON.stringify([{ key: 'x', value: '数组根条目' }]))
    const imp = fake.toolDefs.get('memory_import')
    const r = await imp.execute({ path: p, scope: 'my-project' })
    expect(r.imported).toBe(1)
    const set = fake.toolDefs.get('memory_set')
    const upd = await set.execute({ key: 'ref.0.x', value: '更新后的值', scope: 'my-project' })
    expect(upd.ok).toBe(true)
    const get = fake.toolDefs.get('memory_get')
    expect((await get.execute({ key: 'ref.0.x', scope: 'my-project' })).value).toBe('更新后的值')
  })
})

describe('M7 importPrefixFor：白名单内保留，否则按内容判定', () => {
  it('白名单内的 sourcePrefix 原样返回（不被内容改写）', () => {
    for (const prefix of KEY_PREFIX_WHITELIST) expect(importPrefixFor(prefix, '必须使用 UTF8 编码')).toBe(prefix)
  })

  it('非白名单 sourcePrefix 按内容判 rule/lesson，兜底 ref', () => {
    expect(importPrefixFor('import', '必须使用 UTF8 编码')).toBe('rule')
    expect(importPrefixFor('import', '这里有个坑，切记别踩')).toBe('lesson')
    expect(importPrefixFor('import', '这是背景说明文本')).toBe('ref')
    expect(importPrefixFor('', '不要直接改 main')).toBe('rule')
  })

  it('返回值永远落在白名单内', () => {
    for (const prefix of ['import', 'whatever', '', 'IMPORT']) {
      for (const content of ['必须做某事', '切记这个坑', '普通内容']) {
        expect(KEY_PREFIX_WHITELIST).toContain(importPrefixFor(prefix, content))
      }
    }
  })
})

describe('m10 slugKey 折叠：同一次导入内 key 唯一', () => {
  it('前提：a.b / a-b / a_b 三种写法折叠成同一 slug', () => {
    expect(slugKey('a.b')).toBe('a-b')
    expect(slugKey('a-b')).toBe('a-b')
    expect(slugKey('a_b')).toBe('a-b')
  })

  it('同一路径下的 a.b / a-b / a_b 三个源键 → 三个互不相同的 key', () => {
    const raw = JSON.stringify([{
      'a.b': { key: 'a.b', value: '第一个值' },
      'a-b': { key: 'a-b', value: '第二个值' },
      'a_b': { key: 'a_b', value: '第三个值' },
    }])
    const entries = parseImportEntries(raw, 'C:/tmp/memories.json', JSON_OPTS)
    expect(entries).toHaveLength(3)
    // 修复前三条都是 import.a-b.a-b（Set.size = 1），第 2/3 条被相似度闸门静默丢弃
    expect(keysOf(entries)).toEqual(['ref.0.a-b.a-b', 'ref.0.a-b.a-b-2', 'ref.0.a-b.a-b-3'])
    expect(new Set(keysOf(entries)).size).toBe(3)
  })

  it('工具级：三个碰撞源键的条目全部进入导入流程，键不再塌成 1 个', async () => {
    const ws = wsDir()
    process.env.DSH_WORKSPACE = ws
    const { fake } = setup()
    const p = memFile(ws, 'keys.json', JSON.stringify([{
      'a.b': { key: 'a.b', value: '第一个值' },
      'a-b': { key: 'a-b', value: '第二个值' },
      'a_b': { key: 'a_b', value: '第三个值' },
    }]))
    const imp = fake.toolDefs.get('memory_import')
    const r = await imp.execute({ path: p, scope: 'my-project' })
    // m10 + 批内不去重：三个碰撞源键产出三个独立 key，全部真正落盘（修复前 1 新增 + 2 跳过）
    expect(r.imported).toBe(3)
    expect(r.skipped).toBe(0)
    const get = fake.toolDefs.get('memory_get')
    expect((await get.execute({ key: 'ref.0.a-b.a-b', scope: 'my-project' })).found).toBe(true)
    expect((await get.execute({ key: 'ref.0.a-b.a-b-2', scope: 'my-project' })).found).toBe(true)
    expect((await get.execute({ key: 'ref.0.a-b.a-b-3', scope: 'my-project' })).found).toBe(true)
  })
})

describe('m11 walk 深度上限（无界递归 → 截断，不抛 RangeError）', () => {
  it('6000 层嵌套对象链：walk 不抛 RangeError', () => {
    const entries: ImportEntry[] = []
    expect(() => walk(buildDeep(6000), 'ref', entries)).not.toThrow()
  })

  it('6000 层嵌套 JSON 文本：parseImportEntries 不抛 RangeError', () => {
    expect(() => parseImportEntries(deepJsonText(6000), 'C:/tmp/deep.json', JSON_OPTS)).not.toThrow()
  })

  it('MAX_DEPTH 以内的正常嵌套照常产出条目（不误伤）', () => {
    const entries: ImportEntry[] = []
    walk(buildDeep(MAX_DEPTH), 'ref', entries)
    expect(entries).toHaveLength(1)
    expect(entries[0].value).toBe('最深层条目')
  })

  it('超过 MAX_DEPTH 的分支被跳过：不抛错、不产出', () => {
    const entries: ImportEntry[] = []
    walk(buildDeep(MAX_DEPTH + 1), 'ref', entries)
    expect(entries).toHaveLength(0)
  })

  it('超深 JSON 里浅层条目仍完整导入', () => {
    const raw = '{"top":' + JSON.stringify([{ key: 'shallow', value: '浅层条目' }]) + ',"deep":' + deepJsonText(6000) + '}'
    const entries = parseImportEntries(raw, 'C:/tmp/mixed.json', JSON_OPTS)
    expect(keysOf(entries)).toEqual(['ref.top.0.shallow'])
  })
})

describe('md 分支：前缀仍按内容判定', () => {
  it('必须 → rule，教训/切记 → lesson，其余 → ref', () => {
    const md = [
      '# 编码规范', '必须使用 UTF8 编码',
      '', '# 踩坑记录', '切记别在高峰期发布',
      '', '# 背景说明', '这是普通背景信息',
    ].join('\n')
    const entries = parseImportEntries(md, 'C:/tmp/MEMORY.md', JSON_OPTS)
    expect(keysOf(entries).map(firstSeg)).toEqual(['rule', 'lesson', 'ref'])
  })

  it('md 每个 key 的首段都在白名单内', () => {
    const md = ['# 标题', '必须做某事', '', '# 笔记', '这是背景信息'].join('\n')
    const entries = parseImportEntries(md, 'C:/tmp/MEMORY.md', JSON_OPTS)
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) expect(KEY_PREFIX_WHITELIST).toContain(firstSeg(e.key))
  })

  it('md 段落撞名时同样唯一化（同一次调用内不重复 key）', () => {
    const md = ['# 规则', '必须做 A 事', '', '# 规则', '必须做 B 事'].join('\n')
    const entries = parseImportEntries(md, 'C:/tmp/MEMORY.md', JSON_OPTS)
    expect(keysOf(entries)).toEqual(['rule.规则', 'rule.规则-2'])
  })
})
