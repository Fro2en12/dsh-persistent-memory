/**
 * 写侧共享实现（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * memory_set 工具与 /memory remember 命令共用同一套校验与写入路径：审批门（用户亲自输入
 * 豁免）、子代理隔离、前缀白名单、tags ≤3、凭据闸门、value 截断归档、冲突重试；
 * memory_import 工具与 /memory import 命令共用 importFileToStore；memory_dream 用 oneLineSummary。
 *
 * 依赖形态：createWriteOps(deps) 在 apply() 内构造一次，返回的函数实例被 tools / commands
 * 两个模块共用（避免 tools ↔ commands 循环导入）。所有状态仍来自同一份 deps。
 */
import { promises as fs } from 'node:fs';
import { basename, sep } from 'node:path';
import { sanitizeValue } from './sanitize.js';
import { contentSimilarity, truncate } from './recall.js';
import { findCredentialMatch, normalizeScope, upsertMemory, validateKeyPrefix } from './write-gate.js';
import { parseImportEntries } from './import.js';
import { withConflictRetry } from './store.js';
// m2：完成态判定锚定状态语义——修复前 /done|completed|已完成|完成/ 会把
// 「任务完成后运行测试」这类含"完成"二字的规则误判为「标记完成」而列入候选。
export const isCompletedMark = (value) => 
// 注意：中文后不能用 \b（'已完成' 的 '成' 不是 \w，边界不成立）
/^(已完成|done|completed)(?![\w\u4e00-\u9fff])|\bstatus\s*[:=]\s*(done|completed)/i.test(value.trim());
// M12 归档摘要：value 压成一行（换行→空格）且 ≤80 字。value 只承担检索展示，
// 原文进 full 不丢信息——归档是「缩小检索面」，不是删除。
export const ARCHIVE_SUMMARY_MAX = 80;
// ── 记忆导入（v0.1.9）：CLAUDE.md / MEMORY.md / memories.json 一键入库 ──
// ── 导入守卫（C3 + M6，v0.1.23）────────────────────────────────────
// C3：根目录白名单 + realpath 前缀判断（防 symlink 逃逸）+ 拒绝 \\?\/UNC/设备路径。
// M6：2MB 大小上限；每条过增强版凭据闸门（命中整条丢弃）；full 施加 valueMaxChars 截断；
// 默认 scope 改当前工作区而非 global。
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export function createWriteOps(deps) {
    const { defaultScope, approveOnSet, dedupeOnSet, valueMaxChars, fullMaxChars, maxItems, runtime, readItems, writeItems, withLock, lastManualWriteAt, makeId, normalizeTags, setBounded, isSubagentAgent, importAllowRoots, } = deps;
    async function commitMemory(input, exec) {
        const key = String(input.key || '').trim();
        if (!key)
            throw new Error('memory_set: key 不能为空');
        // 审批门（v0.1.9，approveOnSet=true 时生效）：未经用户确认的写入拒绝，确认后带 confirmed: true 重试
        if (runtime.approveOnSet && input.confirmed !== true && !input.fromUser) {
            throw new Error('memory_set: 已开启写入审批（approveOnSet）。请先向用户确认是否记录这条记忆（直接询问或 ask_user_question），用户同意后带 confirmed: true 重试本次写入。');
        }
        const scope = normalizeScope(input.scope, defaultScope);
        // 硬层隔离（v0.1.6）：子代理禁止写 global 记忆（软层只读守则 + 此处拒绝双保险）。
        // fromUser（/memory remember）豁免：用户亲自输入不可能是子代理，且 fail-closed 探测
        // 在无 agent 信息的命令路径上会一律判为子代理，不能因此挡住人。
        if (!input.fromUser && isSubagentAgent(exec?.agent) && scope === 'global') {
            const subId = String(exec?.agent?.session?.id ?? 'unknown');
            throw new Error(`memory_set: 子代理会话禁止写入 global 记忆；确需落地请用 scope=sub:${subId}，成果建议以结果报告回传父会话由父会话沉淀`);
        }
        // F7（第七轮）：undefined = 不改动，[] = 清空。必须在 normalizeTags 之前区分——
        // normalizeTags 对非数组一律返回 []，会把「没传」吞成「清空」。
        const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
        const links = input.links === undefined ? undefined : normalizeTags(input.links);
        // ── value 摘要（v0.1.15 宽容写入）─────────────────────────────────
        // 超限不拒绝：句边界截断为摘要（末尾 … 表截断），完整原文归档进 full —— 写失败=丢信息，比超长更糟。
        let value = String(input.value || '').trim();
        let full = input.full !== undefined ? (String(input.full).trim() || undefined) : undefined;
        const warnings = [];
        const nowStamp = new Date().toISOString();
        // P1-1（复审收口）：超长 value 的「置顶归档」决策必须推迟到锁内读到 prev 之后。
        // 修复前在这里无条件执行 full = stamped(rawValue, nowStamp)：nowStamp 每次调用都是新的，
        // 于是 prev.full !== nextFull 恒成立 ⇒ T17 空操作防护在 value > valueMaxChars 的条目上
        // 永不触发（updatedAt 被反复刷新、每次重申整库重写），且未显式传 full 时会用新戳覆盖掉
        // 上一次归档的正文。此处只记录「本次被截断的原文」，赋值见锁内。
        const overLongRaw = value.length > valueMaxChars ? value : undefined;
        if (overLongRaw !== undefined) {
            value = truncate(overLongRaw, valueMaxChars);
            warnings.push(`value 摘要 ${overLongRaw.length} 字超过 ${valueMaxChars} 字上限，已截断为摘要（结尾 …），完整原文已归档到 full（memory_get includeFull 可取回）`);
        }
        if (full !== undefined && full.length > fullMaxChars) {
            full = full.slice(0, fullMaxChars);
            warnings.push(`full 超过 ${fullMaxChars} 字上限，已截断`);
        }
        // ── 写侧闸门（v0.1.7）：实测闸门；文案与守则同源（KEY_PREFIX_LIST 见 types.ts / write-gate.ts）──
        validateKeyPrefix(key, scope);
        const prefix = key.split('.')[0];
        if ((tags?.length ?? 0) > 3) {
            throw new Error(`memory_set: tags 最多 3 个（当前 ${tags?.length ?? 0} 个）。请收敛到最能代表内容的 1-3 个标签。`);
        }
        if (prefix !== 'auth') {
            // M2：凭据正则升级为拒绝（token/secret/api key/bearer/sk-/ghp_/AKIA/PRIVATE KEY/中文口令），
            // 与提取器、导入闸门共用同一份 CREDENTIAL_RE，防止实现漂移。
            const body = `${input.value}\n${input.full ?? ''}`;
            if (findCredentialMatch(body)) {
                throw new Error('memory_set: 检测到疑似明文凭据（token/secret/api key/密钥等）。凭据类记忆请用 auth.* 前缀（用户授权保留）；其他前缀一律只记指针（去哪查），不记明文。');
            }
        }
        if (prefix === 'task' && !/\d{4}-\d{2}-\d{2}/.test(String(input.value))) {
            warnings.push('task.* 建议在 value 中写明绝对日期（如 2026-09-03），相对时间会过期失真');
        }
        const now = nowStamp;
        // 来源引证（v0.1.9）：默认自动填 日期+会话前缀；显式 source 参数优先
        const sessionId = String(exec?.agent?.session?.id ?? '');
        const source = (input.source || '').trim() || `${now.slice(0, 10)}${sessionId ? ` s=${sessionId.slice(0, 8)}` : ''}`;
        const outcome = await withLock(() => withConflictRetry(async () => {
            const items = await readItems();
            // P1-1：只有在这里才拿得到 prev.full —— 据此决定 full 是「原样保留」还是「置顶新原文」。
            let fullForWrite = full;
            if (overLongRaw !== undefined) {
                const prevItem = items.find((item) => item.scope === scope && item.key === key);
                const stamped = `<!-- ${nowStamp} -->\n${overLongRaw}`;
                // m9 的意图是「最新原文置顶、历史内容保留在尾部」，受 fullMaxChars 约束（修复前尾部追加会单调膨胀）。
                // 旧 full 里已经有这次原文 ⇒ 同一内容被重申，原样保留：这正是空操作判定能成立的前提。
                if (full !== undefined)
                    fullForWrite = `${stamped}\n\n${full}`.slice(0, fullMaxChars);
                else if (prevItem?.full?.includes(overLongRaw))
                    fullForWrite = prevItem.full;
                else
                    fullForWrite = (prevItem?.full ? `${stamped}\n\n${prevItem.full}` : stamped).slice(0, fullMaxChars);
            }
            // ④ 去重合并 / 冲突检测 / push 新建：逻辑见 write-gate.ts 的 upsertMemory
            const result = upsertMemory(items, {
                key,
                value,
                full: fullForWrite,
                links,
                tags,
                scope,
                createdAt: now,
                updatedAt: now,
                source,
                explicitSource: Boolean((input.source || '').trim()),
            }, { dedupe: dedupeOnSet, makeId });
            // M12 容量守卫：只挡「新增」。items 是 readItems() 的副本，此处直接抛错即可——
            // writeItems 尚未执行，本次 push 不会落盘（withConflictRetry 只对 StoreConflictError 重试，
            // 业务错误一律立即上抛，因此不会出现「超限被重试后写进去」的窗口）。
            if (result.created && items.length > maxItems) {
                items.pop();
                throw new Error(`memory_set: 记忆库已达上限（${items.length}/${maxItems} 条），本次新增被拒绝。请先跑 memory_dream（apply: true 可归档超 90 天条目）或 memory_forget / 合并旧条目腾出空间；更新已有条目不受上限限制。`);
            }
            // 冲突警告在回调内重算但不就地 push（withConflictRetry 重试会重复累加）
            const clashWarning = result.clashKey !== undefined && result.clashSim !== undefined
                ? `与已有条目 ${scope}/${result.clashKey} 内容高度相似（${Math.round(result.clashSim * 100)}%）：请确认是否应更新该条（memory_set 同 key）而非新建`
                : '';
            // T17（第六轮）：空操作（内容与旧值全等）跳过整次落盘——省掉抢锁与写盘，
            // 且 updatedAt 未被刷新，不会污染召回排序与 memory_dream 的过期判定。
            if (result.changed)
                await writeItems(items);
            return { result, clashWarning };
        }));
        // Claude Code 的 hasMemoryWritesSince 计的是「真的写了一条记忆」：空操作（内容全等、
        // 未落盘、未刷新 updatedAt）不该算主模型写过——否则反复重申旧记忆会一直压住轮末提取器，
        // 而实际上什么都没记。与提取侧的 `written = result.changed` 同口径。
        if (sessionId && outcome.result.changed)
            setBounded(lastManualWriteAt, sessionId, Date.now());
        const allWarnings = outcome.clashWarning ? [...warnings, outcome.clashWarning] : warnings;
        return {
            ok: true,
            key,
            scope,
            created: outcome.result.created,
            changed: outcome.result.changed,
            mergedKey: outcome.result.mergedKey,
            updatedAt: outcome.result.updatedAt,
            ...(allWarnings.length ? { warnings: allWarnings } : {}),
        };
    }
    // 上限按「取回时的形态」收敛：memory_get / 面板都会先过 sanitizeValue，其 NFKC 归一
    // 会把 '…'(U+2026) 展成 '...'（1→3 字符）。若按 raw 长度卡 80，取回后实测是 82，
    // 违反「value ≤80 字」的承诺——所以这里用清洗后的长度做判据。
    function oneLineSummary(value) {
        const oneLine = value.replace(/\s+/g, ' ').trim();
        let cut = Math.min(oneLine.length, ARCHIVE_SUMMARY_MAX);
        while (cut > 0) {
            const candidate = oneLine.length <= ARCHIVE_SUMMARY_MAX ? oneLine : oneLine.slice(0, cut) + '…';
            if (sanitizeValue(candidate).length <= ARCHIVE_SUMMARY_MAX)
                return candidate;
            cut--;
        }
        return oneLine.slice(0, ARCHIVE_SUMMARY_MAX);
    }
    const defaultImportScope = () => {
        for (const envName of ['DSH_WORKSPACE_NAME', 'DSH_WORKSPACE', 'DSH_SESSION_WORKSPACE']) {
            const v = process.env[envName];
            if (v && v.trim())
                return v.trim();
        }
        try {
            const b = basename(process.cwd());
            if (b)
                return b;
        }
        catch { /* ignore */ }
        return defaultScope;
    };
    async function importFileToStore(filePath, scope, guard) {
        // S1（对抗性复核，v0.1.24）：越权写 global 的硬闸门，与 memory_set 同款。写入只在这一处。
        // T7（第五轮收口）：**移除**「没有 exec 即视为用户操作」的隐式放行——豁免只认显式 fromUser
        // （/memory import 命令，用户亲自输入）。既非 fromUser 又拿不到 exec 的调用无法证明身份，
        // 按 fail-closed 拒绝（此前该形状会静默放行 global 写入，是已知攻击面）。
        // 真实工具调用必带 exec（dsh-tools 的 tool.execute(args, exec)），命令路径显式传 fromUser。
        if (guard?.fromUser !== true) {
            if (guard?.exec === undefined) {
                throw new Error('memory_import: 无法确认调用方身份（缺少 exec 且未标记为用户亲自输入），拒绝导入；工具调用请携带 exec，命令路径请传 fromUser');
            }
            if (scope === 'global' && isSubagentAgent(guard.exec.agent)) {
                const subId = String(guard?.exec?.agent?.session?.id ?? 'unknown');
                throw new Error(`memory_import: 子代理会话禁止写入 global 记忆；确需落地请用 scope=sub:${subId}，成果建议以结果报告回传父会话由父会话沉淀`);
            }
        }
        if (/^\\\\/.test(filePath)) {
            throw new Error('memory_import: 拒绝 \\\\?\\、UNC 与设备路径');
        }
        // 第 2 批拆分：config.importAllowRoots 经 deps 的 getter 取得（调用时求值，时机不变）
        const configuredRoots = importAllowRoots();
        const allowRoots = configuredRoots?.length
            ? configuredRoots
            : [process.env.DSH_WORKSPACE].filter(Boolean);
        if (allowRoots.length === 0) {
            throw new Error('memory_import: 未配置 importAllowRoots 且环境无 DSH_WORKSPACE，拒绝导入（只允许导入工作区内的文件）');
        }
        let resolved;
        try {
            resolved = await fs.realpath(filePath);
        }
        catch {
            throw new Error(`memory_import: 无法读取 ${filePath}`);
        }
        let roots;
        try {
            roots = await Promise.all(allowRoots.map((r) => fs.realpath(r)));
        }
        catch (err) {
            throw new Error('memory_import: 导入根目录不可用：' + String(err instanceof Error ? err.message : err));
        }
        if (!roots.some((r) => resolved === r || resolved.startsWith(r + sep))) {
            throw new Error('memory_import: 只允许导入工作区内的文件');
        }
        const st = await fs.stat(resolved);
        if (st.size > MAX_IMPORT_BYTES) {
            throw new Error(`memory_import: 文件超过 ${MAX_IMPORT_BYTES} 字节上限`);
        }
        let raw;
        try {
            raw = await fs.readFile(resolved, 'utf8');
        }
        catch {
            throw new Error(`memory_import: 无法读取 ${filePath}`);
        }
        const entries = parseImportEntries(raw, filePath, { valueMaxChars });
        if (entries.length === 0)
            throw new Error(`memory_import: ${filePath} 没有可导入的内容`);
        return withLock(() => withConflictRetry(async () => {
            const items = await readItems();
            // m10：去重只与「库中既有条目」比较——同批次新导入的条目互相比相似度会把
            // slugKey 碰撞后追加 -2/-3 的独立条目再次判为重复（keySimilarity ≈0.86 ≥0.7）而静默丢弃
            const existing = items.slice();
            const now = new Date().toISOString();
            let imported = 0;
            let skipped = 0;
            let rejected = 0;
            for (const e of entries) {
                // M6：凭据闸门（与 M2 同源的增强正则）——命中整条丢弃
                if (findCredentialMatch(`${e.value}\n${e.full ?? ''}`)) {
                    rejected++;
                    continue;
                }
                // M6：full 施加 valueMaxChars 截断
                const full = e.full !== undefined && e.full.length > valueMaxChars ? truncate(e.full, valueMaxChars) : e.full;
                const dup = existing.some((item) => item.scope === scope
                    && contentSimilarity(item, { key: e.key, value: e.value, scope, tags: [], id: '', createdAt: now, updatedAt: now }) >= 0.7);
                if (dup) {
                    skipped++;
                    continue;
                }
                items.push({ id: makeId(), key: e.key, value: e.value, full, scope, tags: e.tags, createdAt: now, updatedAt: now, source: `import:${basename(filePath)}` });
                imported++;
            }
            await writeItems(items);
            const rejectedNote = rejected > 0 ? `，${rejected} 条命中凭据闸门被拒绝` : '';
            return { imported, skipped, rejected, summary: `导入完成：${imported} 条新增（${scope}），${skipped} 条与库中已有内容高度相似被跳过${rejectedNote}。` };
        }));
    }
    return { commitMemory, importFileToStore, oneLineSummary, defaultImportScope };
}
//# sourceMappingURL=write-ops.js.map