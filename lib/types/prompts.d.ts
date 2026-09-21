/** 完整记忆守则（第六轮起唯一版本：brief 版已删除）。说明见下方设计注释。 */
export declare function buildAutoCaptureText(valueMaxChars: number): string;
/** 子代理会话注入的只读守则（无插值）。 */
export declare const SUBAGENT_CAPTURE_TEXT: string;
export declare const EXTRACTION_SYSTEM_PROMPT: string;
/** LLM 语义重排提示（{{max}} 占位由调用方替换）。 */
export declare const RERANK_SYSTEM_PROMPT: string;
