/**
 * 插件身份常量（第 2 批拆分引入）。
 *
 * 原先只有 index.ts 的 `export const name`；而 isOwnInjected（判定会话历史里是否已有本插件
 * 注入的同 form 消息）与 pre-step 的 source.plugin 写入也要用它。把 name 留在 index.ts 会让
 * 新模块引用它时形成「新模块 ← index.ts ← 新模块」的循环导入，故提到最底层模块。
 */
export const PLUGIN_NAME = '@dsh-external/dsh-persistent-memory';
//# sourceMappingURL=const.js.map