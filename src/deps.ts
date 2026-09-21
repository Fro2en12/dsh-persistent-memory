/**
 * apply() 闭包依赖的显式打包（第 2 批拆分引入）。
 *
 * 拆分前 index.ts 的所有函数都闭包在同一份 apply() 作用域上；对这些函数做参数化不现实，
 * 故把「共享状态 + 归一化后的配置常量 + 辅助函数」打包成一个显式对象：apply() 构造一次，
 * 沿整条链路以**同一实例**传递（registerExtraction / registerPreStep / registerTools /
 * registerCommands / registerPanel / createWriteOps）。
 *
 * 硬性要求（分叉即行为变更，且现有测试可证伪）：
 * - sessionInjections 分叉 → 注入去重失效（同一会话重复注入守则/召回）；
 * - extractCounters 分叉 → 全局提取并发上限失效（M5）；
 * - runtime 分叉 → 设置面板保存后插件行为不变（B1）。
 * 因此各模块只允许 `const { … } = deps` 解构**引用类型**字段；计数器一律经
 * deps.extractCounters.globalInFlight 读写，禁止拷贝成本地 number。
 */
import type { MemoryItem } from './types.js'
import type { createStore } from './store.js'

/** searchItems 的入参（原 index.ts 内联类型，原样提取；callers 不变） */
export interface SearchItemsOptions {
  query?: string
  scope?: string
  tags?: string[]
  limit?: number
  allowedScopes?: string[]
}

/** 设置面板可写的运行时开关（B1：面板只写这里，全部消费点只读这里） */
export interface RuntimeSwitches {
  autoRecall: boolean
  autoCapture: boolean
  autoRecallRerank: boolean
  rrfRecall: boolean
  rrfFirstTurnOnly: boolean
  approveOnSet: boolean
}

/** 提取器全局并发计数（装箱：必须以同一对象引用传递，不能解构成 number） */
export interface ExtractCounters {
  globalInFlight: number
}

export interface MemoryDeps {
  // ── 配置面：apply 开头归一化后的常量 ──
  dataDir: string
  dataFile: string
  defaultScope: string
  maxResults: number
  autoRecall: boolean
  autoRecallLimit: number
  autoRecallMaxChars: number
  autoRecallBudgetChars: number
  injectionBudgetChars: number
  autoRecallMinScore: number
  autoRecallRelativeFloor: number
  autoRecallScope: string
  autoRecallFallback: boolean
  autoCapture: boolean
  autoExtract: boolean
  autoExtractCooldownMs: number
  autoRecallOnce: boolean
  autoRecallCooldownMs: number
  rrfRecall: boolean
  rrfFirstTurnOnly: boolean
  approveOnSet: boolean
  synonymExpansion: boolean
  dedupeOnSet: boolean
  autoRecallRerank: boolean
  taskTtlDays: number
  autoRecallRerankMax: number
  valueMaxChars: number
  fullMaxChars: number
  allowCredentialReveal: boolean
  redactPatterns: string[]
  maxItems: number

  // ── 运行时开关：面板写、消费点读，必须是同一个对象引用 ──
  runtime: RuntimeSwitches

  // ── store 面 ──
  store: ReturnType<typeof createStore>
  readItems: () => Promise<MemoryItem[]>
  writeItems: (items: MemoryItem[]) => Promise<void>
  withLock: <T>(fn: () => Promise<T>) => Promise<T>
  searchItems: (options: SearchItemsOptions) => Promise<{ count: number; items: MemoryItem[] }>

  // ── 会话状态：引用传递（Map/Set 可解构；计数器必须经 extractCounters 读写）──
  sessionInjections: Map<string, number>
  persistInjectionState: () => void
  turnBuffers: Map<string, string[]>
  lastExtractAt: Map<string, number>
  lastManualWriteAt: Map<string, number>
  extractingSessions: Set<string>
  extractCounters: ExtractCounters

  // ── 工具函数 ──
  makeId: () => string
  normalizeTags: (tags?: string[]) => string[]
  setBounded: <K, V>(map: Map<K, V>, key: K, value: V, max?: number) => void
  isSubagentAgent: (agent: any) => boolean
  currentWorkspaceScopes: () => string[]
  shouldMaskOutbound: (key: string, value: string) => boolean
}
