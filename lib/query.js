/**
 * 查询提取与候选挑选（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * 这些函数原本闭包在 apply() 作用域上，实测只有 pickRecallCandidates 真的读闭包状态
 * （scoreEnv()），其余都是纯函数。故：纯函数原样搬出；pickRecallCandidates 参数化——
 * 新增 env: () => ScoreEnv 形参，函数内保持 rrfRanking(items, query, env()) 的调用形态，
 * 调用点传 scoreEnv 本身（不预先求值）：env() 的求值点与拆分前 rrfRanking(..., scoreEnv())
 * 的参数求值位置逐字对应（红队 P2 收口）。
 */
import { lexicalHit, rrfRanking, semanticOverlap } from './recall.js';
// ── 自动召回：把相关/最近记忆注入到每轮请求前 ─────────────────────────
// v0.1.4：只读文本、跳过插件注入消息、向后取最多 2 条用户文本消息（上下文延续如
// "又报错了"能带上文关键词）；同时标记本轮是否含图片块 —— 图片内容无法参与
// 字面召回，发图提问时召回意义为零（画像兜底也跳过），避免"看图问问题"惨遭画像刷屏。
export function extractQuery(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return { query: '', hasImage: false };
    let hasImage = false;
    const texts = [];
    for (let i = messages.length - 1; i >= 0 && texts.length < 2; i--) {
        const msg = messages[i];
        if (!msg || !Array.isArray(msg.content))
            continue;
        // 跳过插件注入消息（自动守则/召回/教训），避免其文本污染查询信号
        if (msg.source?.kind === 'plugin')
            continue;
        const blocks = msg.content;
        if (blocks.some((b) => b?.type === 'image' || b?.type === 'image_url'))
            hasImage = true;
        const t = blocks
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join(' ')
            .trim();
        if (t)
            texts.push(t);
    }
    return { query: texts.join(' ').slice(0, 200), hasImage };
}
// 规则/教训通道：识别"又犯同样错"的悔恨信号与"路径/终端/命令"类场景信号。
// 这两类信号触发时，强制召回 rule.*/教训/坑/修复类记忆（不受 autoRecallOnce 限制）。
export function regretSignal(query) {
    const q = query.toLowerCase();
    const regret = ['又', '还是', '再次', '仍然', '依然', '老是', '一直', '经常', 'again'];
    const error = ['错', '失败', '报错', '不对', '不行', '崩', '挂', '回退', '问题', '错误', '没', '失败啦'];
    return regret.some((r) => q.includes(r)) && error.some((e) => q.includes(e));
}
export function ruleScene(query) {
    const q = query.toLowerCase();
    const scene = ['路径', 'path', '盘', '目录', 'folder', '文件位置', '放哪', '移动', '拷贝', '复制',
        'powershell', 'pwsh', '终端', '命令', '脚本', '字符', '编码', '引号', 'c盘', 'd盘', 'e盘', 'windows'];
    return scene.some((s) => q.includes(s));
}
// 教训/规则记忆的判定：key 前缀 rule. 或 value/tags 含强信号
export function isLessonLike(item) {
    const key = item.key.toLowerCase();
    const blob = `${item.key} ${item.value} ${item.tags.join(' ')}`.toLowerCase();
    if (key.startsWith('rule.') || key.startsWith('convention.') || key.startsWith('lesson.'))
        return true;
    return ['教训', '坑', '切记', '勿', '不要', '禁止', '约定', 'lesson', 'pitfall', 'fixed', 'repair', 'fix']
        .some((w) => blob.includes(w));
}
// 教训通道的轻量词法命中：与 scoreItem 同源的噪声/弱词规则，但去掉工作区加分与
// 同义词扩展——只回答「这条记忆里是否真的出现了 query 的词」。
export function pickLessonItems(items, query, isRegret, isRule, limit) {
    const candidates = items.filter((item) => isLessonLike(item));
    if (candidates.length === 0)
        return [];
    const scored = candidates.map((item) => {
        const blob = `${item.key} ${item.value} ${item.tags.join(' ')}`.toLowerCase();
        let bonus = 0;
        if (isRule && (blob.includes('路径') || blob.includes('path') || blob.includes('盘')
            || blob.includes('powershell') || blob.includes('pwsh') || blob.includes('终端') || blob.includes('命令')))
            bonus += 10;
        if (isRegret)
            bonus += 6;
        // 相关性门槛：悔恨/场景信号只决定「要不要看教训」，不决定「看哪一条」。
        // 只有真的与当前 query 沾边（共享中文二元组/英文词元，或词法命中）才准入——
        // 否则库里 lesson 类条目少时会把无关规则一并塞进来，还顶掉本该出现的索引兜底。
        const overlap = semanticOverlap(query, `${item.key} ${item.value}`);
        const lexHit = lexicalHit(item, query);
        return { item, bonus, relevance: overlap * 2 + (lexHit ? 3 : 0), hit: overlap >= 1 || lexHit };
    });
    const relevant = scored.filter((entry) => entry.hit);
    relevant.sort((a, b) => (b.bonus + b.relevance - (a.bonus + a.relevance)) || b.item.updatedAt.localeCompare(a.item.updatedAt));
    return relevant.slice(0, limit).map((entry) => entry.item);
}
// 重排候选池（v0.1.9）：RRF 双排名取 top max——词法零命中但语义相关的条目也能进 LLM 重排视野
export function pickRecallCandidates(items, query, max, env) {
    if (!query)
        return [];
    const ranked = rrfRanking(items, query, env()).filter((e) => e.rrf >= 0.025);
    return ranked.slice(0, max).map((e) => e.item);
}
//# sourceMappingURL=query.js.map