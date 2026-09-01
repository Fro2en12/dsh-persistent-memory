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
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = '@dsh-external/dsh-persistent-memory'
export const inject = ['tools', 'commands']

export interface Config {
  /** 记忆库目录；缺省为 $DSH_HOME/dsh-persistent-memory */
  dataDir?: string
  /** 未显式传 scope 时使用的默认作用域 */
  defaultScope?: string
  /** search/stats 返回条数上限 */
  maxResults?: number
  /** 是否在每轮请求前自动召回并注入记忆 */
  autoRecall?: boolean
  /** 自动召回最多注入条数 */
  autoRecallLimit?: number
  /** 自动召回每条 value 最大展示字符数 */
  autoRecallMaxChars?: number
  /** 自动召回限定作用域；空串表示不限定 */
  autoRecallScope?: string
  /** 没有相关匹配时是否回退注入最近记忆（默认 false，避免无关上下文污染） */
  autoRecallFallback?: boolean
  /** 是否注入“自动记忆守则”，让模型自己发现并总结值得记住的信息 */
  autoCapture?: boolean
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
  /** 启用 RRF 混合召回（词法+中文二元组双排名融合），词法 0 命中时按语义补位（默认 true） */
  rrfRecall?: boolean
  /** 写入前需用户确认：开启后 memory_set 必须带 confirmed=true 才落盘（默认 false） */
  approveOnSet?: boolean
}

export const Config = z.object({
  dataDir: z.string().default(''),
  defaultScope: z.string().default('global'),
  maxResults: z.number().default(20),
  autoRecall: z.boolean().default(true),
  autoRecallLimit: z.number().default(3),
  autoRecallMaxChars: z.number().default(160),
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
  approveOnSet: z.boolean().default(false),
})

interface MemoryItem {
  id: string
  key: string
  /** 简短摘要：自动召回与搜索只展示它，控制 token */
  value: string
  /** 可选完整正文：memory_get(includeFull) 才返回 */
  full?: string
  /** 可选关联记忆 key（同 scope）：召回时以关联行提示 */
  links?: string[]
  scope: string
  tags: string[]
  createdAt: string
  updatedAt: string
  /** 写入来源引证（日期+会话 id），v0.1.9 起 memory_set 自动填 */
  source?: string
}

export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = config.dataDir || join(dshHome, 'dsh-persistent-memory')
  const dataFile = join(dataDir, 'memory.jsonl')
  const defaultScope = config.defaultScope || 'global'
  const maxResults = Math.max(1, config.maxResults || 20)
  const autoRecall = config.autoRecall !== false
  const autoRecallLimit = Math.max(1, Math.min(20, config.autoRecallLimit || 3))
  const autoRecallMaxChars = Math.max(40, config.autoRecallMaxChars || 160)
  const autoRecallScope = (config.autoRecallScope || '').trim()
  const autoRecallFallback = config.autoRecallFallback === true
  const autoCapture = config.autoCapture !== false
  const autoRecallOnce = config.autoRecallOnce !== false
  const autoRecallCooldownMs = Math.max(0, config.autoRecallCooldownMs ?? 10 * 60 * 1000)
  const rrfRecall = config.rrfRecall !== false
  const approveOnSet = config.approveOnSet === true
  const synonymExpansion = config.synonymExpansion !== false
  const dedupeOnSet = config.dedupeOnSet !== false
  const autoRecallRerank = config.autoRecallRerank !== false
  const autoRecallRerankMax = Math.max(1, Math.min(8, config.autoRecallRerankMax || 5))

  // 串行化读写，避免并发写坏 JSONL
  let queue: Promise<unknown> = Promise.resolve()
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  // 文件级缓存：stat（mtime+size）未变时复用解析结果，避免每轮 pre-step 重复读盘
  let itemsCache: { mtimeMs: number; size: number; items: MemoryItem[] } | null = null

  async function readItems(): Promise<MemoryItem[]> {
    let st: Awaited<ReturnType<typeof fs.stat>>
    try {
      st = await fs.stat(dataFile)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    if (itemsCache && itemsCache.mtimeMs === st.mtimeMs && itemsCache.size === st.size) {
      return itemsCache.items
    }
    let text: string
    try {
      text = await fs.readFile(dataFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const items: MemoryItem[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as MemoryItem
        // 兼容历史/手工写入的缺字段记录：tags 缺失会令下游 item.tags.includes/map 抛 TypeError，
        // 进而使整个自动召回被外层 catch 静默吞掉（违背"忽略损坏行防崩溃"目标）。
        if (parsed && typeof parsed.key === 'string') {
          if (!Array.isArray(parsed.tags)) parsed.tags = []
          items.push(parsed)
        }
      } catch {
        // 忽略损坏行，保证插件不因单条坏数据崩溃
      }
    }
    itemsCache = { mtimeMs: st.mtimeMs, size: st.size, items }
    return items
  }

  function invalidateCache(): void {
    itemsCache = null
  }

  async function writeItems(items: MemoryItem[]): Promise<void> {
    await fs.mkdir(dataDir, { recursive: true })
    const body = items.map((item) => JSON.stringify(item)).join('\n') + '\n'
    await fs.writeFile(dataFile, body, 'utf8')
    invalidateCache()
  }

  // 检索公共实现：memory_search 工具与 /memory recall 命令共用
  async function searchItems(options: {
    query?: string
    scope?: string
    tags?: string[]
    limit?: number
  }): Promise<{ count: number; items: MemoryItem[] }> {
    const query = String(options.query || '').trim().toLowerCase()
    const scopeFilter = options.scope ? normalizeScope(options.scope) : undefined
    const tagsFilter = normalizeTags(options.tags)
    const limit = Math.max(1, Math.min(100, Number(options.limit) || maxResults))
    return withLock(async () => {
      const items = await readItems()
      const matched = items.filter((item) => {
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

  function normalizeScope(scope?: string): string {
    const s = (scope || defaultScope).trim()
    return s || 'global'
  }

  function normalizeTags(tags?: string[]): string[] {
    if (!Array.isArray(tags)) return []
    return tags.map((t) => String(t).trim()).filter(Boolean)
  }

  function makeId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  // ── 改进支撑设施 ──────────────────────────────────────────────────────
  // ① 会话级注入记录：sessionId → 上次注入时间戳（每会话一次 + 冷却期）
  const sessionInjections = new Map<string, number>()

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

  // ③ 同义词表：扩展 token，弥补字面匹配的语义盲区（代理↔梯子↔vpn 等）
  const SYNONYM_GROUPS: string[][] = [
    ['代理', '梯子', 'vpn', 'proxy', 'clash', '加速器'],
    ['认证', '登录', '登陆', '鉴权', 'auth', 'login', 'signin'],
    ['凭据', '密钥', '密码', 'token', 'apikey', 'api-key', 'secret', 'credential'],
    ['网络', '联网', '断网', '不通', 'network', 'net'],
    ['超时', 'timeout', '卡住', '无响应', '挂起'],
    ['失败', '报错', '错误', 'error', 'fail', 'exception', '崩溃'],
    ['插件', 'plugin', '扩展', 'extension'],
    ['记忆', 'memory', '上下文', 'context'],
    ['权限', 'permission', '授权', 'authorization'],
  ]
  // ③b 低信息量词表：语气词/泛化词/高频噪音词。命中这些的 token 不参与评分与同义展开，
  //     避免"看看/感觉/还是/降低"这类句内杂词把无关记忆抬上分（如"记忆/上下文"泛命中）。
  const NOISE_WORDS = [
    '看看', '弄一下', '搞一下', '这个', '那个', '感觉', '还是', '正常', '使用', '可以', '怎么', '什么',
    '能不能', '降低', '影响', '同样', '经常', '一直', '老是', '为什么', '帮我', '我们', '咱们', '别人',
    '东西', '事情', '时候', '现在', '今天', '目前', '之前', '之后', '最后', '然后', '但是', '而且',
    '因为', '所以', '如果', '只是', '可能', '应该', '需要', '想要', '希望', '就是', '不是', '谢谢',
    '麻烦', '顺便', '对了', '好的', '一下', '有点', '一些', '什么', '怎么', '如何', '是否', '并且',
    '还有', '以及', '就是', '而已', '啊', '吧', '吗', '呢', '的', '了', '嗯', '哦', '哟', '喂',
    'ai', 'llm', 'gpt', 'api', 'ui', 'go', 'ts', 'js', 'ok', 'okay', '好的啊',
  ]
  // ③c 弱信息词：粗粒度主题词。命中时只给低分且不做同义展开（"记忆/上下文/插件"太宽，
  //     直接匹配会拉入大量环境记忆），防止 dsh-web-profile 类全局杂项污染注入。
  const WEAK_WORDS = [
    '记忆', '上下文', '插件', '扩展', '工具', '环境', '代理', '网络', '问题', '建议', '帮助',
    '处理', '解决', '修复', '测试', '运行', '执行', '继续', '开始', '查看', '检查', '文件',
    '命令', '配置', '设置', '项目', '状态', '记录', '内容', '数据',
  ]

  function stripNoise(token: string): string {
    let s = token.toLowerCase()
    for (const w of NOISE_WORDS) s = s.split(w).join('')
    return s
  }

  function expandToken(token: string): string[] {
    // 长 token（整句/跨词块）不做同义展开：避免"看看我自己做的记忆插件"整串命中
    // `插件` 组从而把 9 组同义词全部带入评分（0.1.2 误召回的主要来源）。
    if (token.length > 6) return [token]
    const out = [token]
    for (const group of SYNONYM_GROUPS) {
      if (group.some((w) => token.includes(w) || w.includes(token))) out.push(...group)
    }
    return [...new Set(out)]
  }

  // ⑤ 记忆投毒防护：召回注入前清洗 value（控制字符 / 非 http URI scheme / 提示注入模式）
  function sanitizeValue(value: string): string {
    let v = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // 中和非 http(s) 的 xxx:// scheme（viking://、file://、javascript: 等投毒向量），不影响 E:/ 路径
    v = v.replace(/\b(?!https?:)([a-z][a-z0-9+.\-]{2,}):\/\//gi, (m) => m.replace(':', '\u02d0'))
    // 中和无 // 的危险 scheme：javascript:、data:、vbscript: 等（旧正则只覆盖 xxx:// 形式）
    v = v.replace(/\b(?:javascript|vbscript|data|file|blob):/gi, (m) => m.replace(':', '\u02d0'))
    // 打断疑似提示注入指令
    v = v.replace(
      /(ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|忽略(之前|以上|前面)(的)?(所有)?指令|system\s*prompt\s*:|disregard\s+(all\s+)?(previous|prior)\s+.*?instructions?)/gi,
      '[已过滤可疑指令文本]',
    )
    return v
  }

  // ④ key 相似度（词元重叠率），用于 memory_set 去重合并
  function keySimilarity(a: string, b: string): number {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    const ta = norm(a)
    const tb = norm(b)
    if (!ta.length || !tb.length) return 0
    const setB = new Set(tb)
    const overlap = ta.filter((t) => setB.has(t)).length
    return overlap / Math.max(ta.length, tb.length)
  }

  // ④b 语义辅助（v0.1.9）：中文二元组 + 英文词元，零 token 零依赖
  function tokenizeForSemantic(s: string): string[] {
    const cleaned = s.toLowerCase().replace(/s+/g, ' ')
    const tokens: string[] = []
    const cn = cleaned.match(/[一-鿿]+/g) || []
    for (const run of cn) {
      if (run.length === 1) tokens.push(run)
      else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
    }
    const en = cleaned.replace(/[一-鿿]+/g, ' ').match(/[a-z0-9][a-z0-9._-]*/g) || []
    tokens.push(...en.filter((t) => t.length > 1))
    return tokens
  }

  function bigramJaccard(a: string, b: string): number {
    const ta = tokenizeForSemantic(a)
    const tb = tokenizeForSemantic(b)
    if (!ta.length || !tb.length) return 0
    const setB = new Set(tb)
    const overlap = ta.filter((t) => setB.has(t)).length
    return overlap / (ta.length + tb.length - overlap)
  }

  // RRF 倒数排名融合：词法分 + bigram 相似度双排名（对标 dsh-evolve 的零 token 混合召回）
  function rrfRanking(items: MemoryItem[], query: string): { item: MemoryItem; rrf: number }[] {
    if (!query || items.length === 0) return []
    const lex = items.map((item) => ({ item, s: scoreItem(item, query, false) }))
    const bi = items.map((item) => ({ item, s: bigramJaccard(query, `${item.key} ${item.value}`) }))
    const rankMap = (arr: { item: MemoryItem; s: number }[]) => {
      const sorted = [...arr].sort((a, b) => b.s - a.s)
      return new Map(sorted.map((e, i) => [e.item.id, i]))
    }
    const lexRank = rankMap(lex)
    const biRank = rankMap(bi)
    const K = 60
    return items
      .map((item) => {
        const r1 = lexRank.get(item.id) ?? items.length
        const r2 = biRank.get(item.id) ?? items.length
        return { item, rrf: 1 / (K + r1) + 1 / (K + r2) }
      })
      .sort((a, b) => b.rrf - a.rrf)
  }

  // 内容冲突检测（v0.1.9）：key 相似与 value 语义相似取高者
  function contentSimilarity(a: MemoryItem, b: MemoryItem): number {
    return Math.max(bigramJaccard(a.value, b.value), keySimilarity(a.key, b.key))
  }

  // ── 自动召回：把相关/最近记忆注入到每轮请求前 ─────────────────────────
  // v0.1.4：只读文本、跳过插件注入消息、向后取最多 2 条用户文本消息（上下文延续如
  // "又报错了"能带上文关键词）；同时标记本轮是否含图片块 —— 图片内容无法参与
  // 字面召回，发图提问时召回意义为零（画像兜底也跳过），避免"看图问问题"惨遭画像刷屏。
  function extractQuery(messages: unknown[]): { query: string; hasImage: boolean } {
    if (!Array.isArray(messages) || messages.length === 0) return { query: '', hasImage: false }
    let hasImage = false
    const texts: string[] = []
    for (let i = messages.length - 1; i >= 0 && texts.length < 2; i--) {
      const msg = messages[i] as {
        role?: string
        content?: Array<{ type?: string; text?: string }>
        source?: { kind?: string; plugin?: string }
      }
      if (!msg || !Array.isArray(msg.content)) continue
      // 跳过插件注入消息（自动守则/召回/教训），避免其文本污染查询信号
      if (msg.source?.kind === 'plugin') continue
      const blocks = msg.content
      if (blocks.some((b) => b?.type === 'image' || b?.type === 'image_url')) hasImage = true
      const t = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join(' ')
        .trim()
      if (t) texts.push(t)
    }
    return { query: texts.join(' ').slice(0, 200), hasImage }
  }

  function queryTokens(query: string): string[] {
    const tokens = query.toLowerCase().split(/[\s,，。.!！?？:：;；、/\\()[\]{}"']+/).filter(Boolean)
    return tokens.length > 0 ? tokens.slice(0, 12) : [query.toLowerCase()]
  }

  function scoreItem(item: MemoryItem, query: string, isFirstTurn: boolean): number {
    if (!query) return 0
    const q = query.toLowerCase()
    const tokens = queryTokens(query)
    let score = 0
    const key = item.key.toLowerCase()
    const value = item.value.toLowerCase()
    const scope = item.scope.toLowerCase()
    const tags = item.tags.map((tag) => tag.toLowerCase())

    // ② 工作区感知：项目专属 scope 与当前工作区无关 → 首轮直接排除，非首轮降权；
    //    命中当前工作区 → 加权（global 不加不减）
    const wsScopes = currentWorkspaceScopes()
    const inCurrentWorkspace = scope === 'global'
      || wsScopes.some((ws) => scope.includes(ws) || ws.includes(scope))
    if (!inCurrentWorkspace) {
      if (isFirstTurn) return 0
      score -= 4
    } else if (scope !== 'global') {
      score += 4
    }

    for (const token of tokens) {
      // 噪声词：剔除 NOISE_WORDS 后几乎没有剩余 → 语气/泛化 token，不参与评分
      //（避免"看看/感觉/还是…"这类句内杂词把无关记忆抬上分）
      const stripped = stripNoise(token)
      if (stripped.length < 2 && token.length < 8) continue

      const isWeak = WEAK_WORDS.some((w) => token.includes(w))
      if (key.includes(token)) {
        score += key === token ? 9 : 5
      } else if (value.includes(token)) {
        score += isWeak ? 1 : 2
      } else if (synonymExpansion && !isWeak && token.length <= 6) {
        // ③ 同义词扩展：仅短 token（≤6 字符）展开，且只作用于 key/tags（value 太宽泛，易误命中）
        const synonyms = expandToken(token).filter((w) => w !== token)
        if (synonyms.some((w) => key.includes(w))) score += 2
        else if (synonyms.some((w) => tags.some((tag) => tag.includes(w)))) score += 1
      }
      if (scope.includes(token)) score += 1
      if (tags.some((tag) => tag.includes(token) || token.includes(tag))) score += 2
    }

    // ⑥ 画像式分层修正：user.* 是稳定画像（用户偏好/禁忌），首轮应优先注入而非降权——
    //    "犯同样错"的常见根因正是首轮不知道用户约定（如 pwsh 7、非 C 盘）→ 改为 +1
    if (key.startsWith('user.') && isFirstTurn) score += 1

    // 信号词扩展：仅在非首轮启用，避免首轮被大量无关记忆污染
    if (!isFirstTurn) {
      const SIGNAL_WORDS = [
        '网络', '代理', 'proxy', 'vpn', 'clash', '梯子', 'github', 'git', 'ssh',
        '超时', '失败', '不通', '连不上', '认证', '权限', '凭据', '环境', '工具',
      ]
      if (SIGNAL_WORDS.some((word) => q.includes(word))) {
        const signalInItem = SIGNAL_WORDS.some((word) =>
          key.includes(word) || value.includes(word) || tags.some((tag) => tag.includes(word)),
        )
        if (signalInItem) score += 2
      }
    }
    return score
  }

  // 规则/教训通道：识别"又犯同样错"的悔恨信号与"路径/终端/命令"类场景信号。
  // 这两类信号触发时，强制召回 rule.*/教训/坑/修复类记忆（不受 autoRecallOnce 限制）。
  function regretSignal(query: string): boolean {
    const q = query.toLowerCase()
    const regret = ['又', '还是', '再次', '仍然', '依然', '老是', '一直', '经常', 'again']
    const error = ['错', '失败', '报错', '不对', '不行', '崩', '挂', '回退', '问题', '错误', '没', '失败啦']
    return regret.some((r) => q.includes(r)) && error.some((e) => q.includes(e))
  }
  function ruleScene(query: string): boolean {
    const q = query.toLowerCase()
    const scene = ['路径', 'path', '盘', '目录', 'folder', '文件位置', '放哪', '移动', '拷贝', '复制',
      'powershell', 'pwsh', '终端', '命令', '脚本', '字符', '编码', '引号', 'c盘', 'd盘', 'e盘', 'windows']
    return scene.some((s) => q.includes(s))
  }

  // 教训/规则记忆的判定：key 前缀 rule. 或 value/tags 含强信号
  function isLessonLike(item: MemoryItem): boolean {
    const key = item.key.toLowerCase()
    const blob = `${item.key} ${item.value} ${item.tags.join(' ')}`.toLowerCase()
    if (key.startsWith('rule.') || key.startsWith('convention.') || key.startsWith('lesson.')) return true
    return ['教训', '坑', '切记', '勿', '不要', '禁止', '约定', 'lesson', 'pitfall', 'fixed', 'repair', 'fix']
      .some((w) => blob.includes(w))
  }

  function pickLessonItems(items: MemoryItem[], isRegret: boolean, isRule: boolean, limit: number): MemoryItem[] {
    const candidates = items.filter((item) => isLessonLike(item))
    if (candidates.length === 0) return []
    const scored = candidates.map((item) => {
      const blob = `${item.key} ${item.value} ${item.tags.join(' ')}`.toLowerCase()
      let bonus = 0
      if (isRule && (blob.includes('路径') || blob.includes('path') || blob.includes('盘')
        || blob.includes('powershell') || blob.includes('pwsh') || blob.includes('终端') || blob.includes('命令'))) bonus += 10
      if (isRegret) bonus += 6
      return { item, bonus }
    })
    scored.sort((a, b) => (b.bonus - a.bonus) || b.item.updatedAt.localeCompare(a.item.updatedAt))
    return scored.slice(0, limit).map((entry) => entry.item)
  }

  function pickRecallItems(
    items: MemoryItem[],
    query: string,
    limit: number,
    useFallback: boolean,
    isFirstTurn: boolean,
    hasImage: boolean,
  ): MemoryItem[] {
    const scoped = autoRecallScope ? items.filter((item) => item.scope === autoRecallScope) : items
    if (scoped.length === 0) return []
    const scored = scoped.map((item) => ({ item, score: scoreItem(item, query, isFirstTurn) }))
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.item.updatedAt.localeCompare(a.item.updatedAt)
    })
    // 首轮要求 score >= 6（一次 key 直中 + 少量辅助，防止弱词/同义把无关记忆抬上分）
    const minScore = isFirstTurn ? 6 : 1
    const top = scored.filter((entry) => entry.score >= minScore).map((entry) => entry.item)
    // 画像兜底已移除（v0.1.6）：首轮 0 命中改由 pre-step 的【记忆索引】块兜底，user.* 画像在其中自然呈现。
    if (top.length >= limit) return top.slice(0, limit)
    // v0.1.9 RRF 语义补位：词法 0 命中时，用词法+二元组双排名召回语义相关条目（零 token）
    if (rrfRecall && top.length === 0 && query) {
      const ranked = rrfRanking(scoped, query).filter((e) => e.rrf >= 0.025)
      if (ranked.length > 0) return ranked.slice(0, limit).map((e) => e.item)
    }
    // 首轮不启用 fallback，避免用"最近记忆"凑数
    if (!useFallback || isFirstTurn) return top
    const picked = new Set(top.map((item) => `${item.scope}\u0000${item.key}`))
    const recent = [...scoped]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((item) => !picked.has(`${item.scope}\u0000${item.key}`))
    return [...top, ...recent.slice(0, limit - top.length)]
  }

  // 重排候选池（v0.1.9）：RRF 双排名取 top max——词法零命中但语义相关的条目也能进 LLM 重排视野
  function pickRecallCandidates(items: MemoryItem[], query: string, max: number): MemoryItem[] {
    if (!query) return []
    const ranked = rrfRanking(items, query).filter((e) => e.rrf >= 0.025)
    return ranked.slice(0, max).map((e) => e.item)
  }

  // 在句子边界（。；！？/换行/空格）截断，避免"…dsh-file-…"这种半截文字
  function truncate(text: string, max: number): string {
    if (text.length <= max) return text
    const slice = text.slice(0, max)
    const boundary = Math.max(
      slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('！'),
      slice.lastIndexOf('？'), slice.lastIndexOf('\n'), slice.lastIndexOf('. '),
    )
    return boundary > max * 0.5 ? `${slice.slice(0, boundary + 1)}…` : `${slice}…`
  }

  // ── 记忆新鲜度（借鉴 Claude Code memoryAge.ts）────────────────────────
  // 天龄显示：今天/昨天/N 天前。模型对原始 ISO 时间戳的"过期感"很差，
  // "47 天前"比 ISO 串更能触发过期推理。
  function ageLabel(iso: string): string {
    const d = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000))
    if (!Number.isFinite(d) || d === 0) return '今天'
    if (d === 1) return '昨天'
    return `${d} 天前`
  }

  // 漂移警告：>1 天的记忆附"时点观察"提示——记忆是写入时的真相，不是实时状态；
  // 点名了文件/路径/命令的记忆在引用前先验证（否则"过时断言当事实"正是重复犯错之源）。
  function driftNote(iso: string): string {
    const d = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000))
    if (!Number.isFinite(d) || d <= 1) return ''
    return `\n> ⚠️ 记忆为 ${d} 天前的时点观察，可能已过时：记忆中点名的文件/路径/命令，引用前请先验证现状；与当前信息冲突时以现状为准，并更新该记忆。`
  }

  function formatRecall(items: MemoryItem[], all: MemoryItem[]): string {
    const lines = items.map((item) => {
      // ⑤ 投毒防护：注入前清洗（控制字符/危险 URI scheme/提示注入模式）
      const cleaned = sanitizeValue(item.value)
      const value = truncate(cleaned, autoRecallMaxChars)
      let line = `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}${item.source ? ` · 自${item.source}` : ''}] ${value}`
      if (item.links && item.links.length > 0) {
        const linked = all
          .filter((o) => o.scope === item.scope && o.id !== item.id && item.links!.includes(o.key))
          .map((o) => o.key)
          .slice(0, 3)
        if (linked.length > 0) line += `\n    🔗 关联: ${linked.join('、')}`
      }
      return line
    })
    const note = items.reduce((acc, item) => acc + driftNote(item.updatedAt), '')
    return `【记忆自动召回】\n${lines.join('\n')}${note}`
  }

  function formatLesson(items: MemoryItem[]): string {
    const lines = items.map((item) => {
      const cleaned = sanitizeValue(item.value)
      return `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}${item.source ? ` · 自${item.source}` : ''}] ${truncate(cleaned, autoRecallMaxChars)}`
    })
    const note = items.reduce((acc, item) => acc + driftNote(item.updatedAt), '')
    return `【历史教训/规则提醒】以下记忆与当前场景相关，请优先遵守以避免重复犯错：\n${lines.join('\n')}${note}`
  }

  // ── LLM 语义重排（对标 Claude Code memdir/findRelevantMemories）─────────
  // 词法预筛 → 候选 manifest → LLM 选 3~5 条 → 失败/超时降级词法 top。
  // ctx.get('llm') 为可选服务；拿不到时静默降级（不影响原有词法链路）。
  const RERANK_SYSTEM_PROMPT = [
    '你是记忆选择器。给定用户查询与记忆清单，选出对该查询【明确有用】的记忆 key（最多 ',
    '{{max}}',
    ' 个）。规则：',
    '1. 不确定是否有用就不选；宁少勿多，可以返回空列表。',
    '2. 用户正在使用的工具的"参考文档/API 说明"不要选（对话里已有使用示例）；但警告、坑、已知问题、历史教训要选——正好在踩的时候最有用。',
    '3. 陈旧（N 天前）的状态记忆：除非查询明确指向"当时的结论/原因"，否则优先不选；规则类（rule.*）与画像类（user.*）不受此限。',
    '4. 输出只允许 JSON：{"selected_keys": ["scope/key", ...]}，key 必须原样来自清单。',
  ].join('')

  function buildRerankManifest(items: MemoryItem[]): string {
    return items.map((item) => {
      const cleaned = sanitizeValue(item.value)
      return `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}] ${truncate(cleaned, 80)}`
    }).join('\n')
  }

  async function rerankMemories(
    ctx: Context,
    query: string,
    candidates: MemoryItem[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<MemoryItem[] | null> {
    const llm = ctx.get('llm') as any
    if (!llm) return null
    const sel = (ctx.get('agentDefaultModel') as any)?.currentSelection?.() as
      | { provider?: string; model?: string } | undefined
    const provider = sel?.provider
    const model = sel?.model
    if (!provider || !model) return null
    const manifest = buildRerankManifest(candidates)
    // 5s 整体超时 + 外部中止信号，防 pre-step 被慢调用拖住
    const timeout = AbortSignal.timeout(5000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const system = RERANK_SYSTEM_PROMPT.replace('{{max}}', String(limit))
      const content = `Query: ${query}\n\nAvailable memories:\n${manifest}`
      const textChunks: string[] = []
      const stream = llm.stream({
        provider,
        model,
        system,
        maxTokens: 300,
        temperature: 0,
        signal: combined,
        messages: [{
          id: `mid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text: content }],
          source: { kind: 'plugin', plugin: name },
        }],
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') textChunks.push(chunk.text)
      }
      const text = textChunks.join('').trim()
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return null
      const parsed = JSON.parse(m[0]) as { selected_keys?: string[] }
      const byKey = new Map(candidates.map((c) => [`${c.scope}/${c.key}`, c]))
      const selected = (parsed.selected_keys ?? [])
        .map((k: string) => byKey.get(k))
        .filter((x: MemoryItem | undefined): x is MemoryItem => !!x)
      return selected.length > 0 ? selected.slice(0, limit) : null
    } catch (err) {
      ctx.logger.warn('dsh-persistent-memory: rerank failed: %o', err)
      return null
    }
  }

  // ── 记忆索引（对标 Claude Code MEMORY.md，动态生成不落盘）──────────────
  // 触发：首轮 && 无信号 && !hasImage && 常规召回 0 命中 && 教训通道未注入。
  // 替代画像兜底（v0.1.7 起 user.* 在 global 组有固定 2 席配额，画像真实呈现）。
  function buildIndexBlock(items: MemoryItem[]): string {
    const scopes = new Map<string, MemoryItem[]>()
    for (const item of items) {
      const group = item.scope === 'global' ? 'global'
        : (currentWorkspaceScopes().some((ws) => item.scope.includes(ws) || ws.includes(item.scope)) ? item.scope : null)
      if (!group) continue
      if (!scopes.has(group)) scopes.set(group, [])
      scopes.get(group)!.push(item)
    }
    const byUpdated = (a: MemoryItem, b: MemoryItem) => b.updatedAt.localeCompare(a.updatedAt)
    const lines: string[] = []
    const order = ['global', ...currentWorkspaceScopes()]
    for (const scope of order) {
      let picks: MemoryItem[]
      if (scope === 'global') {
        // v0.1.7 画像配额：只取"最新 4 条"时 user.* 会被 task/env 等高频条目永久挤出（v0.1.6 缺陷）。
        // global 组改为 user.* 固定 2 席 + 其余分类最新 2 席。
        const userPicks = (scopes.get(scope) || [])
          .filter((item) => item.key.startsWith('user.')).sort(byUpdated).slice(0, 2)
        const otherPicks = (scopes.get(scope) || [])
          .filter((item) => !item.key.startsWith('user.')).sort(byUpdated).slice(0, 2)
        picks = [...userPicks, ...otherPicks]
      } else {
        picks = (scopes.get(scope) || []).sort(byUpdated).slice(0, 3)
      }
      if (picks.length) {
        lines.push(`- ${scope}:`)
        for (const item of picks) {
          lines.push(`  - [${item.key} · ${ageLabel(item.updatedAt)}] ${truncate(sanitizeValue(item.value), 40)}`)
        }
      }
    }
    lines.push('检索：/memory recall <关键词> 或 memory_search 可全文召回')
    return `【记忆索引】当前记忆库可查（未做自动召回，需要时按提示检索）：\n${lines.join('\n')}`
  }

  function isOwnInjected(message: unknown, text: string, form: string): boolean {
    const msg = message as {
      content?: Array<{ type?: string; text?: string }>
      source?: { kind?: string; plugin?: string; form?: string }
    }
    if (!msg || msg.source?.kind !== 'plugin' || msg.source.plugin !== name || msg.source.form !== form) {
      return false
    }
    const blocks = Array.isArray(msg.content) ? msg.content : []
    return blocks.length === 1 && blocks[0]?.type === 'text' && blocks[0].text === text
  }

  // ── 自动记忆守则 + 自动召回 ────────────────────────────────────────────
  // 守则不再走 system-prompt section：complete:true 的 preset（如 stock minimal）
  // 装配后只保留 persona 一个 section，其余全部静默丢弃；统一用 pre-step 注入
  // plugin user message，任何 preset 下都可达、可重放、压缩可见。
  const AUTO_CAPTURE_FORM = 'memory-capture-guide'
  const AUTO_CAPTURE_TEXT = [
    '# 自动记忆守则（dsh-persistent-memory）',
    '',
    '值得长期记住的信息按 key 前缀分九类（memory_set 有硬校验：前缀白名单/摘要长度/tags 数不合规会被拒绝，见文末）：',
    '- user.* 用户画像：称呼/角色/目标/偏好/禁忌。目标是把「用户是谁」建立起来；避免写入可视为负面评判或与工作无关的内容。',
    '- rule.* 用户纠正或确认过的做法：纠正和成功确认都要记——只记错误会越来越保守；用户说「对，就这么办」也要记。结构：规则一行 → **Why:** 原因（往往是一次事故或强偏好）→ **How to apply:** 何时生效。写入前先查是否与已有 rule.* 矛盾：矛盾时要么不写、要么在新条目显式标注覆盖关系。规则会随环境过期，写入时带最后验证日期；检索命中后发现与现状冲突就更新。',
    '- task.* 任务/项目进展与决策：变化快，时间一律用**绝对日期**（2026-09-03，不要写「昨天/下周」），并写清 Why（推动原因）。',
    '- project.* 项目级定稿结论与血泪教训：区别于 task.* 的进行中状态；一段项目工作收尾时沉淀，重点是「为什么」（约束/事故/利益方要求），让未来能判断结论是否仍成立。',
    '- env.* 环境状态：装了什么、配了什么、去哪查——记位置指针，不复制配置全文。',
    '- tool.* 工具/插件的坑与已知行为：正在踩坑时最有用的警告与已知问题。',
    '- ref.* 外部资源指针：去哪查信息（数据库、面板、资料位置、API 入口）。',
    '- auth.* 凭据类（敏感，**默认不记**）：账号/密码/密钥只有**用户明确要求记住时**才写入 auth.*（如「把这个账号密码记住」「以后登录用这个」）；用户没要求时，配置过程中见到的账号密码一律不主动沉淀进记忆库。账号口令只允许在 auth.* 前缀下记录，禁止复制扩散到其他前缀；除 auth.* 外任何前缀不记明文凭据（闸门拒绝）。',
    '- lesson.* 负面知识账本：被证伪的路径与失败教训（command_failed/file_missing/报错复现）——记结果、前置条件证据与解除条件；重复尝试同一路径前先查 lesson.*，证据变化后及时更新解除。',
    '',
    '项目归属：项目相关记忆把项目名写进 scope（scope=项目名），key 前缀仍用上述分类；不要两边都写项目名。全局通用信息 scope=global。',
    '',
    '「该不该记」的判据：反复出现的错误教训（用户抱怨「又错/还是不对」的坑与正确做法）、用户纠正、用户确认过的非常规做法、项目里代码看不出来的背景。用户明确要求记住的立即记；要求忘记的找到并删除。**不要记**：能从当前代码/文件推导的内容（架构、结构、路径）、git 历史与「谁改了什么」、修复配方的完整步骤（留在代码与产物里）、本次会话临时进度（用任务/计划跟踪，记忆只留给未来会话有用的事）、已在 AGENTS.md 的规则、本项目内 cairn 会记的内容（写 cairn 不写 memory）、技能文档已有内容；用户明确要求丢弃某记忆时不要引用。',
    '',
    '写入要求（memory_set 硬校验，不合规会被拒）：value 自足短摘要 ≤160 字；长文放 full（仅 includeFull 返回）；tags 1-3 个；scope 默认 global；key 前缀限 user/rule/task/ref/env/project/tool/auth/lesson（项目专属用 scope 承载项目名，勿塞进 key）；**先查同 scope 相似 key 再写**，有则更新（写入时会自动检测内容冲突并警告）；task.* 摘要含绝对日期；敏感/不确定先向用户确认；每轮 ≤3 条。approveOnSet 开启时须先征得用户同意并带 confirmed=true 写入。',
  ].join('\n')

  const SUBAGENT_CAPTURE_TEXT = [
    '# 子代理记忆守则（dsh-persistent-memory）',
    '',
    '你是子代理：记忆库【只读】——不要调用 memory_set 写入全局记忆。',
    '需要上下文时用 memory_search / memory_get 查阅；本次任务中学到的内容以结果报告回传父会话，由父会话决定是否沉淀。',
  ].join('\n')

  // 子代理探测（v0.1.6）：运行时会话 header 存 origin/parentSession/delegationDepth（dsh-subagent
  // childSessionMeta 写入），运行期 AgentOptions 另有 subagentDepth；探测不到按主会话处理（保守分支）。
  function isSubagentAgent(agent: any): boolean {
    const header = agent?.session?.header ?? agent?.session ?? {}
    const depth = Number(header.delegationDepth ?? agent?.options?.subagentDepth ?? 0)
    return header.origin === 'subagent'
      || depth > 0
      || Boolean(header.parentSession ?? header.parentId)
  }

  if (autoRecall || autoCapture) {
    ctx.on('agent/pre-step', async (
      payload: { agent: any; messages: unknown[]; step: number; signal?: AbortSignal },
      next: () => Promise<any>,
    ): Promise<any> => {
      const decision = await next()
      try {
        if (decision?.kind === 'reject') return decision
        if (payload.signal?.aborted) return decision
        if (payload.step === 1 && (!Array.isArray(decision.messages) || decision.messages.length === 0)) return decision

        const sid = String(
          payload.agent?.session?.id ?? payload.agent?.session?.sessionId ?? 'default',
        )
        if (payload.step === 1) {
          const header = payload.agent?.session?.header ?? payload.agent?.session
          ctx.logger.debug('[mem] agent probe %o', {
            origin: header?.origin,
            parent: header?.parentSession,
            depth: header?.delegationDepth,
            optDepth: payload.agent?.options?.subagentDepth,
            role: payload.agent?.role ?? header?.role,
            id: payload.agent?.session?.id,
          })
        }
        const claimed = payload.messages as unknown[]
        const entered = [...(decision.messages as unknown[])]
        const lastClaimedIndex = entered.findLastIndex((item) => claimed.includes(item))
        let changed = false

        // ① 记忆守则：每会话首轮注入一次（独立 form，与召回分开去重）
        if (autoCapture && payload.step === 1) {
          const guideKey = `${sid}:capture-guide`
          const guideText = isSubagentAgent(payload.agent) ? SUBAGENT_CAPTURE_TEXT : AUTO_CAPTURE_TEXT
          const guideForm = isSubagentAgent(payload.agent) ? 'memory-capture-guide-subagent' : AUTO_CAPTURE_FORM
          if (!sessionInjections.has(guideKey) && !entered.some((message: unknown) => isOwnInjected(message, guideText, guideForm))) {
            entered.splice(lastClaimedIndex + 1, 0, {
              role: 'user',
              id: makeId(),
              content: [{ type: 'text', text: guideText }],
              source: { kind: 'plugin', plugin: name, form: guideForm, summary: '记忆守则自动注入' },
            })
            // 有界淘汰：只移除最旧一次注入记录，不整体清空（避免所有会话冷却状态丢失）
            if (sessionInjections.size > 200) {
              const oldest = sessionInjections.keys().next().value
              if (oldest !== undefined) sessionInjections.delete(oldest)
            }
            sessionInjections.set(guideKey, Date.now())
            changed = true
          }
        }

        // ② 教训/规则通道：悔恨信号（又错了/还是失败）或场景信号（路径/终端/命令）
        //    触发时强制召回 rule.*/教训/坑/修复类记忆，**不受 autoRecallOnce 限制**——
        //    这是"AI 经常犯同样错"的直接解药：错误发生时立刻把上次的坑摆到眼前。
        //    独立冷却（120s）防刷屏，不污染常规召回的一次性配额。
        let lessonInjected = false
        if (autoRecall) {
          const items = await withLock(async () => readItems())
          const { query } = extractQuery(payload.messages)
          const isRule = ruleScene(query)
          const isRegret = regretSignal(query)
          const lessonKey = `${sid}:lesson`
          const lastLesson = sessionInjections.get(lessonKey)
          const lessonAllowed = lastLesson === undefined || Date.now() - lastLesson >= 120_000
          if (items.length > 0 && (isRule || isRegret) && lessonAllowed) {
            // 同一条教训本会话已出现过（历史注入中含该 marker）则跳过，避免复述刷屏
            const lessons = pickLessonItems(items, isRegret, isRule, 2)
            const fresh = lessons.filter((item) => {
              const marker = `[${item.scope}/${item.key}]`
              return !entered.some((m) => JSON.stringify(m).includes(marker))
            })
            if (fresh.length > 0) {
              const text = formatLesson(fresh)
              entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                role: 'user',
                id: makeId(),
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: name, form: 'memory-lesson', summary: `教训/规则提醒 ${fresh.length} 条` },
              })
              if (sessionInjections.size > 200) {
                const oldest = sessionInjections.keys().next().value
                if (oldest !== undefined) sessionInjections.delete(oldest)
              }
              sessionInjections.set(lessonKey, Date.now())
              lessonInjected = true
              changed = true
            }
          }
        }

        // ③ 自动召回：每会话一次 + 冷却期
        let recallEmpty = false
        if (autoRecall) {
          const lastInjection = sessionInjections.get(sid)
          const recallAllowed = lastInjection === undefined
            || (!autoRecallOnce && Date.now() - lastInjection >= autoRecallCooldownMs)
          if (recallAllowed) {
            const { query, hasImage } = extractQuery(payload.messages)
            const items = await withLock(async () => readItems())
            if (items.length > 0) {
              const isFirstTurn = payload.step === 1
              const recalled = pickRecallItems(items, query, autoRecallLimit, autoRecallFallback, isFirstTurn, hasImage)
              recallEmpty = recalled.length === 0
              // LLM 语义重排（v0.1.6）：词法命中候选 ≥2 且启用时，用 LLM 挑"明确有用"的条
              let recalledItems = recalled
              if (autoRecallRerank && query && !hasImage && recalled.length > 0) {
                const pool = pickRecallCandidates(items, query, autoRecallRerankMax * 4)
                if (pool.length >= 2) {
                  const picked = await rerankMemories(ctx, query, pool, autoRecallRerankMax, payload.signal)
                  if (picked && picked.length > 0) recalledItems = picked
                }
              }
              if (recalledItems.length > 0) {
                const text = formatRecall(recalledItems, items)
                const alreadyEntered = entered.some((message: unknown) => isOwnInjected(message, text, 'memory-recall'))
                // 已在本会话可见表面出现过则不重复注入
                let onSurface = false
                const surface = payload.agent?.session?.surface
                if (!alreadyEntered && Array.isArray(surface?.nodes) && Array.isArray(payload.agent?.session?.events)) {
                  onSurface = surface.nodes.some((seq: number) => {
                    const event = payload.agent.session.events[seq]
                    return event?.type === 'user/message' && isOwnInjected(event.data, text, 'memory-recall')
                  })
                }
                if (!alreadyEntered && !onSurface) {
                  entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                    role: 'user',
                    id: makeId(),
                    content: [{ type: 'text', text }],
                    source: { kind: 'plugin', plugin: name, form: 'memory-recall', summary: `记忆自动召回 ${recalledItems.length} 条` },
                  })
                  // 有界淘汰：只移除最旧一次注入记录，不整体清空（避免所有会话冷却状态丢失）
            if (sessionInjections.size > 200) {
              const oldest = sessionInjections.keys().next().value
              if (oldest !== undefined) sessionInjections.delete(oldest)
            }
                  sessionInjections.set(sid, Date.now())
                  changed = true
                }
              }
            }
          }
        }

        // ④ 索引兜底：首轮没有任何召回且不是看图提问 → 注入索引而不是画像（v0.1.6）
        // 只看 教训/召回 两通道是否已注入：① 守则注入不算——守则 + 索引同现正是验收预期（新会话"你好"）。
        if (autoRecall && payload.step === 1 && !isSubagentAgent(payload.agent)) {
          const { hasImage } = extractQuery(payload.messages)
          const idxKey = `${sid}:index`
          if (!hasImage && !sessionInjections.has(idxKey) && !lessonInjected && recallEmpty) {
            const items = await withLock(async () => readItems())
            if (items.length > 0) {
              const text = buildIndexBlock(items)
              entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                role: 'user',
                id: makeId(),
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: name, form: 'memory-index', summary: '记忆索引（未召回）' },
              })
              if (sessionInjections.size > 200) {
                const oldest = sessionInjections.keys().next().value
                if (oldest !== undefined) sessionInjections.delete(oldest)
              }
              sessionInjections.set(idxKey, Date.now())
              changed = true
            }
          }
        }

        if (changed) return { kind: 'enter', messages: entered }
        return decision
      } catch (error) {
        ctx.logger.warn(`dsh-persistent-memory: auto injection failed: %o`, error)
        return decision
      }
    })
  }

  // ── memory_set：写入/更新一条记忆 ──────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_set',
    description: '持久化写入一条记忆（用户偏好/项目事实/任务状态）。同 scope+key 会覆盖更新；长文用 full（仅 memory_get includeFull 返回），value 写自足摘要。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键，如 user.name / project.tech' },
      value: { type: 'string', required: true, description: '记忆摘要：召回/搜索只展示它' },
      full: { type: 'string', description: '可选完整正文：memory_get 传 includeFull 才返回，避免 token 膨胀' },
      links: { type: 'array', items: { type: 'string' }, description: '可选关联记忆 key（同 scope）：召回时展示关联提示' },
      scope: { type: 'string', description: '作用域，默认 global；可按项目/工作区隔离' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
      confirmed: { type: 'boolean', description: '审批门：approveOnSet 开启时须为 true（先向用户确认过）' },
      source: { type: 'string', description: '可选来源引证（默认自动填 日期+会话）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          created: { type: 'boolean' },
          mergedKey: { type: 'string' },
          updatedAt: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.mergedKey
            ? `记忆已合并更新：${value.scope}/${value.mergedKey}（与新 key "${value.key}" 高度相似，未新建条目）@ ${value.updatedAt}`
            : `记忆已${value.created ? '写入' : '更新'}：${value.scope}/${value.key} @ ${value.updatedAt}`,
          ...(value.warnings?.length ? [`⚠️ ${value.warnings.join('；')}`] : []),
        ].join('\n'),
      }],
    },
    async execute(args: { key: string; value: string; full?: string; links?: string[]; scope?: string; tags?: string[]; confirmed?: boolean; source?: string }, exec?: any) {
      const key = String(args.key || '').trim()
      if (!key) throw new Error('memory_set: key 不能为空')
      // 审批门（v0.1.9，approveOnSet=true 时生效）：未经用户确认的写入拒绝，确认后带 confirmed: true 重试
      if (approveOnSet && args.confirmed !== true) {
        throw new Error('memory_set: 已开启写入审批（approveOnSet）。请先向用户确认是否记录这条记忆（直接询问或 ask_user_question），用户同意后带 confirmed: true 重试本次写入。')
      }
      const scope = normalizeScope(args.scope)
      // 硬层隔离（v0.1.6）：子代理禁止写 global 记忆（软层只读守则 + 此处拒绝双保险）
      if (isSubagentAgent(exec?.agent) && scope === 'global') {
        const subId = String(exec?.agent?.session?.id ?? 'unknown')
        throw new Error(`memory_set: 子代理会话禁止写入 global 记忆；确需落地请用 scope=sub:${subId}，成果建议以结果报告回传父会话由父会话沉淀`)
      }
      const tags = normalizeTags(args.tags)
      const links = normalizeTags(args.links)
      const full = args.full !== undefined ? (String(args.full).trim() || undefined) : undefined
      // ── 写侧闸门（v0.1.7）：把守则的执行纪律变成硬约束 ──────────────
      const KEY_PREFIX_WHITELIST = ['user', 'rule', 'task', 'ref', 'env', 'project', 'tool', 'auth', 'lesson', 'plugin']
      const prefix = key.split('.')[0]
      if (!KEY_PREFIX_WHITELIST.includes(prefix) && prefix !== scope) {
        throw new Error(`memory_set: key 前缀 "${prefix}" 不在分类白名单（user/rule/task/ref/env/project/tool/auth/lesson）。项目专属记忆请把项目名写进 scope 参数、key 前缀用标准分类（如 task.xxx 配 scope=项目名）；确需项目名前缀时 scope 须与 key 前缀一致。`)
      }
      const valueLen = String(args.value).length
      if (valueLen > 160) {
        throw new Error(`memory_set: value 摘要 ${valueLen} 字，超过 160 字上限。请把 value 压缩为自足摘要（≤160 字），细节写入 full 参数。`)
      }
      if (tags.length > 3) {
        throw new Error(`memory_set: tags 最多 3 个（当前 ${tags.length} 个）。请收敛到最能代表内容的 1-3 个标签。`)
      }
      const warnings: string[] = []
      if (prefix !== 'auth') {
        const body = `${args.value}\n${args.full ?? ''}`
        if (/password|passwd|\b密码\b|\b口令\b|\b密钥\b/i.test(body)) {
          throw new Error('memory_set: 检测到疑似明文密码/密钥。凭据类记忆请用 auth.* 前缀（用户授权保留）；其他前缀一律只记指针（去哪查），不记明文。')
        }
        if (/token|secret|api[_-]?key/i.test(body)) {
          warnings.push('内容含 token/secret 类关键词：请确认这是"去哪查"的指针而非明文凭据')
        }
      }
      if (prefix === 'task' && !/\d{4}-\d{2}-\d{2}/.test(String(args.value))) {
        warnings.push('task.* 建议在 value 中写明绝对日期（如 2026-09-03），相对时间会过期失真')
      }
      const now = new Date().toISOString()
      // 来源引证（v0.1.9）：默认自动填 日期+会话前缀；显式 source 参数优先
      const sessionId = String(exec?.agent?.session?.id ?? '')
      const source = (args.source || '').trim() || `${now.slice(0, 10)}${sessionId ? ` s=${sessionId.slice(0, 8)}` : ''}`
      return withLock(async () => {
        const items = await readItems()
        let idx = items.findIndex((item) => item.scope === scope && item.key === key)
        let created = false
        let mergedKey = ''
        // ④ 去重合并：同 scope 下 key 高度相似的旧条目视为同一条记忆，就地更新而非新建
        if (idx < 0 && dedupeOnSet) {
          const similar = items
            .map((item, i) => ({ i, sim: item.scope === scope ? keySimilarity(item.key, key) : 0 }))
            .filter((entry) => entry.sim >= 0.6)
            .sort((a, b) => b.sim - a.sim)[0]
          if (similar) {
            idx = similar.i
            mergedKey = items[idx].key
          }
        }
        if (idx >= 0) {
          const prev = items[idx]
          items[idx] = {
            ...prev,
            value: String(args.value),
            full: full !== undefined ? full : prev.full,
            links: links.length ? links : prev.links,
            tags: tags.length ? tags : prev.tags,
            updatedAt: now,
            source: (args.source || '').trim() ? source : prev.source,
          }
        } else {
          // v0.1.9 内容冲突检测：同 scope 已有内容高度相似的条目 → 警告提示确认，不静默并存
          const clash = items
            .map((item, i) => ({
              i,
              sim: item.scope === scope
                ? contentSimilarity(item, { key, value: String(args.value), scope, tags: [], id: '', createdAt: now, updatedAt: now } as MemoryItem)
                : 0,
            }))
            .filter((entry) => entry.sim >= 0.55)
            .sort((a, b) => b.sim - a.sim)[0]
          if (clash) {
            warnings.push(`与已有条目 ${scope}/${items[clash.i].key} 内容高度相似（${Math.round(clash.sim * 100)}%）：请确认是否应更新该条（memory_set 同 key）而非新建`)
          }
          items.push({ id: makeId(), key, value: String(args.value), full, links: links.length ? links : undefined, scope, tags, createdAt: now, updatedAt: now, source })
          created = true
        }
        await writeItems(items)
        return { ok: true, key, scope, created, mergedKey, updatedAt: now, warnings: warnings.length ? warnings : undefined }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_set')

  // ── memory_get：按 key 读取 ───────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_get',
    description: '按 key（可带 scope）读取一条持久记忆；includeFull 获取长文完整内容。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键' },
      scope: { type: 'string', description: '作用域，默认 global' },
      includeFull: { type: 'boolean', description: '是否返回 full 完整正文（默认 false，只返回摘要 value）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          value: { type: 'string' },
          full: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          updatedAt: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `记忆 ${value.scope}/${value.key}：${value.value}${value.full ? '\n(已附完整正文)' : ''}${value.tags?.length ? `（标签：${value.tags.join(', ')}）` : ''}`
          : `未找到记忆：${value.scope}/${value.key}`,
      }],
    },
    async execute(args: { key: string; scope?: string; includeFull?: boolean }) {
      const key = String(args.key || '').trim()
      if (!key) throw new Error('memory_get: key 不能为空')
      const scope = normalizeScope(args.scope)
      const includeFull = args.includeFull === true
      return withLock(async () => {
        const items = await readItems()
        const item = items.find((entry) => entry.scope === scope && entry.key === key)
        if (!item) return { found: false, key, scope }
        return {
          found: true,
          key,
          scope,
          value: item.value,
          ...(includeFull && item.full ? { full: item.full } : {}),
          tags: item.tags,
          updatedAt: item.updatedAt,
        }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_get')

  // ── memory_search：按关键词/标签搜索 ─────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '搜索持久记忆：按关键词（匹配 key/value/tags/scope）或标签过滤，返回最多 limit 条。',
    parameters: {
      query: { type: 'string', description: '关键词，留空则只按 tags/scope 过滤' },
      scope: { type: 'string', description: '限定作用域' },
      tags: { type: 'array', items: { type: 'string' }, description: '必须包含的标签' },
      limit: { type: 'number', description: '返回条数上限，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                value: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.count) return [{ type: 'text', text: '没有匹配的记忆。' }]
        const lines = value.items.map((item) => `- ${item.scope}/${item.key}: ${item.value}`)
        return [{ type: 'text', text: `找到 ${value.count} 条记忆：\n${lines.join('\n')}` }]
      },
    },
    async execute(args: { query?: string; scope?: string; tags?: string[]; limit?: number }) {
      const result = await searchItems(args)
      return {
        count: result.count,
        items: result.items.map((item) => ({
          key: item.key,
          scope: item.scope,
          value: item.value,
          tags: item.tags,
          updatedAt: item.updatedAt,
        })),
      }
    },
  })), '@dsh-external/dsh-persistent-memory: memory_search')

  // ── memory_forget：删除一条记忆 ───────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除一条持久记忆（按 scope+key）。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键' },
      scope: { type: 'string', description: '作用域，默认 global' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          removed: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          scope: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed ? `已删除记忆：${value.scope}/${value.key}` : `未找到要删除的记忆：${value.scope}/${value.key}`,
      }],
    },
    async execute(args: { key: string; scope?: string }) {
      const key = String(args.key || '').trim()
      if (!key) throw new Error('memory_forget: key 不能为空')
      const scope = normalizeScope(args.scope)
      return withLock(async () => {
        const items = await readItems()
        const before = items.length
        const next = items.filter((item) => !(item.scope === scope && item.key === key))
        if (next.length === before) return { ok: true, removed: false, key, scope }
        await writeItems(next)
        return { ok: true, removed: true, key, scope }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_forget')

  // ── memory_stats：查看记忆库概况 ─────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: '查看持久记忆库概况：总条数、各作用域分布。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          scopes: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const scopes = Object.entries(value.scopes || {}).map(([scope, count]) => `- ${scope}: ${count}`).join('\n')
        return [{ type: 'text', text: `记忆库共 ${value.total} 条：\n${scopes}` }]
      },
    },
    async execute() {
      return withLock(async () => {
        const items = await readItems()
        const scopes: Record<string, number> = {}
        for (const item of items) scopes[item.scope] = (scopes[item.scope] || 0) + 1
        return { total: items.length, scopes }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_stats')

  // ── 记忆代谢（v0.1.9）：列出过期候选，由模型决定更新/归档/删除 ────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_dream',
    description: '记忆代谢维护：列出过期/低活跃候选条目（task.* 超 30 天未更新、任意条目超 90 天、标记完成超 14 天），给出处理建议，由你执行后续 memory_set/memory_forget。',
    parameters: {
      scope: { type: 'string', description: '限定作用域，默认全部' },
      maxItems: { type: 'number', description: '最多列出的候选数，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: { type: 'array', items: { type: 'string' }, required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: { scope?: string; maxItems?: number }) {
      const scopeFilter = args.scope ? normalizeScope(args.scope) : ''
      const maxItems = Math.max(1, Math.min(50, Number(args.maxItems) || 20))
      return withLock(async () => {
        const items = await readItems()
        const nowMs = Date.now()
        const DAY = 86_400_000
        const candidates = items
          .filter((item) => (!scopeFilter || item.scope === scopeFilter) && !item.key.startsWith('auth.'))
          .map((item) => {
            const ageDays = Math.floor((nowMs - Date.parse(item.updatedAt)) / DAY)
            let reason = ''
            let suggest = ''
            if (item.key.startsWith('task.') && ageDays > 30) { reason = 'task 状态超过 30 天未更新'; suggest = '确认是否已完成/过时：更新 value 或 memory_forget' }
            else if (ageDays > 90) { reason = '超过 90 天未更新'; suggest = '归档（详情挪 full）或 memory_forget' }
            else if (/done|completed|已完成|完成/.test(item.value) && ageDays > 14) { reason = '标记完成已超 14 天'; suggest = 'memory_forget 或归档' }
            return { key: item.key, scope: item.scope, ageDays, reason, suggest }
          })
          .filter((c) => c.reason)
          .sort((a, b) => b.ageDays - a.ageDays)
          .slice(0, maxItems)
        const summary = candidates.length === 0
          ? '记忆代谢：没有发现过期候选，记忆库很健康。'
          : `记忆代谢：发现 ${candidates.length} 条过期候选（按陈旧度排序）：\n` + candidates.map((c) => `- [${c.scope}/${c.key}] ${c.ageDays} 天前更新，${c.reason} → ${c.suggest}`).join('\n')
        return {
          candidates: candidates.map((c) => `${c.scope}/${c.key}|${c.ageDays} 天|${c.reason}|${c.suggest}`),
          summary,
        }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_dream')

  // ── 记忆导入（v0.1.9）：CLAUDE.md / MEMORY.md / memories.json 一键入库 ──
  function slugKey(s: string): string {
    const cleaned = s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    return cleaned || 'item'
  }
  function parseImportEntries(raw: string, filePath: string): { key: string; value: string; full?: string; tags: string[] }[] {
    const lower = filePath.toLowerCase()
    if (lower.endsWith('.json')) {
      let data: unknown
      try { data = JSON.parse(raw) } catch { throw new Error(`memory_import: ${filePath} 不是合法 JSON`) }
      const entries: { key: string; value: string; full?: string; tags: string[] }[] = []
      const walk = (obj: unknown, prefix: string) => {
        if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, `${prefix}-${i}`)); return }
        if (obj && typeof obj === 'object') {
          const o = obj as Record<string, unknown>
          if (typeof o.value === 'string') {
            entries.push({ key: `${prefix}.${slugKey(String(o.key ?? 'item'))}`, value: String(o.value), full: typeof o.full === 'string' ? o.full : undefined, tags: [] })
          } else {
            for (const [k, v] of Object.entries(o)) walk(v, `${prefix}.${slugKey(k)}`)
          }
        }
      }
      walk(data, 'import')
      return entries
    }
    const blocks = raw.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean)
    const out: { key: string; value: string; full?: string; tags: string[] }[] = []
    blocks.forEach((block, i) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
      const heading = lines.find((l) => l.startsWith('#')) || ''
      const body = lines.filter((l) => !l.startsWith('#')).join(' ')
      const text = body || heading.replace(/^#+\s*/, '')
      if (!text) return
      const tag = heading.replace(/^#+\s*/, '').slice(0, 24)
      let prefix = 'ref'
      if (/必须|不要|禁止|一律|规则|默认|优先|纠正/i.test(text)) prefix = 'rule'
      else if (/教训|坑|切记|注意/i.test(text)) prefix = 'lesson'
      out.push({
        key: `${prefix}.${slugKey(tag || `item${i + 1}`)}`,
        value: text.length > 160 ? `${text.slice(0, 157)}…` : text,
        full: text.length > 160 ? text : undefined,
        tags: [],
      })
    })
    return out
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_import',
    description: '把外部文件导入记忆库：CLAUDE.md / MEMORY.md / Claude Code memories.json 等。.json 按条目、.md/.txt 按段落切分，自动分配 ref/rule/lesson 前缀，value 截 160 字余量入 full，与库中已有条目内容高度相似（≥70%）自动跳过。',
    parameters: {
      path: { type: 'string', required: true, description: '要导入的文件绝对路径' },
      scope: { type: 'string', description: '目标 scope，默认 global' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imported: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: { path: string; scope?: string }) {
      const filePath = String(args.path || '').trim()
      if (!filePath) throw new Error('memory_import: path 必填')
      const scope = normalizeScope(args.scope)
      let raw: string
      try { raw = await fs.readFile(filePath, 'utf8') } catch { throw new Error(`memory_import: 无法读取 ${filePath}`) }
      const entries = parseImportEntries(raw, filePath)
      if (entries.length === 0) throw new Error(`memory_import: ${filePath} 没有可导入的内容`)
      return withLock(async () => {
        const items = await readItems()
        const now = new Date().toISOString()
        let imported = 0
        let skipped = 0
        for (const e of entries) {
          const dup = items.some((item) => item.scope === scope
            && contentSimilarity(item, { key: e.key, value: e.value, scope, tags: [], id: '', createdAt: now, updatedAt: now } as MemoryItem) >= 0.7)
          if (dup) { skipped++; continue }
          items.push({ id: makeId(), key: e.key, value: e.value, full: e.full, scope, tags: e.tags, createdAt: now, updatedAt: now, source: `import:${basename(filePath)}` })
          imported++
        }
        await writeItems(items)
        return { imported, skipped, summary: `导入完成：${imported} 条新增（${scope}），${skipped} 条与库中已有内容高度相似被跳过。` }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_import')

  // ── 会话回捞（v0.1.9）：sessionQuery 全文检索历史会话 ─────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '会话回捞：全文检索历史会话（DSH sessionQuery 服务），把最强匹配的会话片段带回上下文。记忆库里没有、但以前会话说过的事，用它找。',
    parameters: {
      query: { type: 'string', required: true, description: '要回捞的主题/关键词' },
      limit: { type: 'number', description: '最多返回的会话命中数，默认 3' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: { type: 'array', items: { type: 'string' }, required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: { query: string; limit?: number }) {
      const query = String(args.query || '').trim()
      if (!query) throw new Error('memory_recall: query 必填')
      const sq = ctx.get('sessionQuery') as { searchSessions?: (r: { query: string; limit?: number }) => Promise<{ items?: readonly { id?: string; title?: string; bestMatch?: { text?: string; seq?: number } }[] }> } | undefined
      if (!sq || typeof sq.searchSessions !== 'function') {
        throw new Error('memory_recall: 当前环境没有 sessionQuery 服务（全文会话检索不可用）')
      }
      const limit = Math.max(1, Math.min(10, Number(args.limit) || 3))
      let page
      try { page = await sq.searchSessions({ query, limit }) } catch (err) {
        ctx.logger.warn('dsh-persistent-memory: memory_recall search failed: %o', err)
        throw new Error('memory_recall: 历史会话检索失败，稍后再试')
      }
      const hits = (page?.items ?? []).map((h) => ({
        sessionId: String(h?.id ?? ''),
        title: String((h as unknown as { title?: string })?.title ?? ''),
        seq: Number(h?.bestMatch?.seq ?? 0),
        snippet: String(h?.bestMatch?.text ?? '').slice(0, 400),
      })).filter((h) => h.snippet)
      const summary = hits.length === 0
        ? '没有从历史会话中回捞到相关内容。'
        : `历史会话回捞 ${hits.length} 条：\n` + hits.map((h) => `- [${h.title || h.sessionId} #${h.seq}] ${h.snippet}`).join('\n')
      return {
        hits: hits.map((h) => `${h.title || h.sessionId}#${h.seq}|${h.snippet}`),
        summary,
      }
    },
  })), '@dsh-external/dsh-persistent-memory: memory_recall')

  // ── /memory 斜杠命令：人直接查看/写入记忆，不依赖模型调用工具 ────────
  ctx.commands.register({
    name: 'memory',
    description: '查看/写入持久记忆：status / recall <查询> / remember <key> <内容> / forget <key> / dream / import <文件> / panel',
    input: { hint: '<status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|panel>' },
    recordInput: false,
    handler: (invocation) => executeMemoryCommand(invocation),
  })

  // 自包含 HTML 记忆面板（v0.1.9）：浏览器打开即用，数据内嵌 JSON，支持搜索
  function buildPanelHtml(items: { scope: string; key: string; value: string; tags: string[]; updatedAt: string }[]): string {
    const data = JSON.stringify(items).replace(/</g, '\\u003c')
    const css = 'body{font-family:system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#222}input{width:100%;padding:8px 10px;font-size:15px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px}.item{border:1px solid #e0e0e0;border-radius:8px;padding:10px 14px;margin:10px 0}.key{font-weight:600}.meta{color:#999;font-size:12px;margin-left:8px}.tag{background:#eef2ff;border-radius:4px;padding:1px 6px;font-size:12px;margin-right:4px;color:#334}'
    const js = [
      'const ITEMS = ' + data + ';',
      `const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));`,
      `function render(){const q=document.getElementById('q').value.toLowerCase();const list=ITEMS.filter((i)=>!q||(i.key+' '+i.value+' '+i.tags.join(' ')).toLowerCase().includes(q));document.getElementById('count').textContent='共 '+ITEMS.length+' 条（不含 auth.*）';document.getElementById('list').innerHTML=list.map((i)=>'<div class="item"><div><span class="key">'+esc(i.scope+'/'+i.key)+'</span><span class="meta">'+esc(i.updatedAt.slice(0,10))+'</span>'+i.tags.map((t)=>'<span class="tag">'+esc(t)+'</span>').join('')+'</div><div>'+esc(i.value)+'</div></div>').join('');}`,
      `document.getElementById('q').addEventListener('input',render);render();`,
    ].join('\n')
    return '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 记忆面板</title><style>' + css + '</style></head><body><h2>DSH 记忆面板</h2><p id="count"></p><input id="q" placeholder="搜索 key / 内容 / 标签…"><div id="list"></div><script>' + js + '</script></body></html>'
  }

  async function executeMemoryCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const raw = invocation.rawInput.trim()
    const [sub, ...rest] = raw.split(/\s+/)
    const arg = rest.join(' ').trim()
    const USAGE = 'Usage: /memory <status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|panel>'
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
        const now = new Date().toISOString()
        await withLock(async () => {
          const items = await readItems()
          const idx = items.findIndex((item) => item.scope === defaultScope && item.key === key)
          if (idx >= 0) {
            items[idx] = { ...items[idx], value, updatedAt: now }
          } else {
            items.push({ id: makeId(), key, value, scope: defaultScope, tags: [], createdAt: now, updatedAt: now })
          }
          await writeItems(items)
        })
        return { kind: 'success', text: `已写入记忆：${defaultScope}/${key}` }
      }
      case 'forget': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory forget <key>' }
        const removed = await withLock(async () => {
          const items = await readItems()
          const next = items.filter((item) => !(item.scope === defaultScope && item.key === arg))
          if (next.length === items.length) return false
          await writeItems(next)
          return true
        })
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
            else if (/done|completed|已完成|完成/.test(item.value) && ageDays > 14) { reason = '标记完成超 14 天'; suggest = '删除或归档' }
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
        let raw: string
        try { raw = await fs.readFile(arg, 'utf8') } catch { return { kind: 'error', text: `无法读取文件：${arg}` } }
        let entries
        try { entries = parseImportEntries(raw, arg) } catch (err) { return { kind: 'error', text: String(err instanceof Error ? err.message : err) } }
        if (entries.length === 0) return { kind: 'error', text: `${arg} 没有可导入的内容。` }
        let imported = 0
        let skipped = 0
        const now = new Date().toISOString()
        await withLock(async () => {
          const items = await readItems()
          for (const e of entries) {
            const dup = items.some((item) => item.scope === defaultScope
              && contentSimilarity(item, { key: e.key, value: e.value, scope: defaultScope, tags: [], id: '', createdAt: now, updatedAt: now } as MemoryItem) >= 0.7)
            if (dup) { skipped++; continue }
            items.push({ id: makeId(), key: e.key, value: e.value, full: e.full, scope: defaultScope, tags: e.tags, createdAt: now, updatedAt: now, source: `import:${basename(arg)}` })
            imported++
          }
          await writeItems(items)
        })
        return { kind: 'success', text: `导入完成：${imported} 条新增（${defaultScope}），${skipped} 条与库中已有内容高度相似被跳过。` }
      }
      case 'panel': {
        const items = await withLock(async () => readItems())
        const safe = items.filter((i) => !i.key.startsWith('auth.')).map((i) => ({ scope: i.scope, key: i.key, value: i.value, tags: i.tags, updatedAt: i.updatedAt }))
        const outPath = join(process.cwd(), `memory-panel-${new Date().toISOString().slice(0, 10)}.html`)
        await fs.writeFile(outPath, buildPanelHtml(safe), 'utf8')
        return { kind: 'success', text: `已生成记忆面板：${outPath}\n浏览器打开即可浏览/搜索全部记忆（auth.* 凭据已排除）。` }
      }
      default:
        return { kind: 'error', text: USAGE }
    }
  }

  // settings 面板（v0.1.9）：DSH 设置页提供本插件开关卡片（缺 settings 服务时静默跳过）
  ctx.inject(['settings'], (scopedCtx) => {
    const scoped = scopedCtx as { settings?: { register: (ns: string, schema: unknown, opts: { base: Record<string, unknown> }) => { get: () => Record<string, unknown>; watch: (fn: () => void) => void } } }
    if (!scoped.settings) return
    const entry: Record<string, unknown> = {
      autoRecall, autoCapture, autoRecallRerank, rrfRecall, approveOnSet,
    }
    let source = () => entry
    const applyPanel = () => {
      const v = source()
      config.autoRecall = Boolean(v.autoRecall)
      config.autoCapture = Boolean(v.autoCapture)
      config.autoRecallRerank = Boolean(v.autoRecallRerank)
      config.rrfRecall = Boolean(v.rrfRecall)
      config.approveOnSet = Boolean(v.approveOnSet)
    }
    try {
      const scope = scoped.settings.register('dsh-persistent-memory', z.object({
        autoRecall: z.boolean().default(true),
        autoCapture: z.boolean().default(true),
        autoRecallRerank: z.boolean().default(true),
        rrfRecall: z.boolean().default(true),
        approveOnSet: z.boolean().default(false),
      }), { base: entry })
      source = () => scope.get() as Record<string, unknown>
      scopedCtx.effect(() => () => {
        source = () => entry
        applyPanel()
      })
      scope.watch(applyPanel)
      applyPanel()
    } catch (err) {
      ctx.logger.warn('dsh-persistent-memory: settings panel unavailable: %o', err)
    }
  })
}
