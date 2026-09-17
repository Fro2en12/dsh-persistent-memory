// 共享类型与分类白名单：守则文本 / 错误消息同源，防止提示词与实现漂移
/** key 前缀白名单（memory_set 硬校验的唯一真相） */
export const KEY_PREFIX_WHITELIST: readonly string[] = ['user', 'rule', 'task', 'ref', 'env', 'project', 'tool', 'auth', 'lesson', 'plugin']
/** 前缀清单展示串：守则文本与错误消息共用 */
export const KEY_PREFIX_LIST = KEY_PREFIX_WHITELIST.join('/')

export interface MemoryItem {
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
