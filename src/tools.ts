/**
 * 8 个记忆工具（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * memory_set / memory_get / memory_search / memory_forget / memory_stats / memory_dream /
 * memory_import / memory_recall。注册顺序、ctx.effect 包装与第二个参数的标签字符串逐字未变
 * （tests/minor-batch.spec.ts 断言 effect 名称，integration-smoke.spec.ts 断言 8 个工具名齐全）。
 *
 * 依赖形态：registerTools(ctx, deps, writeOps)；writeOps 与 commands 共用同一实例
 * （createWriteOps 在 apply() 内只构造一次）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryItem } from './types.js'
import { escapeMemoryAttr, neutralizeMemoryDataDelimiters, sanitizeValue } from './sanitize.js'
import { ageLabel } from './recall.js'
import { maskCredential, normalizeScope } from './write-gate.js'
import { withConflictRetry } from './store.js'
import type { MemoryDeps } from './deps.js'
import { ARCHIVE_SUMMARY_MAX, isCompletedMark, type WriteOps } from './write-ops.js'

export function registerTools(ctx: Context, deps: MemoryDeps, writeOps: WriteOps): void {
  const {
    defaultScope, approveOnSet, valueMaxChars, fullMaxChars,
    allowCredentialReveal, maxItems, store, readItems,
    writeItems, withLock, searchItems, isSubagentAgent,
    currentWorkspaceScopes, shouldMaskOutbound,
  } = deps

  // ── memory_set：写入/更新一条记忆 ──────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_set',
    description: '持久化写入一条记忆（用户偏好/项目事实/任务状态）。同 scope+key 会覆盖更新；长文用 full（仅 memory_get includeFull 返回），value 写自足摘要。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键，如 user.name / project.tech' },
      value: { type: 'string', required: true, description: '记忆摘要：召回/搜索只展示它' },
      full: { type: 'string', description: '可选完整正文：memory_get 传 includeFull 才返回，避免 token 膨胀' },
      links: { type: 'array', items: { type: 'string' }, description: '可选关联记忆 key（同 scope）：召回时展示关联提示；不传 = 保留旧值，传空数组 = 清空' },
      scope: { type: 'string', description: '作用域，默认 global；可按项目/工作区隔离' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签（最多 3 个）；不传 = 保留旧值，传空数组 = 清空' },
      confirmed: { type: 'boolean', description: '审批门：approveOnSet 开启时须为 true（先向用户确认过）' },
      source: { type: 'string', description: '可选来源引证（默认自动填 日期+会话）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          created: { type: 'boolean' },
          changed: { type: 'boolean' },
          mergedKey: { type: 'string' },
          updatedAt: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        // T17：区分「写入 / 更新 / 合并更新 / 空操作确认」——内容一字未改时报「已更新」会误导模型。
        // 空操作必须最先判：dedupe 合并到一条内容全等的旧条目时 mergedKey 非空，若先判 mergedKey
        // 就会报出「已合并更新」，而实际上 items 未改动、未落盘、updatedAt 还是旧值。
        let action: string
        if (!value.changed && !value.created) {
          action = value.mergedKey
            ? `记忆已确认：与 ${value.scope}/${value.mergedKey} 内容一致（未新建、未刷新更新时间）`
            : `记忆已确认：${value.scope}/${value.key}（内容与旧值一致，未刷新更新时间）`
        } else if (value.mergedKey) action = `记忆已合并更新：${value.scope}/${value.mergedKey}（与新 key "${value.key}" 高度相似，未新建条目）`
        else if (value.created) action = `记忆已写入：${value.scope}/${value.key}`
        else action = `记忆已更新：${value.scope}/${value.key}`
        return [{
          type: 'text',
          text: [
            `${action} @ ${value.updatedAt}`,
            ...(value.warnings?.length ? [`⚠️ ${value.warnings.join('；')}`] : []),
          ].join('\n'),
        }]
      },
    },
    async execute(args: { key: string; value: string; full?: string; links?: string[]; scope?: string; tags?: string[]; confirmed?: boolean; source?: string }, exec?: any) {
      return writeOps.commitMemory({
        key: args.key,
        value: args.value,
        full: args.full,
        links: args.links,
        scope: args.scope,
        tags: args.tags,
        confirmed: args.confirmed,
        source: args.source,
      }, exec)
    },
  })), '@dsh-external/dsh-persistent-memory: memory_set')

  // ── memory_get：按 key 读取 ───────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_get',
    description: '按 key（可带 scope）读取一条持久记忆；includeFull 获取长文完整内容。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键' },
      scope: { type: 'string', description: '作用域，默认 global' },
      includeFull: { type: 'boolean', description: '是否返回 full 完整正文（默认 false，只返回摘要 value）' },
      confirmed: { type: 'boolean', description: 'C7：凭据类记忆（auth.* 或含明文凭据）默认只回掩码，显式 confirmed:true 才返回原文（先向用户确认）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          value: { type: 'string' },
          full: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          links: { type: 'array', items: { type: 'string' } },
          source: { type: 'string' },
          updatedAt: { type: 'string' },
          masked: { type: 'boolean' },
          fullTruncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (!value.found) return [{ type: 'text', text: `未找到记忆：${escapeMemoryAttr(value.scope)}/${escapeMemoryAttr(value.key)}` }]
        // N2（第七轮收口）：进模型上下文的只有 render 的产物——DSH 的 tool/result 只取 result.content
        // （packages/core/agent-loop/src/tool-calls.ts:277-281），canonical value 到不了模型。
        // 修复前这里打印的是占位符「(已附完整正文)」，于是 README 承诺的 includeFull 取回路径对模型是断的；
        // links 更是 schema 与 render 双缺，模型读不回一条记忆的关联 key（却能用 [] 清空它）。
        const neutral = (s: unknown) => neutralizeMemoryDataDelimiters(String(s))
        const meta = [
          value.updatedAt ? `更新于 ${neutral(value.updatedAt)}` : '',
          value.source ? `来源 ${neutral(value.source)}` : '',
          value.tags?.length ? `标签 ${value.tags.map(neutral).join(', ')}` : '',
          value.links?.length ? `关联 ${value.links.map(neutral).join(', ')}` : '',
        ].filter(Boolean).join(' · ')
        // F4（复审）：render 自带防线，不把安全完全押在 execute 先清洗上——
        // value/full 在这里也过一次定界符中和（幂等：已中和过的串不再匹配）。
        const body = [
          `记忆 ${escapeMemoryAttr(value.scope)}/${escapeMemoryAttr(value.key)}：${neutral(value.value)}`,
          ...(meta ? [meta] : []),
          ...(value.masked ? ['（凭据已掩码：默认不返回原文，需部署者开启 allowCredentialReveal 且 confirmed:true）'] : []),
          ...(value.full ? ['--- 完整正文 ---', neutral(value.full)] : []),
          ...(value.fullTruncated ? [`（完整正文超过 ${fullMaxChars} 字上限，已截断）`] : []),
        ].join('\n')
        return [{ type: 'text', text: `<memory-data trust="untrusted" scope="${escapeMemoryAttr(value.scope)}" key="${escapeMemoryAttr(value.key)}">${body}</memory-data>` }]
      },
    },
    async execute(args: { key: string; scope?: string; includeFull?: boolean; confirmed?: boolean }, exec?: any) {
      const key = String(args.key || '').trim()
      if (!key) throw new Error('memory_get: key 不能为空')
      // C5：子代理不可读取凭据类记忆（auth.*）
      if (isSubagentAgent(exec?.agent) && key.toLowerCase().startsWith('auth.')) {
        throw new Error('memory_get: 子代理会话不可读取凭据类记忆（auth.*）')
      }
      const scope = normalizeScope(args.scope, defaultScope)
      const includeFull = args.includeFull === true
      // C7：凭据类记忆（auth.* 或 value 命中凭据正则）默认掩码——记忆原文会随工具返回
      // 进入会话上下文并外发至 LLM provider，明文凭据不应默认进入上下文
      // T10（第五轮收口）：confirmed 只是模型自述，不构成用户授权——
      // 默认即使 confirmed:true 也掩码；只有部署者显式 allowCredentialReveal:true 才开放取回路径
      const reveal = allowCredentialReveal && args.confirmed === true
      return withLock(async () => {
        const items = await readItems()
        const item = items.find((entry) => entry.scope === scope && entry.key === key)
        if (!item) return { found: false, key, scope }
        const masked = !reveal && shouldMaskOutbound(item.key, item.value)
        return {
          found: true,
          key,
          scope,
          // C4：清洗下移到工具输出面——检索通道不再返回原文投毒串；C7 再叠加凭据掩码
          value: masked ? maskCredential(item.value) : sanitizeValue(item.value),
          // F1（复审）：读取侧也必须设上限。写入侧三条路径都按 fullMaxChars 截断，但 store 里
          // 可能留有更早版本或 /memory restore 灌进来的超长 full（那是唯一没设限的入口），
          // 而 render 现在会把 full 原文交给模型——不截断等于一次 restore 就能把单条注入放到 MB 级。
          ...(includeFull && item.full && !masked ? {
            full: sanitizeValue(item.full).slice(0, fullMaxChars),
            ...(item.full.length > fullMaxChars ? { fullTruncated: true } : {}),
          } : {}),
          ...(masked ? { masked: true } : {}),
          tags: item.tags,
          ...(item.links?.length ? { links: item.links } : {}),
          // F3（复审）：source 是 memory_set 的显式入参（模型可控），与 value 同口径清洗；
          // tags/links 是标识符，必须逐字节可回用（sanitizeValue 的 NFKC 会改写它们），
          // 因此只做定界符中和（render 侧），不在这里做语义清洗。
          ...(item.source ? { source: sanitizeValue(item.source) } : {}),
          updatedAt: item.updatedAt,
        }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_get')

  // ── memory_search：按关键词/标签搜索 ─────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '搜索持久记忆：按关键词（匹配 key/value/tags/scope）或标签过滤，返回最多 limit 条。',
    parameters: {
      query: { type: 'string', description: '关键词，留空则只按 tags/scope 过滤' },
      scope: { type: 'string', description: '限定作用域' },
      tags: { type: 'array', items: { type: 'string' }, description: '必须包含的标签' },
      limit: { type: 'number', description: '返回条数上限，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                value: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.count) return [{ type: 'text', text: '没有匹配的记忆。' }]
        // F2（复审）：schema 声明了 tags/updatedAt 却从不输出 ⇒ 模型看不见（N2 同型）。
        // 天龄是守则「引用前先验证现状」的直接依据，标签是检索维度，都补进结果行。
        const neutral = (s: unknown) => neutralizeMemoryDataDelimiters(String(s))
        const lines = value.items.map((item) => {
          const meta = [
            item.updatedAt ? ageLabel(item.updatedAt) : '',
            item.tags?.length ? `标签 ${item.tags.map(neutral).join(', ')}` : '',
          ].filter(Boolean).join(' · ')
          return `<memory-data trust="untrusted" scope="${escapeMemoryAttr(item.scope)}" key="${escapeMemoryAttr(item.key)}">- ${escapeMemoryAttr(item.scope)}/${escapeMemoryAttr(item.key)}${meta ? ' · ' + meta : ''}: ${item.value}</memory-data>`
        })
        return [{ type: 'text', text: `找到 ${value.count} 条记忆：\n${lines.join('\n')}` }]
      },
    },
    async execute(args: { query?: string; scope?: string; tags?: string[]; limit?: number }, exec?: any) {
      const isSub = isSubagentAgent(exec?.agent)
      // C5：子代理无 scope 检索时默认只返回其 sub:<id> 与当前工作区 scope
      const allowedScopes = isSub && !args.scope
        ? [`sub:${String(exec?.agent?.session?.id ?? 'unknown')}`, ...currentWorkspaceScopes()]
        : undefined
      const result = await searchItems({ query: args.query, scope: args.scope, tags: args.tags, limit: args.limit, allowedScopes })
      // C5：子代理检索面排除 auth.* 条目
      const items = isSub
        ? result.items.filter((item) => !item.key.toLowerCase().startsWith('auth.'))
        : result.items
      return {
        count: items.length,
        items: items.map((item) => ({
          key: item.key,
          scope: item.scope,
          // C7：凭据类条目的 value 出库即掩码（含非 auth.* 但命中凭据正则的历史遗留条目）
          value: shouldMaskOutbound(item.key, item.value) ? maskCredential(item.value) : sanitizeValue(item.value),
          tags: item.tags,
          updatedAt: item.updatedAt,
        })),
      }
    },
  })), '@dsh-external/dsh-persistent-memory: memory_search')

  // ── memory_forget：删除一条记忆 ───────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除一条持久记忆（按 scope+key）。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键' },
      scope: { type: 'string', description: '作用域，默认 global' },
      confirmed: { type: 'boolean', description: '删除凭据类记忆（auth.*）需 confirmed: true（先向用户确认）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          removed: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          scope: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed ? `已删除记忆：${value.scope}/${value.key}` : `未找到要删除的记忆：${value.scope}/${value.key}`,
      }],
    },
    async execute(args: { key: string; scope?: string; confirmed?: boolean }, exec?: any) {
      const key = String(args.key || '').trim()
      if (!key) throw new Error('memory_forget: key 不能为空')
      const scope = normalizeScope(args.scope, defaultScope)
      // M3：与 memory_set 同源的隔离——子代理不得删除 global 记忆；auth.* 需显式确认
      if (isSubagentAgent(exec?.agent) && scope === 'global') {
        throw new Error('memory_forget: 子代理会话禁止删除 global 记忆')
      }
      if (key.toLowerCase().startsWith('auth.') && args.confirmed !== true) {
        throw new Error('memory_forget: 删除凭据类记忆（auth.*）需 confirmed: true（先向用户确认）')
      }
      return withLock(() => withConflictRetry(async () => {
        const items = await readItems()
        const before = items.length
        const next = items.filter((item) => !(item.scope === scope && item.key === key))
        if (next.length === before) return { ok: true, removed: false, key, scope }
        await writeItems(next)
        // M3 审计日志：删除不可逆，记录 scope/key/会话
        ctx.logger.info('[mem] forget %s/%s by %s', scope, key, String(exec?.agent?.session?.id ?? 'unknown'))
        return { ok: true, removed: true, key, scope }
      }))
    },
  })), '@dsh-external/dsh-persistent-memory: memory_forget')

  // ── memory_stats：查看记忆库概况 ─────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: '查看持久记忆库概况：总条数、各作用域分布。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          scopes: { type: 'object', required: true, additionalProperties: true },
          dropped: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const scopes = Object.entries(value.scopes || {}).map(([scope, count]) => `- ${scope}: ${count}`).join('\n')
        const droppedNote = value.dropped ? `\n（另有 ${value.dropped} 条损坏行在读取时被跳过）` : ''
        return [{ type: 'text', text: `记忆库共 ${value.total} 条：\n${scopes}${droppedNote}` }]
      },
    },
    async execute() {
      return withLock(async () => {
        const items = await readItems()
        // m12：Object.create(null) —— scope 是模型/用户可控字符串，'constructor' 等
        // 原型链键会让计数变成 "function Object() { [native code] }1"
        const scopes: Record<string, number> = Object.create(null)
        for (const item of items) scopes[item.scope] = (scopes[item.scope] || 0) + 1
        return { total: items.length, scopes, dropped: store.getDropped() }
      })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_stats')


  // ── 记忆代谢（v0.1.9）：列出过期候选；M12 起 apply:true 可直接归档（不删条目）──
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_dream',
    description: '记忆代谢维护：列出过期/低活跃候选条目（task.* 超 30 天未更新、任意条目超 90 天、标记完成超 14 天），给出处理建议。apply:true 时直接归档超 90 天条目（value 压缩为一行摘要、原文保留进 full），不删除任何条目。',
    parameters: {
      scope: { type: 'string', description: '限定作用域，默认全部' },
      maxItems: { type: 'number', description: '最多列出的候选数，默认 20' },
      apply: { type: 'boolean', description: 'true 时归档超过 90 天的条目：value 压缩为一行摘要（≤80 字），原文完整保留进 full（memory_get includeFull 可取回）；默认 false 只列候选' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: { type: 'array', items: { type: 'string' }, required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: { scope?: string; maxItems?: number; apply?: boolean }, exec?: any) {
      const scopeFilter = args.scope ? normalizeScope(args.scope, defaultScope) : ''
      const maxItems = Math.max(1, Math.min(50, Number(args.maxItems) || 20))
      const apply = args.apply === true
      // S1（对抗性复核，v0.1.24）：apply 会改写/归档库中条目——子代理只准维护自己的 scope。
      // T7（第五轮收口）：apply 是写操作，没有 exec 就无法确认调用方身份 → fail-closed 拒绝
      // （此前「无 exec 即豁免」会让该形状直接归档 global，是已知攻击面）。
      // 真实工具调用必带 exec；/memory dream 命令走的是另一条路径（只列候选、不写库）。
      if (apply && (scopeFilter === '' || scopeFilter === 'global')) {
        if (exec === undefined) {
          throw new Error('memory_dream: apply 需要调用方身份（缺少 exec 且命令路径不支持 apply），拒绝归档。请通过工具调用并携带 exec')
        }
        if (isSubagentAgent(exec.agent)) {
          const subId = String(exec?.agent?.session?.id ?? 'unknown')
          throw new Error(`memory_dream: 子代理会话禁止归档 global 记忆；确需维护请显式传 scope=sub:${subId}（未传 scope 时归档会遍历全部 scope，含 global）`)
        }
      }
      // M12：apply 要写库，整段必须走 withConflictRetry（读→改→写是一个原子序列）
      return withLock(() => withConflictRetry(async () => {
        const items = await readItems()
        const nowMs = Date.now()
        const DAY = 86_400_000
        const ageDaysOf = (iso: string) => Math.floor((nowMs - Date.parse(iso)) / DAY)
        const inScope = (item: MemoryItem) => (!scopeFilter || item.scope === scopeFilter) && !item.key.startsWith('auth.')
        const candidates = items
          .filter(inScope)
          .map((item) => {
            const ageDays = ageDaysOf(item.updatedAt)
            let reason = ''
            let suggest = ''
            if (item.key.startsWith('task.') && ageDays > 30) { reason = 'task 状态超过 30 天未更新'; suggest = '确认是否已完成/过时：更新 value 或 memory_forget' }
            else if (ageDays > 90) { reason = '超过 90 天未更新'; suggest = '归档（详情挪 full）或 memory_forget' }
            else if (isCompletedMark(item.value) && ageDays > 14) { reason = '标记完成已超 14 天'; suggest = 'memory_forget 或归档' }
            return { key: item.key, scope: item.scope, ageDays, reason, suggest }
          })
          .filter((c) => c.reason)
          .sort((a, b) => b.ageDays - a.ageDays)
          .slice(0, maxItems)
        // M12 归档：只压 value（检索面），原文进 full（检索面缩小、信息不丢）。
        // 刻意不动 updatedAt——「多久没更新」是事实，改掉会让陈旧条目伪装成新鲜记忆；
        // 压缩后的 value 已是短摘要，再次 apply 会跳过（幂等）。
        const archived: string[] = []
        if (apply) {
          const stamp = new Date(nowMs).toISOString()
          for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (!inScope(item) || ageDaysOf(item.updatedAt) <= 90) continue
            const summary = writeOps.oneLineSummary(item.value)
            if (summary === item.value) continue
            const body = `<!-- 归档 ${stamp}：value 已压缩为一行摘要，以下为原文 -->\n${item.value}`
            const full = item.full ? `${body}\n\n${item.full}`.slice(0, fullMaxChars) : body.slice(0, fullMaxChars)
            items[i] = { ...item, value: summary, full }
            archived.push(`${item.scope}/${item.key}`)
          }
          if (archived.length > 0) await writeItems(items)
        }
        const archivedSet = new Set(archived)
        const listed = apply ? candidates.filter((c) => !archivedSet.has(`${c.scope}/${c.key}`)) : candidates
        const listText = listed.map((c) => `- [${c.scope}/${c.key}] ${c.ageDays} 天前更新，${c.reason} → ${c.suggest}`).join('\n')
        const headText = listed.length === 0
          ? '记忆代谢：没有发现过期候选，记忆库很健康。'
          : `记忆代谢：发现 ${listed.length} 条过期候选（按陈旧度排序）：\n` + listText
        // 归档文案固定带「归档」二字：调用方据此确认 apply 真的生效
        const summary = apply
          ? `记忆代谢归档（apply=true）：已归档 ${archived.length} 条超过 90 天的条目——value 压缩为一行摘要（≤${ARCHIVE_SUMMARY_MAX} 字）、原文完整保留在 full（memory_get includeFull 可取回），未删除任何条目。\n` + headText
          : headText
        return {
          candidates: listed.map((c) => `${c.scope}/${c.key}|${c.ageDays} 天|${c.reason}|${c.suggest}`),
          summary,
        }
      }))
    },
  })), '@dsh-external/dsh-persistent-memory: memory_dream')


  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_import',
    description: `把外部文件导入记忆库：CLAUDE.md / MEMORY.md / Claude Code memories.json 等。.json 按条目、.md/.txt 按段落切分，自动分配 ref/rule/lesson 前缀，value 截 ${valueMaxChars} 字余量入 full，与库中已有条目内容高度相似（≥70%）自动跳过。`,
    parameters: {
      path: { type: 'string', required: true, description: '要导入的文件绝对路径' },
      scope: { type: 'string', description: '目标 scope，默认当前工作区 scope（DSH_WORKSPACE_NAME）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imported: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          rejected: { type: 'number', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: { path: string; scope?: string }, exec?: any) {
      const filePath = String(args.path || '').trim()
      if (!filePath) throw new Error('memory_import: path 必填')
      // scope 先归一化再进闸门：' Global ' 这类写法不能绕过隔离（S1）
      const scope = normalizeScope(args.scope, writeOps.defaultImportScope())
      return writeOps.importFileToStore(filePath, scope, { exec })
    },
  })), '@dsh-external/dsh-persistent-memory: memory_import')

  // ── 会话回捞（v0.1.9）：sessionQuery 全文检索历史会话 ─────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '会话回捞：全文检索历史会话（DSH sessionQuery 服务），把最强匹配的会话片段带回上下文。记忆库里没有、但以前会话说过的事，用它找。',
    parameters: {
      query: { type: 'string', required: true, description: '要回捞的主题/关键词' },
      limit: { type: 'number', description: '最多返回的会话命中数，默认 3' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: { type: 'array', items: { type: 'string' }, required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: { query: string; limit?: number }, exec?: any) {
      const query = String(args.query || '').trim()
      if (!query) throw new Error('memory_recall: query 必填')
      const sq = ctx.get('sessionQuery') as { searchSessions?: (r: { query: string; limit?: number; sessionFilters?: Array<{ kind: 'cwd'; values: string[] }> }, opts?: { signal?: AbortSignal }) => Promise<{ items?: readonly { id?: string; title?: string; bestMatch?: { text?: string; seq?: number } }[] }> } | undefined
      if (!sq || typeof sq.searchSessions !== 'function') {
        throw new Error('memory_recall: 当前环境没有 sessionQuery 服务（全文会话检索不可用）')
      }
      // C6：对齐 DSH 官方 tool-session-query——强制 cwd 过滤，会话无工作区直接拒绝
      const cwd = exec?.agent?.session?.header?.cwd
      if (cwd === undefined) throw new Error('memory_recall: 当前会话没有工作区，跨会话检索不可用')
      const limit = Math.max(1, Math.min(10, Number(args.limit) || 3))
      let page
      try { page = await sq.searchSessions({ query, limit, sessionFilters: [{ kind: 'cwd', values: [cwd] }] }, { signal: exec?.signal }) } catch (err) {
        ctx.logger.warn('dsh-persistent-memory: memory_recall search failed: %o', err)
        throw new Error('memory_recall: 历史会话检索失败，稍后再试')
      }
      const hits = (page?.items ?? []).map((h) => ({
        sessionId: String(h?.id ?? ''),
        title: String((h as unknown as { title?: string })?.title ?? ''),
        seq: Number(h?.bestMatch?.seq ?? 0),
        snippet: sanitizeValue(String(h?.bestMatch?.text ?? '').slice(0, 400)),
      })).filter((h) => h.snippet)
      const summary = hits.length === 0
        ? '没有从历史会话中回捞到相关内容。'
        : `历史会话回捞 ${hits.length} 条：\n` + hits.map((h) => `<memory-data trust="untrusted">- [${escapeMemoryAttr(h.title || h.sessionId)} #${h.seq}] ${h.snippet}</memory-data>`).join('\n')
      return {
        hits: hits.map((h) => `${h.title || h.sessionId}#${h.seq}|${h.snippet}`),
        summary,
      }
    },
  })), '@dsh-external/dsh-persistent-memory: memory_recall')
}
