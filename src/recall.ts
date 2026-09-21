import type { MemoryItem } from './types.js'

// ③ 同义词表：扩展 token，弥补字面匹配的语义盲区（代理↔梯子↔vpn 等）
export const SYNONYM_GROUPS: string[][] = [
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
export const NOISE_WORDS = [
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
export const WEAK_WORDS = [
  '记忆', '上下文', '插件', '扩展', '工具', '环境', '代理', '网络', '问题', '建议', '帮助',
  '处理', '解决', '修复', '测试', '运行', '执行', '继续', '开始', '查看', '检查', '文件',
  '命令', '配置', '设置', '项目', '状态', '记录', '内容', '数据',
]

// m3：预编译为单个正则（原实现对每个 token 遍历约 110 个词做 split/join，
// 1000 条库 × 12 token × 110 词 ≈ 每轮 130 万次字符串分割）
const NOISE_RE = new RegExp(NOISE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
export function stripNoise(token: string): string {
  return token.toLowerCase().replace(NOISE_RE, '')
}

export function expandToken(token: string): string[] {
  // 长 token（整句/跨词块）不做同义展开：避免"看看我自己做的记忆插件"整串命中
  // `插件` 组从而把 9 组同义词全部带入评分（0.1.2 误召回的主要来源）。
  if (token.length > 6) return [token]
  const out = [token]
  for (const group of SYNONYM_GROUPS) {
    if (group.some((w) => token.includes(w) || w.includes(token))) out.push(...group)
  }
  return [...new Set(out)]
}

export function queryTokens(query: string): string[] {
  const tokens = query.toLowerCase().split(/[\s,，。.!！?？:：;；、/\\()[\]{}"']+/).filter(Boolean)
  return tokens.length > 0 ? tokens.slice(0, 12) : [query.toLowerCase()]
}

// ④b 语义辅助（v0.1.9）：中文二元组 + 英文词元，零 token 零依赖
export function tokenizeForSemantic(s: string): string[] {
  const cleaned = s.toLowerCase().replace(/\s+/g, ' ')
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

export function bigramJaccard(a: string, b: string): number {
  const ta = tokenizeForSemantic(a)
  const tb = tokenizeForSemantic(b)
  if (!ta.length || !tb.length) return 0
  const setB = new Set(tb)
  const overlap = ta.filter((t) => setB.has(t)).length
  return overlap / (ta.length + tb.length - overlap)
}

// RRF 补位的语义交集门槛（v0.1.21）：查询与条目共享多少个中文二元组/英文词元。
export function semanticOverlap(query: string, text: string): number {
  const q = tokenizeForSemantic(query)
  const t = new Set(tokenizeForSemantic(text))
  return q.filter((token) => t.has(token)).length
}

// ④ key 相似度（词元重叠率），用于 memory_set 去重合并
export function keySimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const ta = norm(a)
  const tb = norm(b)
  if (!ta.length || !tb.length) return 0
  const setB = new Set(tb)
  const overlap = ta.filter((t) => setB.has(t)).length
  return overlap / Math.max(ta.length, tb.length)
}

// 内容冲突检测（v0.1.9）：key 相似与 value 语义相似取高者
export function contentSimilarity(a: MemoryItem, b: MemoryItem): number {
  return Math.max(bigramJaccard(a.value, b.value), keySimilarity(a.key, b.key))
}

export interface ScoreEnv {
  /** 启用同义词扩展评分（代理↔梯子↔vpn、认证↔登录↔凭据等） */
  synonymExpansion: boolean
  /** task.* 保鲜期（天）：超期在召回评分中降权 */
  taskTtlDays: number
  /** 当前工作区 scope 小写清单（global 不加不减，命中工作区加权） */
  workspaceScopes: string[]
}

export function scoreItem(item: MemoryItem, query: string, isFirstTurn: boolean, env: ScoreEnv): number {
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
  const wsScopes = env.workspaceScopes
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
    const stripped = stripNoise(token)
    if (stripped.length < 2 && token.length < 8) continue

    const isWeak = WEAK_WORDS.some((w) => token.includes(w))
    if (key.includes(token)) {
      score += key === token ? 9 : 5
    } else if (value.includes(token)) {
      score += isWeak ? 1 : 2
    } else if (env.synonymExpansion && !isWeak && token.length <= 6) {
      // ③ 同义词扩展：仅短 token（≤6 字符）展开，且只作用于 key/tags（value 太宽泛，易误命中）
      const synonyms = expandToken(token).filter((w) => w !== token)
      if (synonyms.some((w) => key.includes(w))) score += 2
      else if (synonyms.some((w) => tags.some((tag) => tag.includes(w)))) score += 1
    }
    if (scope.includes(token)) score += 1
    if (tags.some((tag) => tag.includes(token) || token.includes(tag))) score += 2
  }

  // ⑥ 画像式分层修正：user.* 是稳定画像（用户偏好/禁忌），首轮应优先注入而非降权
  if (key.startsWith('user.') && isFirstTurn) score += 1

  // ⑦ task.* 保鲜期（v0.1.16）：任务状态变化快，超期记忆降权而非删除
  if (key.startsWith('task.')) {
    const ageDays = Math.floor((Date.now() - Date.parse(item.updatedAt)) / 86_400_000)
    if (Number.isFinite(ageDays) && ageDays > env.taskTtlDays) score -= 3
  }

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

// 教训通道的轻量词法命中：与 scoreItem 同源的噪声/弱词规则，但去掉工作区加分与同义词扩展
export function lexicalHit(item: MemoryItem, query: string): boolean {
  const key = item.key.toLowerCase()
  const value = item.value.toLowerCase()
  const tags = item.tags.map((tag) => tag.toLowerCase())
  return queryTokens(query).some((token) => {
    const stripped = stripNoise(token)
    if (stripped.length < 2 && token.length < 8) return false
    const isWeak = WEAK_WORDS.some((w) => token.includes(w))
    if (key.includes(token)) return true
    if (value.includes(token) && !isWeak) return true
    return tags.some((tag) => tag.includes(token) || token.includes(tag))
  })
}

// RRF 倒数排名融合：词法分 + bigram 相似度双排名（对标 dsh-evolve 的零 token 混合召回）
export function rrfRanking(items: MemoryItem[], query: string, env: ScoreEnv, isFirstTurn = false): { item: MemoryItem; rrf: number }[] {
  if (!query || items.length === 0) return []
  // m5：首轮补位此前恒用非首轮评分（含信号词扩展与无关 scope 的 -4 降权而非首轮排除），
  // 与首轮语义冲突；现由调用方透传 isFirstTurn
  const lex = items.map((item) => ({ item, s: scoreItem(item, query, isFirstTurn, env) }))
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

export interface RecallEnv extends ScoreEnv {
  /** 自动召回限定作用域；空串表示不限定 */
  autoRecallScope: string
  /** 非首轮召回的绝对分数下限 */
  minScore: number
  /** 相对阈值：低于最高分该比例的记忆不注入；0 表示禁用 */
  relativeFloor: number
  /** 写入 RRF 混合召回（词法+中文二元组双排名融合） */
  rrfRecall: boolean
  /** RRF 语义补位是否只在首轮生效 */
  rrfFirstTurnOnly: boolean
}

export function pickRecallItems(
  items: MemoryItem[],
  query: string,
  limit: number,
  useFallback: boolean,
  isFirstTurn: boolean,
  hasImage: boolean,
  env: RecallEnv,
): MemoryItem[] {
  const scoped = env.autoRecallScope ? items.filter((item) => item.scope === env.autoRecallScope) : items
  if (scoped.length === 0) return []
  const scored = scoped.map((item) => ({ item, score: scoreItem(item, query, isFirstTurn, env) }))
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.item.updatedAt.localeCompare(a.item.updatedAt)
  })
  // 阈值（v0.1.17）：绝对下限 + 相对比例组合。首轮仍用固定 6（一次 key 直中 + 少量辅助）。
  // m1（口径明确化）：首轮要过 6 分必须 key 命中（key 全等 9 / 部分命中 5）再加少量辅助分；
  // 仅 value 命中只有 2 分（弱主题词 1 分），所以「只记得内容里的词」在首轮召不到——
  // 设计意图是首轮只按 key/画像召回，内容检索交给 memory_search（README 已同步说明）。
  const minScore = isFirstTurn ? 6 : env.minScore
  const best = scored.length > 0 ? scored[0].score : 0
  const relativeFloor = (!isFirstTurn && env.relativeFloor > 0 && best > 0)
    ? best * env.relativeFloor
    : 0
  const floor = Math.max(minScore, relativeFloor)
  const top = scored.filter((entry) => entry.score >= floor).map((entry) => entry.item)
  // 画像兜底已移除（v0.1.6）：首轮 0 命中改由 pre-step 的【记忆索引】块兜底。
  if (top.length >= limit) return top.slice(0, limit)
  // v0.1.9 RRF 语义补位：词法 0 命中时，用词法+二元组双排名召回语义相关条目（零 token）
  if (env.rrfRecall && (!env.rrfFirstTurnOnly || isFirstTurn) && top.length === 0 && query) {
    // 补位也必须真的沾边：共享中文二元组/英文词元才算相关。
    const minOverlap = isFirstTurn ? 2 : 1
    const ranked = rrfRanking(scoped, query, env, isFirstTurn).filter((e) => {
      if (e.rrf < 0.025) return false
      return semanticOverlap(query, `${e.item.key} ${e.item.value}`) >= minOverlap
    })
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

// 注入预算裁剪（v0.1.16）：按分数顺序累计，遇到第一条放不下的就 break——列表按分数排序，
// 后面的更不重要，宁少勿多。注意 break 的代价：一条高分大条目会挡住后面本可放下的小条目，
// 额度可能被空置（第七轮复审实测：A(cost 240/渲染 266) + B(渲染 126)、budget 250 → 一条都进不去）。
// M11：返回 { kept, used }；used 是估算值，**现已无消费者**（第七轮起两个通道都改用
// fitByRenderedLength 的真实渲染长度扣减），保留它只为单测与将来的估算层用途。
export function fitBudget(
  items: MemoryItem[],
  budget: number,
  maxChars: number,
  sanitize: (s: string) => string,
  opts: { atLeastOne?: boolean } = {},
): { kept: MemoryItem[]; used: number } {
  const kept: MemoryItem[] = []
  let used = 0
  // M11：会话级总预算耗尽（<=0）时直接返回空
  if (budget <= 0) return { kept, used }
  for (const item of items) {
    const cost = Math.min(sanitize(item.value).length, maxChars) + item.key.length + 64
    // atLeastOne=false（受总预算约束的通道）：第一条也必须落在预算内，否则总预算被击穿
    if (used + cost > budget && !(opts.atLeastOne !== false && kept.length === 0)) break
    kept.push(item)
    used += cost
  }
  return { kept, used }
}

/**
 * 按「渲染后真实长度」收敛（M11 收口；第七轮从 pre-step 的两处重复循环抽成纯函数，便于单测）。
 *
 * fitBudget 的 cost 是条目估算（value + key + 64），不含通道标题、行前缀与「🔗 关联」等包装——
 * 实测每通道低估 17–22 字。直接按估算扣减，后续通道会据虚高的剩余额度误判（索引块挤进真实
 * 已经不足的余额）。这里从尾部（分数最低的项）逐个丢弃，直到渲染长度落进 budget。
 *
 * @param items 已按分数排序的候选
 * @param budget 本通道可用字符数；必须是有限数（调用方保证）。非有限值时不做裁剪原样返回——
 *   NaN 下 `text.length > budget` 恒 false，属 fail-open，故这里只文档化、不额外兜底。
 * @param render 把 kept 渲染成最终注入文本的函数（每轮迭代都会重新调用，故调用方应保持它无副作用）
 * @returns kept 与它的渲染结果；两者始终一致，调用方直接用 text.length 扣减预算。
 *   边界：budget ≤ 0 或单条就超预算时 kept 为空，此时 text 是 render([])（可能仍长于 budget，
 *   那是通道标题的固定开销，调用方以 kept.length > 0 为护栏）。
 */
export function fitByRenderedLength<T>(
  items: T[],
  budget: number,
  render: (items: T[]) => string,
): { kept: T[]; text: string } {
  let kept = items
  let text = render(kept)
  while (kept.length > 0 && text.length > budget) {
    kept = kept.slice(0, -1)
    text = render(kept)
  }
  return { kept, text }
}

// 在句子边界（。；！？/换行/空格）截断，避免"…dsh-file-…"这种半截文字。
// T14：省略号计入 maxChars —— 返回值长度恒 ≤ max（旧实现硬截断分支返回 max+1，
// 让「value ≤ valueMaxChars 字」的数据口径不成立）。句边界分支同样从 max-1 的头部里取。
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  const head = text.slice(0, max - 1)
  const boundary = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('！'),
    head.lastIndexOf('？'), head.lastIndexOf('\n'), head.lastIndexOf('. '),
  )
  return boundary > max * 0.5 ? `${head.slice(0, boundary + 1)}…` : `${head}…`
}

// ── 记忆新鲜度（借鉴 Claude Code memoryAge.ts）────────────────────────
export function ageLabel(iso: string): string {
  const d = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000))
  if (!Number.isFinite(d) || d === 0) return '今天'
  if (d === 1) return '昨天'
  return `${d} 天前`
}
