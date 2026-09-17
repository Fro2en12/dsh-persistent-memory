import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeSettingsService {
  register(ns: string, schema: unknown, opts?: { base?: Record<string, unknown>; applies?: string }): { get(): Record<string, unknown>; watch(fn: (next: Record<string, unknown>) => void): void }
  describe(): { ns: string; revision?: number; applies?: string }[]
  get(ns: string): unknown
  replace(ns: string, section: unknown, expectedRevision?: number): Promise<void>
  writable?: boolean
}

export interface FakeCtx {
  ctx: any
  state: Record<string, unknown>
  watchers: Array<(next: Record<string, unknown>) => void>
  toolDefs: Map<string, any>
  commandDefs: any[]
  handlers: Map<string, any[]>
  routes: any[]
  settingsService: FakeSettingsService
}

/** 构造 apply() 所需的最小 fake ctx（不加载 cordis/dsh 运行时）；services 可注入 llm/sessionQuery 等 */
export function makeFakeCtx(initState: Record<string, unknown> = {}, services: Record<string, unknown> = {}): FakeCtx {
  const state: Record<string, unknown> = { ...initState }
  let revision = 0
  const watchers: Array<(next: Record<string, unknown>) => void> = []
  const toolDefs = new Map<string, any>()
  const commandDefs: any[] = []
  const handlers = new Map<string, any[]>()
  const routes: any[] = []

  const settingsService: FakeSettingsService = {
    register(ns, _schema, opts) {
      // 对齐 DSH settings 契约：get() = schema 默认值 ← base ← 用户层
      const DEFAULTS: Record<string, unknown> = {
        autoRecall: true, autoCapture: true, autoRecallRerank: true,
        rrfRecall: true, rrfFirstTurnOnly: true, approveOnSet: false,
      }
      const base = (opts?.base as Record<string, unknown> | undefined) ?? {}
      const cur = () => ({ ...DEFAULTS, ...base, ...((state[ns] as Record<string, unknown> | undefined) ?? {}) })
      return { get: cur, watch: (fn) => { watchers.push(fn) } }
    },
    describe: () => [{ ns: 'dsh-persistent-memory', revision }],
    get: (ns) => state[ns] ?? {},
    replace: async (ns, section, expectedRevision) => {
      if (!Number.isSafeInteger(expectedRevision)) throw new Error('expectedRevision must be a non-negative integer')
      if (expectedRevision !== revision) {
        const err = new Error('settings conflict') as Error & { code: string }
        err.code = 'SETTINGS_CONFLICT'
        throw err
      }
      revision += 1
      state[ns] = section as Record<string, unknown>
      for (const w of watchers) w({ ...(section as Record<string, unknown>) })
    },
    writable: true,
  }

  const ctx: any = {
    tools: { register: (def: any) => { toolDefs.set(def.name, def) } },
    commands: { register: (def: any) => { commandDefs.push(def) } },
    effect: (fn: () => (() => void) | void) => { fn() },
    inject: (_deps: string[], cb: (webCtx: any) => void) => {
      const webCtx = {
        effect: (fn: () => (() => void) | void) => { fn() },
        webServer: { register: (opts: any) => { routes.push(opts); return () => {} } },
      }
      cb(webCtx)
    },
    on: (event: string, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event)!.push(handler)
      return () => {}
    },
    get: (svc: string) => services[svc],
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
    settings: settingsService,
  }
  return { ctx, state, watchers, toolDefs, commandDefs, handlers, routes, settingsService }
}

/** 每个用例独立的临时 dataDir，测试结束清理 */
export function makeTempDir(prefix = 'dspm-test'): string {
  const dir = join(tmpdir(), prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  return dir
}

export function cleanTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** 向临时 dataDir 写入 memory.jsonl（模拟既有记忆库） */
export function seedMemoryFile(dataDir: string, lines: unknown[]): string {
  const dataFile = join(dataDir, 'memory.jsonl')
  writeFileSync(dataFile, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''), 'utf8')
  return dataFile
}

export function makeItem(partial: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: 'id-' + Math.random().toString(36).slice(2, 10),
    key: 'rule.test',
    value: '测试内容',
    scope: 'global',
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

/** 触发一次 pre-step 的便捷封装 */
export async function runPreStep(handlers: Map<string, any[]>, payload: any): Promise<any> {
  const preStep = handlers.get('agent/pre-step')?.[0]
  if (!preStep) throw new Error('agent/pre-step handler not registered')
  const decision = { kind: 'enter', messages: [{}] }
  return preStep(payload, async () => decision)
}

export function findPluginMessages(decision: any, form: string): any[] {
  return (decision?.messages ?? []).filter((m: any) => m?.source?.kind === 'plugin' && m?.source?.form === form)
}

export function ensureNoFile(dir: string): void {
  if (existsSync(dir)) return
}
