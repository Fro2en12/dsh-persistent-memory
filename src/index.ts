/**
 * @dsh-external/dsh-persistent-memory — DSH 持久记忆插件（toolkit + 自动召回）。
 *
 * 能力：
 * - 跨会话保存/检索用户偏好、项目事实、任务状态等键值记忆；
 * - 数据落盘到 $DSH_HOME/dsh-persistent-memory/memory.jsonl，重启不丢；
 * - 支持 scope（默认 global）与 tags，可按关键词/标签搜索；
 * - 自动浮现：agent/pre-step 时自动召回相关/最近记忆并注入上下文，
 *   无需用户每次提醒。
 *
 * 规范：资源注册必须挂 ctx.effect / ctx.on（热重载/卸载自动清理）。
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'
// C5/M10：DSH 官方 delegation depth（monotone：Math.max(header, runtime options)）。
// 说明：报告建议的 '@deepseek-ai/dsh-subagent/depth' 子路径不在该包 exports 表中
// （运行时 ERR_PACKAGE_PATH_NOT_EXPORTED），主入口官方 re-export delegationDepthOf，故从主入口导入。
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { MemoryItem } from './types.js'
import { sanitizeValue } from './sanitize.js'
import { isCredentialItem, matchesRedactPattern, normalizeScope } from './write-gate.js'
import { createStore, withConflictRetry, type StoreFileHandle, type StoreFs } from './store.js'
import { PLUGIN_NAME } from './const.js'
import type { ExtractCounters, MemoryDeps } from './deps.js'
import { registerExtraction } from './extract.js'
import { registerPreStep } from './pre-step.js'
import { createWriteOps, isCompletedMark, MAX_IMPORT_BYTES } from './write-ops.js'
import { buildPanelHtml, registerPanel } from './panel.js'
import { registerTools } from './tools.js'

export const name = PLUGIN_NAME
export const inject = ['tools', 'commands', 'settings']


export interface Config {
  /** 记忆库目录；缺省为 $DSH_HOME/dsh-persistent-memory */
  dataDir?: string
  defaultScope?: string
  /** search/stats 返回条数上限 */
  maxResults?: number
  /** 是否在每轮请求前自动召回并注入记忆 */
  autoRecall?: boolean
  /** 自动召回最多注入条数 */
  autoRecallLimit?: number
  /** 自动召回每条 value 最大展示字符数 */
  autoRecallMaxChars?: number
  /** 单次召回注入的字符预算（默认 600）：超出按分数顺序截断，防止一次塞太多 */
  autoRecallBudgetChars?: number
  /** 非首轮召回的绝对分数下限（默认 3；v0.1.17 前为 1，过松导致无关记忆被注入） */
  autoRecallMinScore?: number
  /** 相对阈值（默认 0.5）：低于最高分该比例的记忆不注入；0 表示禁用 */
  autoRecallRelativeFloor?: number
  /** 自动召回限定作用域；空串表示不限定 */
  autoRecallScope?: string
  /** 没有相关匹配时是否回退注入最近记忆（默认 false，避免无关上下文污染） */
  autoRecallFallback?: boolean
  /** 是否注入“自动记忆守则”，让模型自己发现并总结值得记住的信息 */
  autoCapture?: boolean
  /** 单轮「教训+召回+索引」的字符总预算（默认 1200，下限 300）。守则是每会话固定成本，不计入此额度 */
  injectionBudgetChars?: number
  /** 每个会话只自动注入一次记忆；冷却期内不重复注入（默认 true） */
  autoRecallOnce?: boolean
  /** 自动注入冷却毫秒数；同一会话在该窗口内不重复注入（默认 10 分钟） */
  autoRecallCooldownMs?: number
  /** 启用同义词扩展评分（代理↔梯子↔vpn、认证↔登录↔凭据等，默认 true） */
  synonymExpansion?: boolean
  /** memory_set 时对同 scope 高相似 key 自动合并更新，避免记忆库膨胀（默认 true） */
  dedupeOnSet?: boolean
  /** 启用 LLM 语义重排：词法预筛候选 → LLM 选 3~5 条（对标 Claude Code findRelevantMemories） */
  autoRecallRerank?: boolean
  /** 语义重排时 LLM 可选的记忆条数上限 */
  autoRecallRerankMax?: number
  /** 写入 RRF 混合召回（词法+中文二元组双排名融合），词法 0 命中时按语义补位（默认 true） */
  rrfRecall?: boolean
  /** RRF 语义补位是否只在首轮生效（默认 true）：非首轮词法被阈值过滤 = 整体不相关，宁可不注入 */
  rrfFirstTurnOnly?: boolean
  /** 写入前需用户确认：开启后 memory_set 必须带 confirmed=true 才落盘（默认 false） */
  approveOnSet?: boolean
  /** value 摘要存储上限（默认 240）：超长自动句边界截断，完整原文归档进 full，不拒绝写入 */
  valueMaxChars?: number
  /** full 完整正文总长上限（默认 8000）：超出截断，避免同一 key 反复更新导致无限膨胀 */
  fullMaxChars?: number
  /**
   * M12 记忆库条数上限（默认 2000）：新增条目会使总数超过该值时拒绝写入（更新已有条目不受限），
   * 并提示跑 memory_dream 归档/清理；救援通道 /memory restore 不受此限。
   */
  maxItems?: number
  /** task.* 保鲜期（天，默认 30）：超期在召回评分中降权，避免过时任务状态被当成现状 */
  taskTtlDays?: number
  /** 轮末自动提取（默认 true）：每轮结束后异步回顾对话、沉淀高置信记忆，不依赖主模型当轮意愿 */
  autoExtract?: boolean
  /** memory_import 允许的根目录白名单；缺省为 [DSH_WORKSPACE]（无环境变量时拒绝导入） */
  importAllowRoots?: string[]
  /**
   * T10（第五轮）：是否允许通过 memory_get 的 confirmed:true 取回 auth.* 与凭据类记忆的原文。
   * 默认 false —— confirmed 是模型自己填的 schema 参数，不构成用户授权；只有部署者在这里
   * 显式开启（视为部署者授权）才提供取回路径。
   */
  allowCredentialReveal?: boolean
  /** T11（第五轮）：自定义敏感词（正则源串）。命中者出库即掩码（不做写侧拒绝），与固定凭据正则取并集 */
  redactPatterns?: string[]
  /** 自动提取冷却毫秒数（默认 120 秒）：同一会话该窗口内不重复提取 */
  autoExtractCooldownMs?: number
}

export const Config = z.object({
  dataDir: z.string().default(''),
  defaultScope: z.string().default('global'),
  maxResults: z.number().default(20),
  autoRecall: z.boolean().default(true),
  autoRecallLimit: z.number().default(2),
  autoRecallMaxChars: z.number().default(160),
  autoRecallBudgetChars: z.number().default(300),
  autoRecallMinScore: z.number().default(3),
  autoRecallRelativeFloor: z.number().default(0.5),
  autoRecallScope: z.string().default(''),
  autoRecallFallback: z.boolean().default(false),
  autoCapture: z.boolean().default(true),
  autoRecallOnce: z.boolean().default(true),
  autoRecallCooldownMs: z.number().default(10 * 60 * 1000),
  synonymExpansion: z.boolean().default(true),
  dedupeOnSet: z.boolean().default(true),
  autoRecallRerank: z.boolean().default(true),
  autoRecallRerankMax: z.number().default(5),
  rrfRecall: z.boolean().default(true),
  rrfFirstTurnOnly: z.boolean().default(true),
  approveOnSet: z.boolean().default(false),
  valueMaxChars: z.number().default(240),
  fullMaxChars: z.number().default(8000),
  maxItems: z.number().default(2000),
  taskTtlDays: z.number().default(30),
  autoExtract: z.boolean().default(true),
  autoExtractCooldownMs: z.number().default(120 * 1000),
  injectionBudgetChars: z.number().default(1200),
  importAllowRoots: z.array(z.string()).default([]),
  allowCredentialReveal: z.boolean().default(false),
  redactPatterns: z.array(z.string()).default([]),
})


export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = config.dataDir || join(dshHome, 'dsh-persistent-memory')
  const dataFile = join(dataDir, 'memory.jsonl')
  const defaultScope = config.defaultScope || 'global'
  const maxResults = Math.max(1, config.maxResults || 20)
  const autoRecall = config.autoRecall !== false
  const autoRecallLimit = Math.max(1, Math.min(20, config.autoRecallLimit || 2))
  const autoRecallMaxChars = Math.max(40, config.autoRecallMaxChars || 160)
  // 注入预算（v0.1.16，对标 mem0 的 top_k + Letta 的 memory block 字符上限）：
  // 条数上限管不住"每条都很长"的情况，字符预算才能给出可预测的上下文开销。
  // v0.1.20：600 → 300。单条成本 ≈ 截断后正文 + key + 固定包装 ≈ 200 字，
  // 300 的预算意味着实际多为 1 条、偶尔 2 条——自动注入只负责"提个醒"，取全用 memory_search。
  const autoRecallBudgetChars = Math.max(120, config.autoRecallBudgetChars || 300)
  // M11 会话级总预算（v0.1.23）：修复前四通道各有独立预算、守则与索引完全不受约束，
  // 最坏单轮 ≈ 守则 3000 + 教训 300 + 召回 300 + 索引 160，而用户以为旋钮是 300。
  const injectionBudgetChars = Math.max(300, config.injectionBudgetChars || 1200)
  // 召回阈值（v0.1.17）：绝对下限挡"整体都不相关"，相对比例挡"矮子里拔将军"。
  // 参考 mem0 的 threshold（归一化相似度绝对门槛）与 Zep 的 limit + reranker 两级做法。
  const autoRecallMinScore = Math.max(0, config.autoRecallMinScore ?? 3)
  const autoRecallRelativeFloor = Math.max(0, Math.min(1, config.autoRecallRelativeFloor ?? 0.5))
  const autoRecallScope = (config.autoRecallScope || '').trim()
  const autoRecallFallback = config.autoRecallFallback === true
  const autoCapture = config.autoCapture !== false
  const autoExtract = config.autoExtract !== false
  const autoExtractCooldownMs = Math.max(30_000, config.autoExtractCooldownMs ?? 120 * 1000)
  const autoRecallOnce = config.autoRecallOnce !== false
  const autoRecallCooldownMs = Math.max(0, config.autoRecallCooldownMs ?? 10 * 60 * 1000)
  const rrfRecall = config.rrfRecall !== false
  // 补位收口（v0.1.18）：非首轮词法被阈值过滤说明整体不相关，此时再语义补位等于
  // 用另一条通道放回排名靠前的记忆（0.025 ≈ 综合前 20）。首轮保留兜底。
  const rrfFirstTurnOnly = config.rrfFirstTurnOnly !== false
  const approveOnSet = config.approveOnSet === true
  const synonymExpansion = config.synonymExpansion !== false
  const dedupeOnSet = config.dedupeOnSet !== false
  const autoRecallRerank = config.autoRecallRerank !== false
  // task.* 保鲜期（v0.1.16）：任务状态变化快，超期记忆在评分里降权而不是删除（保留可查）。
  const taskTtlDays = Math.max(1, config.taskTtlDays || 30)
  const autoRecallRerankMax = Math.max(1, Math.min(8, config.autoRecallRerankMax || 5))
  // value 存储上限（写侧，v0.1.15）：与注入展示上限 autoRecallMaxChars（160）分离——
  // 展示截断只影响本次注入 token 预算；存储摘要上限决定"自足摘要能写多全"。
  const valueMaxChars = Math.max(120, config.valueMaxChars || 240)
  // m9：full 总长上限——修复前同一 key 反复超长更新会把原文一再追加进 full，无限膨胀
  const fullMaxChars = Math.max(1000, config.fullMaxChars || 8000)
  // T10/T11（第五轮）：凭据揭示开关与自定义敏感词
  const allowCredentialReveal = config.allowCredentialReveal === true
  const redactPatterns = Array.isArray(config.redactPatterns)
    ? config.redactPatterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '')
    : []
  /** 出库掩码判定：固定凭据正则 ∪ 自定义敏感词 */
  const shouldMaskOutbound = (key: string, value: string): boolean =>
    isCredentialItem(key, value) || matchesRedactPattern(value, redactPatterns)
  // M12 容量守卫（v0.1.23）：条数无上限时，召回扫描与「整库重写」I/O 都随库线性劣化。
  // 默认 2000，可按需调小（小库/测试场景）；只挡「新增」——更新已有条目永远放行。
  const maxItems = Math.max(1, Math.floor(Number(config.maxItems) || 2000))

  // ── 运行时开关（B1 修复，v0.1.23）───────────────────────────────────
  // 设置面板 applyPanel 只写 runtime；全部消费点只读 runtime。
  // 修复前 6 个开关写入 config 对象而消费点读 apply 开头的闭包常量，
  // 面板保存后插件行为完全不变（UI 却宣称"已保存并生效"）。
  const runtime = {
    autoRecall,
    autoCapture,
    autoRecallRerank,
    rrfRecall,
    rrfFirstTurnOnly,
    approveOnSet,
  }

  // 串行化读写，避免并发写坏 JSONL
  let queue: Promise<unknown> = Promise.resolve()
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  // 文件级缓存与读写实现已提取到 store.ts（fs 可注入，便于故障注入测试）
  const storeFs: StoreFs = {
    stat: (p) => fs.stat(p),
    readFile: (p) => fs.readFile(p, 'utf8'),
    mkdir: (p, o) => fs.mkdir(p, o),
    open: (p, f) => fs.open(p, f).then((fh) => fh as unknown as StoreFileHandle),
    rename: (a, b) => fs.rename(a, b),
    copyFile: (a, b) => fs.copyFile(a, b),
    unlink: (p) => fs.unlink(p),
    utimes: (p, t) => fs.utimes(p, new Date(t), new Date(t)),
  }
  const store = createStore({ fs: storeFs, dataDir, dataFile, defaultScope, makeId, now: () => new Date().toISOString() })
  const readItems = (): Promise<MemoryItem[]> => store.readItems()
  const writeItems = (items: MemoryItem[]): Promise<void> => store.writeItems(items)

  // M8：启动时一次性迁移历史数据里的大小写非规范 scope（改前的手工编辑/旧版本产物）
  async function migrateScopeCase(): Promise<void> {
    try {
      const renamed = await withLock(() => withConflictRetry(async () => {
        const items = await readItems()
        const changed: string[] = []
        let dirty = false
        for (const item of items) {
          const lower = item.scope.toLowerCase()
          if (lower !== item.scope) {
            changed.push(item.key + '(' + item.scope + ' → ' + lower + ')')
            item.scope = lower
            dirty = true
          }
        }
        if (!dirty) return [] as string[]
        await writeItems(items)
        return changed
      }))
      if (renamed.length > 0) {
        ctx.logger.warn('dsh-persistent-memory: 启动迁移：%d 条记忆的 scope 已归一为小写：%s', renamed.length, renamed.slice(0, 20).join('、'))
      }
    } catch (err) {
      ctx.logger.warn('dsh-persistent-memory: scope 归一迁移失败（不影响使用）：%o', err)
    }
  }
  void migrateScopeCase()

  // 检索公共实现：memory_search 工具与 /memory recall 命令共用
  async function searchItems(options: {
    query?: string
    scope?: string
    tags?: string[]
    limit?: number
    allowedScopes?: string[]
  }): Promise<{ count: number; items: MemoryItem[] }> {
    const query = String(options.query || '').trim().toLowerCase()
    const scopeFilter = options.scope ? normalizeScope(options.scope, defaultScope) : undefined
    const tagsFilter = normalizeTags(options.tags)
    const limit = Math.max(1, Math.min(100, Number(options.limit) || maxResults))
    return withLock(async () => {
      const items = await readItems()
      const matched = items.filter((item) => {
        if (options.allowedScopes && !options.allowedScopes.includes(item.scope)) return false
        if (scopeFilter && item.scope !== scopeFilter) return false
        if (tagsFilter.length && !tagsFilter.every((tag) => item.tags.includes(tag))) return false
        if (query) {
          const haystack = [item.key, item.value, item.scope, ...item.tags].join(' ').toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      return { count: matched.length, items: matched.slice(0, limit) }
    })
  }


  function normalizeTags(tags?: string[]): string[] {
    if (!Array.isArray(tags)) return []
    return tags.map((t) => String(t).trim()).filter(Boolean)
  }

  function makeId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  // ── 改进支撑设施 ──────────────────────────────────────────────────────
  // ① 会话级注入记录：sessionId → 上次注入时间戳（每会话一次 + 冷却期）。
  // v0.1.19 持久化到 dataDir/session-injections.json：内存 Map 重启即清空，
  // 而注入是追加到会话历史的、无法撤回——实测同一会话重启 5 次就攒了 5 份守则
  // 与 5 份召回（8722 字，本应 888 字）。落盘后"每会话一次"跨重启成立。
  const injectionStateFile = join(dataDir, 'session-injections.json')
  const INJECTION_STATE_TTL_MS = 30 * 86_400_000
  const sessionInjections = new Map<string, number>()

  function loadInjectionState(): void {
    try {
      if (!existsSync(injectionStateFile)) return
      const raw = JSON.parse(readFileSync(injectionStateFile, 'utf8')) as { entries?: Record<string, number> }
      const now = Date.now()
      for (const [key, ts] of Object.entries(raw?.entries ?? {})) {
        if (typeof ts === 'number' && now - ts < INJECTION_STATE_TTL_MS) sessionInjections.set(key, ts)
      }
    } catch {
      // 状态文件损坏/不可读：按空状态继续，最坏退回"每次重启重新注入"的旧行为
    }
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  async function persistInjectionStateNow(): Promise<void> {
    try {
      await fs.mkdir(dataDir, { recursive: true })
      const entries: Record<string, number> = {}
      for (const [key, ts] of sessionInjections) entries[key] = ts
      await fs.writeFile(injectionStateFile, JSON.stringify({ version: 1, entries }), 'utf8')
    } catch {
      // 写失败只降低去重效果，不阻塞注入流程
    }
  }
  function persistInjectionState(): void {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistInjectionStateNow()
    }, 500)
    persistTimer.unref?.()
  }
  // m7：卸载/热重载时 flush——否则进程在 500ms 去抖窗口内退出会丢掉本次注入记录，
  // 重启后同一会话重复注入守则/召回
  ctx.effect(() => () => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    void persistInjectionStateNow()
  }, 'dsh-persistent-memory: flush injection state')

  loadInjectionState()

  // ② 工作区感知：环境变量优先（harness 下 process.cwd() 是 host 进程目录，非当前工作区），cwd 仅兜底
  let workspaceScopesCache: string[] | null = null
  function currentWorkspaceScopes(): string[] {
    if (workspaceScopesCache) return workspaceScopesCache
    const scopes = new Set<string>()
    for (const envName of ['DSH_WORKSPACE', 'DSH_WORKSPACE_NAME', 'DSH_SESSION_WORKSPACE']) {
      const v = process.env[envName]
      if (v && v.trim()) scopes.add(v.trim().toLowerCase())
    }
    try {
      const base = basename(process.cwd()).toLowerCase()
      if (base) scopes.add(base)
    } catch { /* ignore */ }
    workspaceScopesCache = [...scopes]
    return workspaceScopesCache
  }



  // ── 记忆新鲜度（借鉴 Claude Code memoryAge.ts）────────────────────────
  // 天龄显示：今天/昨天/N 天前。模型对原始 ISO 时间戳的"过期感"很差，
  // "47 天前"比 ISO 串更能触发过期推理。


  /** M11：入参已由调用方按「min(单通道预算, 剩余总预算)」裁剪 */


  /** M11：入参已由调用方按「min(单通道预算, 剩余总预算)」裁剪 */









  // 子代理探测（C5/M10，v0.1.23；S2 加固，v0.1.24）：只有「能明确证明是主会话」才返回 false——
  // 会话身份（session.id）、header、runtime options 齐备 + 深度 0 + 无任何子代理标记，
  // 任何一项缺失或不确定一律按子代理（fail-closed）。不依赖上游 delegationDepthOf 抛错兜底：
  // 上游只在 options 缺失/subagentDepth 畸形时抛，{session:{header:{}}, options:{}} 会返回 0。
  //
  // 为什么正向证据用「session.id」而不是「header.delegationDepth 显式等于 0」：DSH 进程内新建的
  // 顶层会话 header 不带 delegationDepth（SessionStore.prepare 仅在 meta 提供时写入，见
  // @deepseek-ai/dsh-session 的 prepare；GUI/session-controller 建会话的 meta 只有 cwd/agentPreset，
  // agentOptions 只有 provider/model），而子代理会话必然带 origin/parentSession/delegationDepth
  // （@deepseek-ai/dsh-subagent 的 childSessionMeta）。要求显式深度会把新鲜顶层会话误判为子代理。
  // 深度仍用 DSH 官方 delegationDepthOf（单调取大：header 权威，runtime options 只能加深）。
  // T8（第五轮调查结论）：残留折中「{session:{id,header:{}},options:{}} 判为主会话」在生产**不可达作为子代理**——
  // DSH 的子代理会话由 childSessionMeta 构造（packages/subagent/subagent/src/child-agent.ts:139-158），
  // 必写 parentSession / origin:'subagent' / delegationDepth（注释标为 Durable，持久化后仍在），
  // 而 packages/core/agent/src/runtime-types.ts:166 的 Agent.options 恒存在（字段全可选，缺失时不影响判定）。
  // 顶层主会话的 header 只带 cwd/agentPreset，正是该形状 → 判主会话正确。收紧这条的代价是把所有新鲜顶层
  // 主会话误判为子代理（写不了 global + 只读守则 + 提取器停摆），故保持现状并在此固化依据。
  function isSubagentAgent(agent: any): boolean {
    const session = agent?.session
    if (session === null || typeof session !== 'object') return true    // 拿不到会话 → 按子代理
    if (typeof session.id !== 'string' || session.id === '') return true // 没有会话身份 → 证明不了是主会话
    const h = session.header
    if (h === null || typeof h !== 'object') return true                // 拿不到 header → 按子代理
    if (agent.options === null || typeof agent.options !== 'object') return true // 拿不到 runtime options → 按子代理
    let depth: number
    try { depth = delegationDepthOf(agent) } catch { return true }      // 畸形 subagentDepth 也是不确定
    if (!Number.isSafeInteger(depth) || depth !== 0) return true        // 深度非 0 → 子代理
    // 子代理标记三件套（childSessionMeta）：origin / parentSession；parentId 兼容仅运行时的视图
    if (h.origin === 'subagent') return true
    if (h.parentSession !== undefined && h.parentSession !== null) return true
    if (h.parentId !== undefined && h.parentId !== null) return true
    return false
  }

  // ── 轮末自动提取（对标 Claude Code extractMemories：AI 用 AI 写记忆）────────
  // 订阅 session/event 火线缓冲每个会话当前 turn 的文本；agent/turn-stopping 时
  // 异步调 LLM 提取高置信候选，过最小闸门后落盘。互斥：主 agent 30s 内手动写过
  // 记忆 → 跳过；提取中 → 跳过；冷却内 → 跳过。两个监听器都绝不抛错。
  const turnBuffers = new Map<string, string[]>()
  const lastExtractAt = new Map<string, number>()
  const lastManualWriteAt = new Map<string, number>()
  // m7：会话级 Map 的廉价上限（依赖 Map 插入顺序删最旧），避免长生命周期进程无界增长
  function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max = 200): void {
    map.set(key, value)
    while (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
  // M5：并发粒度——per-session 互斥 + 全局上限（修复前是全局单例布尔：两个会话同时
  // 结束回合时后到者被静默丢弃，而它已经写过 lastExtractAt，整个冷却周期不再尝试）
  const extractingSessions = new Set<string>()
  // 第 2 批拆分：装箱成对象字段，deps 传递的是同一引用（解构成 number 会让并发上限失效）
  const extractCounters: ExtractCounters = { globalInFlight: 0 }

  // ── 显式依赖对象（第 2 批拆分）────────────────────────────────────────
  // 拆分前所有函数都闭包在 apply() 作用域上；现在把「共享状态 + 归一化配置常量 +
  // 辅助函数」打包成同一实例，沿 registerXxx(ctx, deps) 传递。
  // 禁止 { ...deps } 展开或重建：sessionInjections 分叉 → 注入去重失效；
  // extractCounters 分叉 → 提取并发上限失效（M5）；runtime 分叉 → 面板开关失效（B1）。
  const deps: MemoryDeps = {
    // 配置面
    dataDir,
    dataFile,
    defaultScope,
    maxResults,
    autoRecall,
    autoRecallLimit,
    autoRecallMaxChars,
    autoRecallBudgetChars,
    injectionBudgetChars,
    autoRecallMinScore,
    autoRecallRelativeFloor,
    autoRecallScope,
    autoRecallFallback,
    autoCapture,
    autoExtract,
    autoExtractCooldownMs,
    autoRecallOnce,
    autoRecallCooldownMs,
    rrfRecall,
    rrfFirstTurnOnly,
    approveOnSet,
    synonymExpansion,
    dedupeOnSet,
    autoRecallRerank,
    taskTtlDays,
    autoRecallRerankMax,
    valueMaxChars,
    fullMaxChars,
    allowCredentialReveal,
    redactPatterns,
    maxItems,
    // 运行时开关（面板写、消费点读）
    runtime,
    // store 面
    store,
    readItems,
    writeItems,
    withLock,
    searchItems,
    // 会话状态
    sessionInjections,
    persistInjectionState,
    turnBuffers,
    lastExtractAt,
    lastManualWriteAt,
    extractingSessions,
    extractCounters,
    // 工具函数
    makeId,
    normalizeTags,
    setBounded,
    isSubagentAgent,
    currentWorkspaceScopes,
    shouldMaskOutbound,
    importAllowRoots: () => config.importAllowRoots,
  }

  // 写侧共享实现（commitMemory / importFileToStore / oneLineSummary）：tools 与 commands 共用同一实例
  const writeOps = createWriteOps(deps)

  registerExtraction(ctx, deps)

  registerPreStep(ctx, deps)


  // ── 8 个记忆工具（已拆到 src/tools.ts，第 2 批）──────────────────────
  registerTools(ctx, deps, writeOps)


  // ── /memory 斜杠命令：人直接查看/写入记忆，不依赖模型调用工具 ────────
  ctx.effect(() => ctx.commands.register({
    name: 'memory',
    description: '查看/写入持久记忆：status / recall <查询> / remember <key> <内容> / forget <key> / dream / import <文件> / export <文件> / restore <文件> / panel',
    input: { hint: '<status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|export <文件>|restore <文件>|panel>' },
    recordInput: false,
    handler: (invocation) => executeMemoryCommand(invocation),
  }), 'dsh-external/dsh-persistent-memory: /memory command')


  // M12：/memory restore 的条目归一（导出文件的 items → MemoryItem）。
  // 原则是「忠实恢复」：不跑写侧闸门（前缀白名单/凭据闸门约束的是新内容的来源，
  // 恢复的是本库既往数据，卡住等于救援失败），只按 store.readItems 的坏行口径丢弃结构非法项。
  function normalizeRestoredItems(raw: unknown[]): { items: MemoryItem[]; skipped: number } {
    const out: MemoryItem[] = []
    let skipped = 0
    for (const entry of raw) {
      const e = entry as Record<string, unknown> | null
      if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.key !== 'string' || !e.key.trim() || typeof e.value !== 'string') {
        skipped++
        continue
      }
      const nowIso = new Date().toISOString()
      const tags = Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : []
      const links = Array.isArray(e.links) ? e.links.filter((l): l is string => typeof l === 'string') : []
      out.push({
        id: typeof e.id === 'string' && e.id ? e.id : makeId(),
        key: e.key.trim(),
        value: e.value,
        // F1（复审）：restore 是四条写入路径里唯一不设 full 上限的入口；导出文件里的 full 原样入库后，
        // memory_get(includeFull) 会把它整段送进模型上下文。与 memory_set / memory_dream 同口径截断。
        ...(typeof e.full === 'string' ? { full: e.full.slice(0, fullMaxChars) } : {}),
        ...(links.length ? { links } : {}),
        scope: normalizeScope(typeof e.scope === 'string' ? e.scope : '', defaultScope),
        tags,
        createdAt: typeof e.createdAt === 'string' && e.createdAt ? e.createdAt : nowIso,
        updatedAt: typeof e.updatedAt === 'string' && e.updatedAt ? e.updatedAt : nowIso,
        ...(typeof e.source === 'string' ? { source: e.source } : {}),
      })
    }
    return { items: out, skipped }
  }

  async function executeMemoryCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const raw = invocation.rawInput.trim()
    const [sub, ...rest] = raw.split(/\s+/)
    const arg = rest.join(' ').trim()
    const USAGE = 'Usage: /memory <status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|export <文件>|restore <文件>|panel>'
    switch (sub) {
      case 'status':
      case 'stats': {
        const items = await withLock(async () => readItems())
        if (items.length === 0) return { kind: 'success', text: '记忆库为空（0 条）。' }
        const scopes = new Map<string, number>()
        for (const item of items) scopes.set(item.scope, (scopes.get(item.scope) || 0) + 1)
        const lines = [...scopes.entries()].map(([scope, count]) => `- ${scope}: ${count}`).join('\n')
        return { kind: 'success', text: `记忆库共 ${items.length} 条：\n${lines}` }
      }
      case 'recall': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory recall <查询词>' }
        const result = await searchItems({ query: arg, limit: 8 })
        if (result.count === 0) return { kind: 'success', text: '没有匹配的记忆。' }
        const lines = result.items.map((item) => {
          const cleaned = sanitizeValue(item.value)
          const value = cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned
          return `- [${item.scope}/${item.key}] ${value}`
        })
        return { kind: 'success', text: `找到 ${result.count} 条记忆：\n${lines.join('\n')}` }
      }
      case 'remember': {
        const key = rest[0]?.trim() || ''
        const value = rest.slice(1).join(' ').trim()
        if (!key || !value) return { kind: 'error', text: 'Usage: /memory remember <key> <内容>' }
        // M14：复用 memory_set 的完整写侧闸门（前缀/tags/凭据/截断/冲突重试）；
        // approveOnSet 对用户亲自输入豁免——人本身就是审批者
        try {
          const r = await writeOps.commitMemory({ key, value, scope: defaultScope, source: 'slash:/memory remember', fromUser: true })
          const warnText = r.warnings?.length ? '\n⚠️ ' + r.warnings.join('；') : ''
          return { kind: 'success', text: `已写入记忆：${r.scope}/${r.key}${warnText}` }
        } catch (err) {
          return { kind: 'error', text: String(err instanceof Error ? err.message : err) }
        }
      }
      case 'forget': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory forget <key>' }
        const removed = await withLock(() => withConflictRetry(async () => {
          const items = await readItems()
          const next = items.filter((item) => !(item.scope === defaultScope && item.key === arg))
          if (next.length === items.length) return false
          await writeItems(next)
          return true
        }))
        return removed
          ? { kind: 'success', text: `已删除记忆：${defaultScope}/${arg}` }
          : { kind: 'success', text: `未找到要删除的记忆：${defaultScope}/${arg}` }
      }
      case 'dream': {
        const items = await withLock(async () => readItems())
        const nowMs = Date.now()
        const DAY = 86_400_000
        const cands = items
          .filter((item) => !item.key.startsWith('auth.'))
          .map((item) => {
            const ageDays = Math.floor((nowMs - Date.parse(item.updatedAt)) / DAY)
            let reason = ''
            let suggest = ''
            if (item.key.startsWith('task.') && ageDays > 30) { reason = 'task 状态超 30 天未更新'; suggest = '更新或删除' }
            else if (ageDays > 90) { reason = '超 90 天未更新'; suggest = '归档或删除' }
            else if (isCompletedMark(item.value) && ageDays > 14) { reason = '标记完成超 14 天'; suggest = '删除或归档' }
            return { item, ageDays, reason, suggest }
          })
          .filter((c) => c.reason)
          .sort((a, b) => b.ageDays - a.ageDays)
          .slice(0, 20)
        if (cands.length === 0) return { kind: 'success', text: '记忆代谢：没有过期候选，记忆库很健康。' }
        const lines = cands.map((c) => `- [${c.item.scope}/${c.item.key}] ${c.ageDays} 天前，${c.reason} → ${c.suggest}`).join('\n')
        return { kind: 'success', text: `记忆代谢候选（${cands.length} 条）：\n${lines}\n\n处理：让 agent 用 memory_set 更新 / memory_forget 删除，或你直接确认。` }
      }
      case 'import': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory import <文件绝对路径>' }
        try {
          const r = await writeOps.importFileToStore(arg, writeOps.defaultImportScope(), { fromUser: true })
          return { kind: 'success', text: r.summary }
        } catch (err) {
          return { kind: 'error', text: String(err instanceof Error ? err.message : err) }
        }
      }
      case 'export': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory export <文件路径>' }
        // S7：与 memory_import 同口径——拒绝 UNC/设备路径（导出文件含 full 原文与 auth.* 明文）
        if (/^\\\\/.test(arg)) return { kind: 'error', text: '导出失败：拒绝 \\\\?\\ / UNC / 设备路径' }
        const outPath = isAbsolute(arg) ? arg : join(dataDir, arg)
        try {
          const items = await withLock(async () => readItems())
          await fs.mkdir(dirname(outPath), { recursive: true })
          await fs.writeFile(outPath, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 2), 'utf8')
          const credCount = items.filter((item) => item.key.toLowerCase().startsWith('auth.')).length
          return {
            kind: 'success',
            text: `已导出 ${items.length} 条记忆（含 full 原文）到：${outPath}`
              + (credCount > 0 ? `\n⚠️ 其中 ${credCount} 条 auth.* 凭据为明文，请妥善保管该文件。` : ''),
          }
        } catch (err) {
          return { kind: 'error', text: '导出失败：' + String(err instanceof Error ? err.message : err) }
        }
      }
      case 'restore': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory restore <导出文件路径>' }
        // S7：与 memory_import 同口径——拒绝 UNC/设备路径 + 大小上限，避免超大同文件撑爆内存
        if (/^\\\\/.test(arg)) return { kind: 'error', text: '恢复失败：拒绝 \\\\?\\ / UNC / 设备路径' }
        const srcPath = isAbsolute(arg) ? arg : join(dataDir, arg)
        try {
          const st = await fs.stat(srcPath)
          if (st.size > MAX_IMPORT_BYTES) {
            return { kind: 'error', text: `恢复失败：文件超过 ${MAX_IMPORT_BYTES} 字节上限，记忆库未改动。` }
          }
        } catch {
          /* 读不到交给下面的 readFile 统一报错 */
        }
        // 先校验来源文件：非法文件必须在备份/写库之前被挡住（不留无意义备份，更不留半截状态）
        let parsed: { items?: unknown } | null = null
        try {
          parsed = JSON.parse(await fs.readFile(srcPath, 'utf8')) as { items?: unknown }
        } catch (err) {
          return { kind: 'error', text: `恢复失败：无法读取或解析 ${srcPath}（${String(err instanceof Error ? err.message : err)}），记忆库未改动。` }
        }
        if (!parsed || !Array.isArray(parsed.items)) {
          return { kind: 'error', text: `恢复失败：${srcPath} 不是有效的导出文件（缺少 items 数组），记忆库未改动。` }
        }
        const { items: incoming, skipped } = normalizeRestoredItems(parsed.items)
        // 再备份：恢复是覆盖式写入，必须先留一条回滚通道（B2 崩溃/误删场景唯一的自救口）
        const backupPath = join(dataDir, `memory.jsonl.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        try {
          await fs.mkdir(dataDir, { recursive: true })
          let rawCurrent = ''
          try {
            rawCurrent = await fs.readFile(dataFile, 'utf8')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          }
          await fs.writeFile(backupPath, rawCurrent, 'utf8')
        } catch (err) {
          return { kind: 'error', text: `恢复中止：备份当前记忆库失败（${String(err instanceof Error ? err.message : err)}），记忆库未改动。` }
        }
        try {
          const outcome = await withLock(() => withConflictRetry(async () => {
            const items = await readItems()
            let overwritten = 0
            let added = 0
            for (const item of incoming) {
              const idx = items.findIndex((entry) => entry.scope === item.scope && entry.key === item.key)
              if (idx >= 0) { items[idx] = item; overwritten++ } else { items.push(item); added++ }
            }
            // 空 items 的导出文件不做任何删除：恢复只覆盖/新增，绝不清库
            if (incoming.length > 0) await writeItems(items)
            return { total: items.length, overwritten, added }
          }))
          return {
            kind: 'success',
            text: `已从 ${srcPath} 恢复：新增 ${outcome.added} 条、覆盖 ${outcome.overwritten} 条，当前共 ${outcome.total} 条`
              + (skipped > 0 ? `（跳过结构非法的 ${skipped} 条）` : '')
              + `\n原记忆库已备份到：${backupPath}`
              + `\n如需回滚：把该备份文件复制回 ${dataFile} 即可（恢复只做覆盖/新增，不会删除库中其它条目）。`,
          }
        } catch (err) {
          return { kind: 'error', text: `恢复失败：${String(err instanceof Error ? err.message : err)}。原记忆库已备份到 ${backupPath}，复制回去即可回滚。` }
        }
      }
      case 'panel': {
        const items = await withLock(async () => readItems())
        const safe = items.filter((i) => !i.key.startsWith('auth.')).map((i) => ({ scope: i.scope, key: i.key, value: sanitizeValue(i.value), tags: i.tags, updatedAt: i.updatedAt }))
        // m8：写到 dataDir 而非 process.cwd()（host 进程目录，用户不会去那里找，
        // 且可能是只读目录导致命令直接抛错）
        const outPath = join(dataDir, `memory-panel-${new Date().toISOString().slice(0, 10)}.html`)
        try {
          await fs.mkdir(dataDir, { recursive: true })
          await fs.writeFile(outPath, buildPanelHtml(safe), 'utf8')
        } catch (err) {
          return { kind: 'error', text: '生成面板失败：' + String(err instanceof Error ? err.message : err) }
        }
        return { kind: 'success', text: `已生成记忆面板：${outPath}\n浏览器打开即可浏览/搜索全部记忆（auth.* 凭据已排除）。` }
      }
      default:
        return { kind: 'error', text: USAGE }
    }
  }

  registerPanel(ctx, deps)
}
