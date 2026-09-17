import { KEY_PREFIX_WHITELIST, KEY_PREFIX_LIST } from './types.js'
import type { MemoryItem } from './types.js'
import { contentSimilarity, keySimilarity } from './recall.js'

/**
 * scope 归一（M8，v0.1.23）：trim + 统一小写。
 * 修复前只 trim：scope='Global' 既不是 'global'（索引分组失败）也不含小写工作区名，
 * 同一逻辑作用域裂成多个物理 scope（该条在索引中隐身、按 scope 精确检索查不到）。
 */
export function normalizeScope(scope: string | undefined, defaultScope: string): string {
  const s = (scope || defaultScope).trim().toLowerCase()
  return s || 'global'
}

/** key 前缀白名单硬校验：与守则文本同源（KEY_PREFIX_LIST） */
export function validateKeyPrefix(key: string, scope: string): void {
  const prefix = key.split('.')[0]
  if (!KEY_PREFIX_WHITELIST.includes(prefix) && prefix !== scope) {
    throw new Error(`memory_set: key 前缀 "${prefix}" 不在分类白名单（${KEY_PREFIX_LIST}）。项目专属记忆请把项目名写进 scope 参数、key 前缀用标准分类（如 task.xxx 配 scope=项目名）；确需项目名前缀时 scope 须与 key 前缀一致。`)
  }
}

/**
 * M2 增强版凭据正则：写侧拒绝 / 提取器 / 导入闸门共用同一份（防止实现漂移）。
 * 覆盖：弱关键词（token/secret/api key/password）、可识别形态
 * （bearer 长串、sk-/ghp_/AKIA、BEGIN PRIVATE KEY 块）与中文口令词。
 */
export const CREDENTIAL_RE = /token|secret|api[_-]?key|bearer\s+\S{16,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN .*PRIVATE KEY|password|passwd|密码|口令|密钥/i

/** 返回命中的凭据片段（未命中 null） */
export function findCredentialMatch(body: string): string | null {
  const m = body.match(CREDENTIAL_RE)
  return m ? m[0] : null
}

/**
 * C7：凭据掩码（工具出库面用）。记忆原文会随工具返回进入会话上下文并外发至
 * 配置的 LLM provider——auth.* 与命中凭据正则的条目默认只回掩码，保留可识别
 * 前缀（sk-/ghp_/AKIA/Bearer）以便用户知道"这里有一条什么凭据记忆"。
 */
export function maskCredential(text: string): string {
  const m = text.match(/(sk-|ghp_|AKIA|Bearer\s+)/i)
  if (m) return `${m[1]}****（凭据已掩码，memory_get 带 confirmed:true 可取回原文）`
  return '****（凭据类记忆已掩码，memory_get 带 confirmed:true 可取回原文）'
}

/** C7：该条目是否属于"默认掩码、需显式确认才返回原文"的类别 */
export function isCredentialItem(key: string, value: string): boolean {
  return key.toLowerCase().startsWith('auth.') || findCredentialMatch(value) !== null
}

export interface UpsertInput {
  key: string
  value: string
  full?: string
  links: string[]
  tags: string[]
  scope: string
  createdAt: string
  updatedAt: string
  /** 来源引证（已解析的最终值） */
  source: string
  /** args.source 是否显式传入（决定更新时保留旧 source 还是覆盖） */
  explicitSource: boolean
}

export interface UpsertResult {
  created: boolean
  mergedKey: string
  /** 内容高度相似（≥55%）但未合并的已有条目 key（供警告） */
  clashKey?: string
  clashSim?: number
}

/** 写入/更新的合并逻辑：同 scope+key 覆盖更新；dedupe 时高相似 key 就地合并；否则 push 新建 */
export function upsertMemory(items: MemoryItem[], input: UpsertInput, opts: { dedupe: boolean; makeId: () => string }): UpsertResult {
  const { key, value, full, links, tags, scope, createdAt, updatedAt, source, explicitSource } = input
  let idx = items.findIndex((item) => item.scope === scope && item.key === key)
  let created = false
  let mergedKey = ''
  let clashKey: string | undefined
  let clashSim: number | undefined
  // ④ 去重合并：同 scope 下 key 高度相似的旧条目视为同一条记忆，就地更新而非新建
  if (idx < 0 && opts.dedupe) {
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
      value,
      full: full !== undefined ? full : prev.full,
      links: links.length ? links : prev.links,
      tags: tags.length ? tags : prev.tags,
      updatedAt,
      source: explicitSource ? source : prev.source,
    }
  } else {
    // v0.1.9 内容冲突检测：同 scope 已有内容高度相似的条目 → 警告提示确认，不静默并存
    const clash = items
      .map((item, i) => ({
        i,
        sim: item.scope === scope
          ? contentSimilarity(item, { key, value, scope, tags: [], id: '', createdAt, updatedAt } as MemoryItem)
          : 0,
      }))
      .filter((entry) => entry.sim >= 0.55)
      .sort((a, b) => b.sim - a.sim)[0]
    if (clash) {
      clashKey = items[clash.i].key
      clashSim = clash.sim
    }
    items.push({ id: opts.makeId(), key, value, full, links: links.length ? links : undefined, scope, tags, createdAt, updatedAt, source })
    created = true
  }
  return { created, mergedKey, ...(clashKey !== undefined ? { clashKey, clashSim } : {}) }
}
