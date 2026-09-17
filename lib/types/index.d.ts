import type { Context } from 'cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-persistent-memory";
export declare const inject: string[];
export interface Config {
    /** 记忆库目录；缺省为 $DSH_HOME/dsh-persistent-memory */
    dataDir?: string;
    /** 未显式传 scope 时使用的默认作用域 */
    defaultScope?: string;
    /** search/stats 返回条数上限 */
    maxResults?: number;
    /** 是否在每轮请求前自动召回并注入记忆 */
    autoRecall?: boolean;
    /** 自动召回最多注入条数 */
    autoRecallLimit?: number;
    /** 自动召回每条 value 最大展示字符数 */
    autoRecallMaxChars?: number;
    /** 单次召回注入的字符预算（默认 600）：超出按分数顺序截断，防止一次塞太多 */
    autoRecallBudgetChars?: number;
    /** 非首轮召回的绝对分数下限（默认 3；v0.1.17 前为 1，过松导致无关记忆被注入） */
    autoRecallMinScore?: number;
    /** 相对阈值（默认 0.5）：低于最高分该比例的记忆不注入；0 表示禁用 */
    autoRecallRelativeFloor?: number;
    /** 自动召回限定作用域；空串表示不限定 */
    autoRecallScope?: string;
    /** 没有相关匹配时是否回退注入最近记忆（默认 false，避免无关上下文污染） */
    autoRecallFallback?: boolean;
    /** 是否注入“自动记忆守则”，让模型自己发现并总结值得记住的信息 */
    autoCapture?: boolean;
    /** 守则详略：brief（默认，约 210 字）| full（完整九类细则，约 3000 字） */
    autoCaptureDetail?: 'brief' | 'full';
    /** 单轮全部自动注入（守则+教训+召回+索引）的会话级字符总预算（默认 1200） */
    injectionBudgetChars?: number;
    /** 每个会话只自动注入一次记忆；冷却期内不重复注入（默认 true） */
    autoRecallOnce?: boolean;
    /** 自动注入冷却毫秒数；同一会话在该窗口内不重复注入（默认 10 分钟） */
    autoRecallCooldownMs?: number;
    /** 启用同义词扩展评分（代理↔梯子↔vpn、认证↔登录↔凭据等，默认 true） */
    synonymExpansion?: boolean;
    /** memory_set 时对同 scope 高相似 key 自动合并更新，避免记忆库膨胀（默认 true） */
    dedupeOnSet?: boolean;
    /** 启用 LLM 语义重排：词法预筛候选 → LLM 选 3~5 条（对标 Claude Code findRelevantMemories） */
    autoRecallRerank?: boolean;
    /** 语义重排时 LLM 可选的记忆条数上限 */
    autoRecallRerankMax?: number;
    /** 写入 RRF 混合召回（词法+中文二元组双排名融合），词法 0 命中时按语义补位（默认 true） */
    rrfRecall?: boolean;
    /** RRF 语义补位是否只在首轮生效（默认 true）：非首轮词法被阈值过滤 = 整体不相关，宁可不注入 */
    rrfFirstTurnOnly?: boolean;
    /** 写入前需用户确认：开启后 memory_set 必须带 confirmed=true 才落盘（默认 false） */
    approveOnSet?: boolean;
    /** value 摘要存储上限（默认 240）：超长自动句边界截断，完整原文归档进 full，不拒绝写入 */
    valueMaxChars?: number;
    /** full 完整正文总长上限（默认 8000）：超出截断，避免同一 key 反复更新导致无限膨胀 */
    fullMaxChars?: number;
    /** task.* 保鲜期（天，默认 30）：超期在召回评分中降权，避免过时任务状态被当成现状 */
    taskTtlDays?: number;
    /** 轮末自动提取（默认 true）：每轮结束后异步回顾对话、沉淀高置信记忆，不依赖主模型当轮意愿 */
    autoExtract?: boolean;
    /** memory_import 允许的根目录白名单；缺省为 [DSH_WORKSPACE]（无环境变量时拒绝导入） */
    importAllowRoots?: string[];
    /** 自动提取冷却毫秒数（默认 120 秒）：同一会话该窗口内不重复提取 */
    autoExtractCooldownMs?: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    dataDir: z<string, string>;
    defaultScope: z<string, string>;
    maxResults: z<number, number>;
    autoRecall: z<boolean, boolean>;
    autoRecallLimit: z<number, number>;
    autoRecallMaxChars: z<number, number>;
    autoRecallBudgetChars: z<number, number>;
    autoRecallMinScore: z<number, number>;
    autoRecallRelativeFloor: z<number, number>;
    autoRecallScope: z<string, string>;
    autoRecallFallback: z<boolean, boolean>;
    autoCapture: z<boolean, boolean>;
    autoCaptureDetail: z<string, string>;
    autoRecallOnce: z<boolean, boolean>;
    autoRecallCooldownMs: z<number, number>;
    synonymExpansion: z<boolean, boolean>;
    dedupeOnSet: z<boolean, boolean>;
    autoRecallRerank: z<boolean, boolean>;
    autoRecallRerankMax: z<number, number>;
    rrfRecall: z<boolean, boolean>;
    rrfFirstTurnOnly: z<boolean, boolean>;
    approveOnSet: z<boolean, boolean>;
    valueMaxChars: z<number, number>;
    fullMaxChars: z<number, number>;
    taskTtlDays: z<number, number>;
    autoExtract: z<boolean, boolean>;
    autoExtractCooldownMs: z<number, number>;
    injectionBudgetChars: z<number, number>;
    importAllowRoots: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    dataDir: z<string, string>;
    defaultScope: z<string, string>;
    maxResults: z<number, number>;
    autoRecall: z<boolean, boolean>;
    autoRecallLimit: z<number, number>;
    autoRecallMaxChars: z<number, number>;
    autoRecallBudgetChars: z<number, number>;
    autoRecallMinScore: z<number, number>;
    autoRecallRelativeFloor: z<number, number>;
    autoRecallScope: z<string, string>;
    autoRecallFallback: z<boolean, boolean>;
    autoCapture: z<boolean, boolean>;
    autoCaptureDetail: z<string, string>;
    autoRecallOnce: z<boolean, boolean>;
    autoRecallCooldownMs: z<number, number>;
    synonymExpansion: z<boolean, boolean>;
    dedupeOnSet: z<boolean, boolean>;
    autoRecallRerank: z<boolean, boolean>;
    autoRecallRerankMax: z<number, number>;
    rrfRecall: z<boolean, boolean>;
    rrfFirstTurnOnly: z<boolean, boolean>;
    approveOnSet: z<boolean, boolean>;
    valueMaxChars: z<number, number>;
    fullMaxChars: z<number, number>;
    taskTtlDays: z<number, number>;
    autoExtract: z<boolean, boolean>;
    autoExtractCooldownMs: z<number, number>;
    injectionBudgetChars: z<number, number>;
    importAllowRoots: z<string[], string[]>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
