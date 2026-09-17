import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, findPluginMessages, makeFakeCtx, makeItem, makeTempDir, runPreStep, seedMemoryFile } from './helpers'

// B1：设置面板 6 开关运行时生效（applyPanel 写 runtime，消费点读 runtime）
// M13：面板字段数三方一致（host 6 / client 6 / 日志动态计数）

const tmpDirs: string[] = []

function setup(config: Record<string, unknown> = {}) {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  seedMemoryFile(dir, [makeItem({ key: 'pwsh', value: 'PowerShell 7 安装路径', scope: 'global' })])
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoCapture: false, autoRecallRerank: false, ...config })
  return { fake, dir }
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

function payloadFor(sid: string, text: string) {
  return {
    agent: { session: { id: sid, header: {}, surface: undefined, events: undefined }, options: {} },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    step: 1,
    signal: undefined,
  }
}

function execFor(sid: string) {
  return { agent: { session: { id: sid, header: {} }, options: {} } }
}

const PANEL_OFF = {
  autoRecall: false, autoCapture: false, autoRecallRerank: false,
  rrfRecall: true, rrfFirstTurnOnly: true, approveOnSet: false,
}
const PANEL_ON = { ...PANEL_OFF, autoRecall: true }

describe('B1 设置面板运行时生效', () => {
  it('关闭 autoRecall 后新会话不再出现 memory-recall 注入；重新开启恢复', async () => {
    const { fake } = setup({ autoRecall: true })
    const d1 = await runPreStep(fake.handlers, payloadFor('sess-a', 'pwsh 报错'))
    expect(findPluginMessages(d1, 'memory-recall')).toHaveLength(1)

    // 面板保存：关 autoRecall（revision 0 → 1）
    await fake.settingsService.replace('dsh-persistent-memory', PANEL_OFF, 0)

    const d2 = await runPreStep(fake.handlers, payloadFor('sess-b', 'pwsh 报错'))
    expect(findPluginMessages(d2, 'memory-recall')).toHaveLength(0)

    // 重新开启（revision 1 → 2）
    await fake.settingsService.replace('dsh-persistent-memory', PANEL_ON, 1)
    const d3 = await runPreStep(fake.handlers, payloadFor('sess-c', 'pwsh 报错'))
    expect(findPluginMessages(d3, 'memory-recall')).toHaveLength(1)
  })

  it('开启 approveOnSet 后 memory_set 需 confirmed（运行时生效）', async () => {
    const { fake } = setup({ approveOnSet: false })
    const setTool = fake.toolDefs.get('memory_set')
    const r1 = await setTool.execute({ key: 'rule.a', value: 'v' }, execFor('s1'))
    expect(r1.ok).toBe(true)

    await fake.settingsService.replace('dsh-persistent-memory', { ...PANEL_ON, approveOnSet: true }, 0)

    await expect(setTool.execute({ key: 'rule.b', value: 'v' }, execFor('s1'))).rejects.toThrow(/写入审批/)
    const r3 = await setTool.execute({ key: 'rule.b', value: 'v', confirmed: true }, execFor('s1'))
    expect(r3.ok).toBe(true)
  })

  it('关闭 autoCapture 后新会话不再注入记忆守则', async () => {
    const { fake } = setup({ autoCapture: true })
    const d1 = await runPreStep(fake.handlers, payloadFor('sess-a', '随便聊聊'))
    expect(findPluginMessages(d1, 'memory-capture-guide')).toHaveLength(1)

    await fake.settingsService.replace('dsh-persistent-memory', { ...PANEL_ON, autoCapture: false }, 0)

    const d2 = await runPreStep(fake.handlers, payloadFor('sess-b', '随便聊聊'))
    expect(findPluginMessages(d2, 'memory-capture-guide')).toHaveLength(0)
  })
})

describe('M13 面板字段数三方一致', () => {
  it('settings-panel.log 动态字段数 = schema 键数（6）', async () => {
    const { dir } = setup()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const log = readFileSync(join(dir, 'settings-panel.log'), 'utf8')
    expect(log).toMatch(/fields=6/)
    expect(log).toMatch(/applies=live/)
  })

  const SWITCHES = ['autoRecall', 'autoCapture', 'autoRecallRerank', 'rrfRecall', 'rrfFirstTurnOnly', 'approveOnSet']

  /** FIELDS 数组第一列 = 真正渲染成开关的字段名（不是可选文案里的字符串碰巧命中） */
  function fieldsOf(label: string, code: string): string[] {
    const start = code.indexOf('const FIELDS')
    expect(start, label + ' 里找不到 const FIELDS 数组').toBeGreaterThanOrEqual(0)
    const end = code.indexOf('];', start)
    expect(end, label + ' 的 FIELDS 数组未闭合').toBeGreaterThan(start)
    return [...code.slice(start, end).matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1])
  }

  function readClient(label: string, file: string): string {
    expect(existsSync(file), label + ' 缺失：' + file + '。请先 pnpm build（构建产物必须与 src/client.js 同步）').toBe(true)
    return readFileSync(file, 'utf8')
  }

  it('构建产物 lib/client.js 含全部 6 个开关，且与 src/client.js 的 FIELDS 一致', () => {
    const libCode = readClient('构建产物 lib/client.js', join(__dirname, '..', 'lib', 'client.js'))
    const srcCode = readClient('源码 src/client.js', join(__dirname, '..', 'src', 'client.js'))
    const libFields = fieldsOf('构建产物 lib/client.js', libCode)
    const srcFields = fieldsOf('源码 src/client.js', srcCode)

    // ① 构建产物侧：6 个开关一个不少（漏一个 = 面板少一个开关，用户关不掉对应行为）
    expect(libFields, '构建产物 lib/client.js 的 FIELDS 字段数不是 6：请先 pnpm build').toHaveLength(6)
    for (const f of SWITCHES) {
      expect(libFields, '构建产物 lib/client.js 缺少字段 ' + f + '：请先 pnpm build').toContain(f)
    }
    // 反向：不得多出未知字段（多出来 = 面板渲染了 host 不认识的开关）
    expect(new Set(libFields)).toEqual(new Set(SWITCHES))
    // 6 个字段确实被渲染消费（避免"字段名在、渲染不读"）
    expect(libCode).toContain('FIELDS.map(')
    expect(libCode).toContain('__ModuleLoader__')

    // ② 源码侧证据（第二份客户端实现，始终存在）
    expect(srcFields).toHaveLength(6)
    for (const f of SWITCHES) expect(srcFields, '源码 src/client.js 缺少字段 ' + f).toContain(f)

    // ③ 产物与源码同步：不一致说明产物过期（线上跑的是旧面板）→ 请先 pnpm build
    expect(libFields, 'lib/client.js 与 src/client.js 的 FIELDS 不一致：请先 pnpm build').toEqual(srcFields)
  })
})
