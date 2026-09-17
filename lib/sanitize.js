// ⑤ 记忆投毒防护：召回注入前清洗 value（控制字符 / 非 http URI scheme / 提示注入模式）
/**
 * S4-b：中和 memory-data 结构定界符。
 * render 侧用 <memory-data trust="untrusted" …>…</memory-data> 包裹不可信数据；value 里若带
 * </memory-data>（或 <memory-data）就能提前闭合包裹标签、伪造 trust 属性，把结构防护降级成摆设。
 * 这里把定界符的 "<" 实体化为 &lt;，使其在渲染结果里只剩文本语义。
 */
export function neutralizeMemoryDataDelimiters(text) {
    return text.replace(/<(\s*\/?\s*memory-data)/gi, '&lt;$1');
}
/**
 * S4-b：转义 XML 属性值（key/scope 会拼进 <memory-data … key="…"> 的属性位置）。
 * render 侧拼属性前必须调用：引号/尖括号/& 一律实体化，属性无法被提前闭合或注入新属性。
 * （index.ts 由主线程接线，接线点见交付报告。）
 */
export function escapeMemoryAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
// S4-a（收紧中文投毒规则）：宾语是「规则/设定」时必须有 的/所有/以上/之前… 这类限定词。
// 修复前 /(忽略|无视|忘掉|忘记|不要理会)[^。；\n]{0,12}(指令|指示|规则|设定)/g 会把
// 「eslint-disable 忽略规则」「CI 里忽略规则 X」这类合法语形整段替换成过滤串（误伤回归）。
// 现在分两条：「指令/指示」本身就是指令宾语，保持原宽匹配；「规则/设定」要求前面有限定词，
// 才判为「忽略…的规则」式投毒（投毒变体 忘掉所有规则 / 不要理会上面的设定 仍全部命中）。
const ZH_IGNORE_VERB = '(忽略|无视|忘掉|忘记|不要理会)';
const ZH_QUALIFIER = '(的|所有|全部|以上|之前|前面|前述|上述|上面|这些|那些|任何)';
const ZH_IGNORE_DIRECTIVE_RE = new RegExp(`${ZH_IGNORE_VERB}[^。；\n]{0,12}(指令|指示)`, 'g');
const ZH_IGNORE_RULE_RE = new RegExp(`${ZH_IGNORE_VERB}[^。；\n]{0,12}${ZH_QUALIFIER}(规则|设定)`, 'g');
export function sanitizeValue(value) {
    let v = value;
    // C4 补强：NFKC 归一 + 移除零宽字符（零宽插入是已知绕过路径）
    v = v.normalize('NFKC');
    v = v.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    v = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // S4-b：先中和结构定界符（放在零宽移除之后，避免 </memory\u200B-data> 绕过）
    v = neutralizeMemoryDataDelimiters(v);
    // 中和非 http(s) 的 xxx:// scheme（viking://、file://、javascript: 等投毒向量），不影响 E:/ 路径
    v = v.replace(/\b(?!https?:)([a-z][a-z0-9+.\-]{2,}):\/\//gi, (m) => m.replace(':', '\u02d0'));
    // 中和无 // 的危险 scheme：javascript:、data:、vbscript: 等（旧正则只覆盖 xxx:// 形式）
    // n1：仅在 URI 形态（冒号后紧跟非空白字符）时中和，避免误伤「data: 3 条记录」这类普通文本
    v = v.replace(/\b(?:javascript|vbscript|data|file|blob):(?=[^\s])/gi, (m) => m.replace(':', '\u02d0'));
    // C4 补强：中文"忽略/无视/忘掉…指令/规则"变体（S4-a 起「规则/设定」需限定词）
    v = v.replace(ZH_IGNORE_DIRECTIVE_RE, '[已过滤可疑指令文本]');
    v = v.replace(ZH_IGNORE_RULE_RE, '[已过滤可疑指令文本]');
    // C4 补强：英文 you are now / [INST] / <|system|>
    v = v.replace(/(you\s+are\s+now|from\s+now\s+on\s+you|<\|?system\|?>|\[INST\])/gi, '[已过滤可疑指令文本]');
    // 打断疑似提示注入指令
    v = v.replace(/(ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|忽略(之前|以上|前面)(的)?(所有)?指令|system\s*prompt\s*:|disregard\s+(all\s+)?(previous|prior)\s+.*?instructions?)/gi, '[已过滤可疑指令文本]');
    return v;
}
//# sourceMappingURL=sanitize.js.map