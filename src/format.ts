// 注入文本的渲染（召回行 / 教训行 / 索引块 / 重排清单）与漂移警告。
// 从 index.ts 拆出：这些函数原本闭包在 apply() 里，参数化后成为纯函数，可单测、可复用。
import { ageLabel, truncate } from './recall.js'
import { sanitizeValue } from './sanitize.js'
import { findCredentialMatch, isCredentialItem } from './write-gate.js'
import type { MemoryItem } from './types.js'

// 自动注入通道排除凭据（v0.1.20 起 auth.* 前缀；M2 起再排除 value 命中凭据正则的条目）：
// 凭据类记忆只在模型显式 memory_search / memory_get 时返回，不随首轮自动注入进入每个新会话。
export function excludeCredentials(items: MemoryItem[]): MemoryItem[] {
  return items.filter((item) => !item.key.toLowerCase().startsWith('auth.')
    && !findCredentialMatch(item.value))
}

// 合并漂移警告（v0.1.16）：每条记忆各附一段几乎相同的警告是纯冗余，
// 改为整块共用一段并取最老天数——信息量不变，字数降一个数量级。
function mergedDriftNote(items: MemoryItem[]): string {
  const ages = items
    .map((item) => Math.max(0, Math.floor((Date.now() - Date.parse(item.updatedAt)) / 86_400_000)))
    .filter((d) => Number.isFinite(d) && d > 1)
  if (ages.length === 0) return ''
  const oldest = Math.max(...ages)
  return `\n> ⚠️ 以上 ${ages.length} 条为 ${oldest} 天前的时点观察，可能已过时：点名的文件/路径/命令引用前先验证现状；与现状冲突时以现状为准，并更新该记忆。`
}

export function formatRecall(items: MemoryItem[], all: MemoryItem[], maxChars: number): string {
  const fitted = items
  const lines = fitted.map((item) => {
    // ⑤ 投毒防护：注入前清洗（控制字符/危险 URI scheme/提示注入模式）
    const cleaned = sanitizeValue(item.value)
    const value = truncate(cleaned, maxChars)
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
  const note = mergedDriftNote(fitted)
  return `【记忆自动召回】\n${lines.join('\n')}${note}`
}

export function formatLesson(items: MemoryItem[], maxChars: number): string {
  const fitted = items
  const lines = fitted.map((item) => {
    const cleaned = sanitizeValue(item.value)
    return `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}${item.source ? ` · 自${item.source}` : ''}] ${truncate(cleaned, maxChars)}`
  })
  const note = mergedDriftNote(fitted)
  return `【历史教训/规则提醒】以下记忆与当前场景相关，请优先遵守以避免重复犯错：\n${lines.join('\n')}${note}`
}

export function buildRerankManifest(items: MemoryItem[]): string {
  return items.map((item) => {
    const cleaned = sanitizeValue(item.value)
    return `- [${item.scope}/${item.key} · ${ageLabel(item.updatedAt)}] ${truncate(cleaned, 80)}`
  }).join('\n')
}

// ── 记忆索引（对标 Claude Code MEMORY.md，动态生成不落盘）──────────────
// 触发：首轮 && 无信号 && !hasImage && 常规召回 0 命中 && 教训通道未注入。
// 替代画像兜底（v0.1.7 起 user.* 在 global 组有固定 2 席配额，画像真实呈现）。
export function buildIndexBlock(rawItems: MemoryItem[], workspaceScopes: string[], excludeKeys?: Set<string>): string {
  // v0.1.20：只列 key 不列摘要（实测 424 → 约 160 字），并排除 auth.*——
  // 目录里出现 [auth.platforms] 这类 key 本身就是不该随新会话扩散的线索。
  // 教训通道已给过内容的条目从目录里去掉，避免同一会话里重复出现。
  const items = excludeCredentials(rawItems).filter((item) => !excludeKeys?.has(`${item.scope}/${item.key}`))
  const scopes = new Map<string, MemoryItem[]>()
  for (const item of items) {
    // M8：分组键与 order（均为小写）用同一口径比较，避免 'Global'/'Thesis' 类大小写差异导致条目在索引中隐身
    const sc = item.scope.toLowerCase()
    const group = sc === 'global' ? 'global'
      : (workspaceScopes.some((ws) => sc.includes(ws) || ws.includes(sc)) ? sc : null)
    if (!group) continue
    if (!scopes.has(group)) scopes.set(group, [])
    scopes.get(group)!.push(item)
  }
  const byUpdated = (a: MemoryItem, b: MemoryItem) => b.updatedAt.localeCompare(a.updatedAt)
  const lines: string[] = []
  const order = ['global', ...workspaceScopes]
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
    if (picks.length) lines.push(`- ${scope}: ${picks.map((item) => item.key).join('、')}`)
  }
  if (lines.length === 0) return ''
  lines.push('取内容：memory_search <关键词>')
  return `【记忆索引】以下记忆可查，本会话未自动召回：\n${lines.join('\n')}`
}
