// ⑤ 记忆投毒防护：召回注入前清洗 value（控制字符 / 非 http URI scheme / 提示注入模式）
export function sanitizeValue(value: string): string {
  let v = value
  // C4 补强：NFKC 归一 + 移除零宽字符（零宽插入是已知绕过路径）
  v = v.normalize('NFKC')
  v = v.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  v = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  // 中和非 http(s) 的 xxx:// scheme（viking://、file://、javascript: 等投毒向量），不影响 E:/ 路径
  v = v.replace(/\b(?!https?:)([a-z][a-z0-9+.\-]{2,}):\/\//gi, (m) => m.replace(':', '\u02d0'))
  // 中和无 // 的危险 scheme：javascript:、data:、vbscript: 等（旧正则只覆盖 xxx:// 形式）
  // n1：仅在 URI 形态（冒号后紧跟非空白字符）时中和，避免误伤「data: 3 条记录」这类普通文本
  v = v.replace(/\b(?:javascript|vbscript|data|file|blob):(?=[^\s])/gi, (m) => m.replace(':', '\u02d0'))
  // C4 补强：中文"忽略/无视/忘掉…指令"变体 + 英文 you are now / [INST] / <|system|>
  v = v.replace(/(忽略|无视|忘掉|忘记|不要理会)[^。；\n]{0,12}(指令|指示|规则|设定)/g, '[已过滤可疑指令文本]')
  v = v.replace(/(you\s+are\s+now|from\s+now\s+on\s+you|<\|?system\|?>|\[INST\])/gi, '[已过滤可疑指令文本]')
  // 打断疑似提示注入指令
  v = v.replace(
    /(ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|忽略(之前|以上|前面)(的)?(所有)?指令|system\s*prompt\s*:|disregard\s+(all\s+)?(previous|prior)\s+.*?instructions?)/gi,
    '[已过滤可疑指令文本]',
  )
  return v
}
