// ⑤ 记忆投毒防护：召回注入前清洗 value（控制字符 / 非 http URI scheme / 提示注入模式）
export function sanitizeValue(value: string): string {
  let v = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  // 中和非 http(s) 的 xxx:// scheme（viking://、file://、javascript: 等投毒向量），不影响 E:/ 路径
  v = v.replace(/\b(?!https?:)([a-z][a-z0-9+.\-]{2,}):\/\//gi, (m) => m.replace(':', '\u02d0'))
  // 中和无 // 的危险 scheme：javascript:、data:、vbscript: 等（旧正则只覆盖 xxx:// 形式）
  v = v.replace(/\b(?:javascript|vbscript|data|file|blob):/gi, (m) => m.replace(':', '\u02d0'))
  // 打断疑似提示注入指令
  v = v.replace(
    /(ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|忽略(之前|以上|前面)(的)?(所有)?指令|system\s*prompt\s*:|disregard\s+(all\s+)?(previous|prior)\s+.*?instructions?)/gi,
    '[已过滤可疑指令文本]',
  )
  return v
}
