/**
 * S4-b：中和 memory-data 结构定界符。
 * render 侧用 <memory-data trust="untrusted" …>…</memory-data> 包裹不可信数据；value 里若带
 * </memory-data>（或 <memory-data）就能提前闭合包裹标签、伪造 trust 属性，把结构防护降级成摆设。
 * 这里把定界符的 "<" 实体化为 &lt;，使其在渲染结果里只剩文本语义。
 */
export declare function neutralizeMemoryDataDelimiters(text: string): string;
/**
 * S4-b：转义 XML 属性值（key/scope 会拼进 <memory-data … key="…"> 的属性位置）。
 * render 侧拼属性前必须调用：引号/尖括号/& 一律实体化，属性无法被提前闭合或注入新属性。
 * （index.ts 由主线程接线，接线点见交付报告。）
 */
export declare function escapeMemoryAttr(value: string): string;
export declare function sanitizeValue(value: string): string;
