import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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

  it('client.js 渲染 6 个开关（含 rrfFirstTurnOnly）', () => {
    const client = readFileSync(join(__dirname, '..', 'src', 'client.js'), 'utf8')
    const start = client.indexOf('const FIELDS')
    const block = client.slice(start, client.indexOf('];', start) + 2)
    for (const f of ['autoRecall', 'autoCapture', 'autoRecallRerank', 'rrfRecall', 'rrfFirstTurnOnly', 'approveOnSet']) {
      expect(block).toContain('"' + f + '"')
    }
  })
})
