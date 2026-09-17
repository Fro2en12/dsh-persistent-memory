// 共享类型与分类白名单：守则文本 / 错误消息同源，防止提示词与实现漂移
/** key 前缀白名单（memory_set 硬校验的唯一真相） */
export const KEY_PREFIX_WHITELIST = ['user', 'rule', 'task', 'ref', 'env', 'project', 'tool', 'auth', 'lesson', 'plugin'];
/** 前缀清单展示串：守则文本与错误消息共用 */
export const KEY_PREFIX_LIST = KEY_PREFIX_WHITELIST.join('/');
//# sourceMappingURL=types.js.map