import { KEY_PREFIX_WHITELIST, KEY_PREFIX_LIST } from './types.js'
import type { MemoryItem } from './types.js'
import { contentSimilarity, keySimilarity } from './recall.js'

/** scope 归一：未传/空白回退 defaultScope，仅 trim（大小写归一见 M8） */
export function normalizeScope(scope: string | undefined, defaultScope: string): string {
  const s = (scope || defaultScope).trim()
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
 * 凭据检测（与守则同源）：返回需要拒绝的明文凭据原因；
 * 无命中返回 null。token/secret 类弱信号由调用方自行决定警告。
 */
export function detectCredentials(body: string): string | null {
  if (/password|passwd|密码|口令|密钥/i.test(body)) {
    return 'memory_set: 检测到疑似明文密码/密钥。凭据类记忆请用 auth.* 前缀（用户授权保留）；其他前缀一律只记指针（去哪查），不记明文。'
  }
  return null
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

/** token/secret/api_key 弱信号检测（当前仅警告；M2 将升级为拒绝） */
export function hasWeakCredentialSignal(body: string): boolean {
  return /token|secret|api[_-]?key/i.test(body)
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
