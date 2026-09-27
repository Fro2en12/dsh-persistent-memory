/**
 * 插件身份常量（第 2 批拆分引入）。
 *
 * 原先只有 index.ts 的 `export const name`；而 isOwnInjected（判定会话历史里是否已有本插件
 * 注入的同 form 消息）与注入消息的 source 写入也要用它。把 name 留在 index.ts 会让
 * 新模块引用它时形成「新模块 ← index.ts ← 新模块」的循环导入，故提到最底层模块。
 *
 * v0.1.32：注入消息的 source 改用 DSH 会话格式 v4 的 producer kind（`plugin:<插件名>`）。
 * v3 的 `{ kind: 'plugin', plugin }` 包装被 v4 拒绝（SessionFormatError: format v4 message
 * requires a producer-owned source kind），而 v3→v4 迁移边对第三方插件产出的正是
 * `plugin:<完整插件名>`——写同一个值，新旧会话共用一种形状，去重判定不分裂。
 */
export declare const PLUGIN_NAME = "@dsh-external/dsh-persistent-memory";
/** 本插件在会话日志里的 source kind（v4 producer kind；与 v3→v4 迁移边的产出逐字一致）。 */
export declare const PLUGIN_SOURCE_KIND = "plugin:@dsh-external/dsh-persistent-memory";
/**
 * 判定一段 message.source.kind 是否属于「插件注入」。两种形状都认：
 * v4（含 v3→v4 迁移后的产出）为 `plugin:<插件名>`，v3 遗留（热重载的旧内存态）为裸 `'plugin'`。
 * @param kind - 消息 source 的 kind 字段，形状未知。
 * @returns 属于插件注入消息时为 true。
 */
export declare function isPluginInjectedKind(kind: unknown): boolean;
/**
 * 判定该 source 是否由本插件注入：新形状直配 kind，旧形状再比对 plugin 字段。
 * @param source - 消息的 source 记录，允许缺省或形状未知。
 * @returns 是本插件注入的 source 时为 true。
 */
export declare function isOwnSource(source: {
    kind?: unknown;
    plugin?: unknown;
} | undefined | null): boolean;
