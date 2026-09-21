/**
 * pre-step 注入四通道（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * 通道顺序：守则（每会话首轮一次）→ 教训/规则 → 召回（词法 + RRF + 可选 LLM 重排）→ 索引兜底，
 * 共享会话级总预算 injectionBudgetChars；守则不计入预算（它永不被砍）。
 *
 * deps 化说明：原先这些函数闭包在 apply() 上（scoreEnv/recallEnv、rerankMemories、
 * isOwnInjected/AUTO_CAPTURE_FORM/sessionQueryAvailable/buildGuideText 与 pre-step 监听器）。
 * 现在整块搬进 registerPreStep(ctx, deps)，保持「同层闭包」结构——函数体逐字未改，
 * 只是闭包对象从 apply() 作用域换成 deps 解构出的同名局部绑定。
 * sessionInjections / runtime / 各 Map 都是引用传递，与 index.ts 共用同一实例。
 */
import type { Context } from 'cordis'
import { buildAutoCaptureText, RERANK_SYSTEM_PROMPT, SUBAGENT_CAPTURE_TEXT } from './prompts.js'
import { buildIndexBlock, buildRerankManifest, excludeCredentials, formatLesson, formatRecall } from './format.js'
import type { MemoryItem } from './types.js'
import { sanitizeValue } from './sanitize.js'
import { fitBudget, fitByRenderedLength, pickRecallItems, type RecallEnv, type ScoreEnv } from './recall.js'
import { PLUGIN_NAME } from './const.js'
import { extractQuery, pickLessonItems, pickRecallCandidates, regretSignal, ruleScene } from './query.js'
import type { MemoryDeps } from './deps.js'

export function registerPreStep(ctx: Context, deps: MemoryDeps): void {
  const {
    autoRecall, autoRecallLimit, autoRecallMaxChars, autoRecallBudgetChars,
    injectionBudgetChars, autoRecallMinScore, autoRecallRelativeFloor, autoRecallScope,
    autoRecallFallback, autoCapture, autoRecallOnce, autoRecallCooldownMs,
    rrfRecall, rrfFirstTurnOnly, synonymExpansion,
    taskTtlDays, autoRecallRerankMax, valueMaxChars, runtime,
    readItems, withLock, sessionInjections, persistInjectionState,
    makeId, setBounded, isSubagentAgent, currentWorkspaceScopes,
  } = deps


  // 召回评分环境：把 apply 闭包内的运行时开关注入提取后的纯函数（recall.ts）
  const scoreEnv = (): ScoreEnv => ({ synonymExpansion, taskTtlDays, workspaceScopes: currentWorkspaceScopes() })
  const recallEnv = (): RecallEnv => ({
    ...scoreEnv(),
    autoRecallScope,
    minScore: autoRecallMinScore,
    relativeFloor: autoRecallRelativeFloor,
    rrfRecall: runtime.rrfRecall,
    rrfFirstTurnOnly: runtime.rrfFirstTurnOnly,
  })

  // ── LLM 语义重排（对标 Claude Code memdir/findRelevantMemories）─────────
  // 词法预筛 → 候选 manifest → LLM 选 3~5 条 → 失败/超时降级词法 top。
  // ctx.get('llm') 为可选服务；拿不到时静默降级（不影响原有词法链路）。


  async function rerankMemories(
    ctx: Context,
    query: string,
    candidates: MemoryItem[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<MemoryItem[] | null> {
    const llm = ctx.get('llm') as any
    if (!llm) return null
    const sel = (ctx.get('agentDefaultModel') as any)?.currentSelection?.() as
      | { provider?: string; model?: string } | undefined
    const provider = sel?.provider
    const model = sel?.model
    if (!provider || !model) return null
    const manifest = buildRerankManifest(candidates)
    // 5s 整体超时 + 外部中止信号，防 pre-step 被慢调用拖住
    const timeout = AbortSignal.timeout(5000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const system = RERANK_SYSTEM_PROMPT.replace('{{max}}', String(limit))
      const content = `Query: ${query}\n\nAvailable memories:\n${manifest}`
      const textChunks: string[] = []
      const stream = llm.stream({
        provider,
        model,
        system,
        maxTokens: 300,
        temperature: 0,
        signal: combined,
        messages: [{
          id: `mid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text: content }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME },
        }],
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') textChunks.push(chunk.text)
      }
      const text = textChunks.join('').trim()
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return null
      const parsed = JSON.parse(m[0]) as { selected_keys?: string[] }
      const byKey = new Map(candidates.map((c) => [`${c.scope}/${c.key}`, c]))
      const selected = (parsed.selected_keys ?? [])
        .map((k: string) => byKey.get(k))
        .filter((x: MemoryItem | undefined): x is MemoryItem => !!x)
      // 解析成功就如实返回（空数组 = LLM 明确否决，调用处据此回落索引兜底）；
      // 只有异常/超时才是 null（降级回词法结果）。
      return selected.slice(0, limit)
    } catch (err) {
      ctx.logger.warn('dsh-persistent-memory: rerank failed: %o', err)
      return null
    }
  }

  // 注入去重（v0.1.19 起为 form 级）：会话历史里已有同 form 的注入即视为已注入，
  // 不再比对正文——否则守则/召回文本一改（如精简守则上线）就会在同一会话再追加一份。
  function isOwnInjected(message: unknown, form: string): boolean {
    const msg = message as { source?: { kind?: string; plugin?: string; form?: string } }
    return Boolean(
      msg
      && msg.source?.kind === 'plugin'
      && msg.source.plugin === PLUGIN_NAME
      && msg.source.form === form,
    )
  }

  // ── 自动记忆守则 + 自动召回 ────────────────────────────────────────────
  // 守则不再走 system-prompt section：complete:true 的 preset（如 stock minimal）
  // 装配后只保留 persona 一个 section，其余全部静默丢弃；统一用 pre-step 注入
  // plugin user message，任何 preset 下都可达、可重放、压缩可见。
  const AUTO_CAPTURE_FORM = 'memory-capture-guide'

  // C6：sessionQuery 不可用时守则不再指向 memory_recall（否则把模型引向必然报错的死路）
  const sessionQueryAvailable = (): boolean => {
    const sq = ctx.get('sessionQuery') as { searchSessions?: unknown } | undefined
    return Boolean(sq && typeof sq.searchSessions === 'function')
  }
  const buildGuideText = (agent: any): string => {
    const recallLine = sessionQueryAvailable()
      ? '- 记忆库里没有、但以前会话说过 → `memory_recall`（全文检索历史会话）。'
      : ''
    const base = isSubagentAgent(agent) ? SUBAGENT_CAPTURE_TEXT : buildAutoCaptureText(valueMaxChars)
    return base.replace('{{RECALL_LINE}}\n', recallLine ? recallLine + '\n' : '')
  }

  if (autoRecall || autoCapture) {
    ctx.on('agent/pre-step', async (
      payload: { agent: any; messages: unknown[]; step: number; signal?: AbortSignal },
      next: () => Promise<any>,
    ): Promise<any> => {
      const decision = await next()
      const sid = String(
        payload.agent?.session?.id ?? payload.agent?.session?.sessionId ?? 'default',
      )
      // R2（复审）：原先直接 as unknown[]，messages 非数组时 claimed.includes 会在 try 之外抛
      // TypeError，违反本文件「观察者绝不抛」的约定（DSH 侧恒为数组，属健壮性收口）。
      const claimed: unknown[] = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : []
      const entered: unknown[] = Array.isArray(decision?.messages) ? [...(decision.messages as unknown[])] : []
      const lastClaimedIndex = entered.findLastIndex((item) => claimed.includes(item))
      let changed = false
      try {
        if (decision?.kind === 'reject') return decision
        if (payload.signal?.aborted) return decision
        if (payload.step === 1 && (!Array.isArray(decision.messages) || decision.messages.length === 0)) return decision
        // n4：只在判定为子代理时打 debug，并附 isSubagentAgent 的返回值——
        // 修复前每个新会话首步都打一条探测日志，且只打原始字段不打判定结果
        const isSubAgentForLog = isSubagentAgent(payload.agent)
        if (payload.step === 1 && isSubAgentForLog) {
          const header = payload.agent?.session?.header ?? {}
          ctx.logger.debug('[mem] subagent detected %o', {
            isSubagentAgent: isSubAgentForLog,
            origin: header?.origin,
            parent: header?.parentSession,
            depth: header?.delegationDepth,
            optDepth: payload.agent?.options?.subagentDepth,
            id: payload.agent?.session?.id,
          })
        }

        // M11：会话级总预算——教训 > 召回 > 索引 串行分配。
        // 第六轮：守则**不再计入预算**。它本来就「永不被砍」，占额度只会让大守则静默挤掉
        // 记忆通道（实测 full 守则 3049 > 默认预算 1200 时，教训/召回/索引全部归零）。
        // 语义：injectionBudgetChars 是「给具体记忆的额度」，守则是每会话固定成本。
        let remainingBudget = injectionBudgetChars

        // ① 记忆守则：每会话首轮注入一次（独立 form，与召回分开去重）
        if (runtime.autoCapture && payload.step === 1) {
          const guideKey = `${sid}:capture-guide`
          const guideText = buildGuideText(payload.agent)
          const guideForm = isSubagentAgent(payload.agent) ? 'memory-capture-guide-subagent' : AUTO_CAPTURE_FORM
          if (!sessionInjections.has(guideKey) && !entered.some((message: unknown) => isOwnInjected(message, guideForm))) {
            entered.splice(lastClaimedIndex + 1, 0, {
              role: 'user',
              id: makeId(),
              content: [{ type: 'text', text: guideText }],
              source: { kind: 'plugin', plugin: PLUGIN_NAME, form: guideForm, summary: '记忆守则自动注入' },
            })
            // 有界淘汰（T4 修）：统一走 setBounded（先 set 再 while(size>max) 删最旧）——
            // 旧写法「先判 size>200 再 set」的稳态是 201 条，上界失效 1 条
            setBounded(sessionInjections, guideKey, Date.now())
            persistInjectionState()
            changed = true
          }
        }

        // ② 教训/规则通道：悔恨信号（又错了/还是失败）或场景信号（路径/终端/命令）
        //    触发时强制召回 rule.*/教训/坑/修复类记忆，**不受 autoRecallOnce 限制**——
        //    这是"AI 经常犯同样错"的直接解药：错误发生时立刻把上次的坑摆到眼前。
        const lessonKeys = new Set<string>()
        if (runtime.autoRecall) {
          const items = excludeCredentials(await withLock(async () => readItems()))
          const { query } = extractQuery(payload.messages)
          const isRule = ruleScene(query)
          const isRegret = regretSignal(query)
          const lessonKey = `${sid}:lesson`
          const lastLesson = sessionInjections.get(lessonKey)
          const lessonAllowed = lastLesson === undefined || Date.now() - lastLesson >= 120_000
          if (items.length > 0 && (isRule || isRegret) && lessonAllowed) {
            // 同一条教训本会话已出现过则跳过，避免复述刷屏。
            // v0.1.20 修：渲染格式是 `[scope/key · N 天前]`，key 后面还跟着 " · 天数"，
            // 旧 marker `[scope/key]` 永远匹配不到 → 去重形同虚设（实测同一条教训相隔 6 分钟
            // 被原样注入两次，白烧 503 字）。marker 保留到 " ·" 之前即可稳定命中。
            const lessons = pickLessonItems(items, query, isRegret, isRule, 2)
            const fresh = lessons.filter((item) => {
              const marker = `[${item.scope}/${item.key} ·`
              return !entered.some((m) => JSON.stringify(m).includes(marker))
            })
            const lessonAvail = Math.max(0, Math.min(autoRecallBudgetChars, remainingBudget))
            // M11 收口：先按估算取候选，再按渲染后真实长度收敛（包装开销见 fitByRenderedLength 的注释）
            const lessonFitted = fitByRenderedLength(
              fitBudget(fresh, lessonAvail, autoRecallMaxChars, sanitizeValue, { atLeastOne: false }).kept,
              lessonAvail,
              (xs) => formatLesson(xs, autoRecallMaxChars),
            )
            const lessonKept = lessonFitted.kept
            if (lessonKept.length > 0) {
              remainingBudget -= lessonFitted.text.length
              const text = lessonFitted.text
              entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                role: 'user',
                id: makeId(),
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'memory-lesson', summary: `教训/规则提醒 ${lessonKept.length} 条` },
              })
              setBounded(sessionInjections, lessonKey, Date.now())
              persistInjectionState()
              for (const item of lessonKept) lessonKeys.add(`${item.scope}/${item.key}`)
              changed = true
            }
          }
        }

        // ③ 自动召回：每会话一次 + 冷却期
        let recallEmpty = false
        if (runtime.autoRecall) {
          const lastInjection = sessionInjections.get(sid)
          const recallAllowed = lastInjection === undefined
            || (!autoRecallOnce && Date.now() - lastInjection >= autoRecallCooldownMs)
          if (recallAllowed) {
            const { query, hasImage } = extractQuery(payload.messages)
            const all = excludeCredentials(await withLock(async () => readItems()))
            // 教训通道已给过内容的条目不再重复召回：同一条记忆在同一会话里出现两次纯属浪费。
            const items = lessonKeys.size > 0
              ? all.filter((item) => !lessonKeys.has(`${item.scope}/${item.key}`))
              : all
            if (items.length > 0) {
              const isFirstTurn = payload.step === 1
              const recalled = pickRecallItems(items, query, autoRecallLimit, autoRecallFallback, isFirstTurn, hasImage, recallEnv())
              // LLM 语义重排（v0.1.6）：词法命中候选 ≥1 且启用时，用 LLM 挑"明确有用"的条
              let recalledItems = recalled
              if (runtime.autoRecallRerank && query && !hasImage && recalled.length > 0) {
                const pool = pickRecallCandidates(items, query, autoRecallRerankMax * 4, scoreEnv)
                if (pool.length >= 1) {
                  const picked = await rerankMemories(ctx, query, pool, autoRecallRerankMax, payload.signal)
                  if (picked) recalledItems = picked   // 空数组也是有效结果 → 回落索引兜底
                }
              }
              // M11：召回同样受剩余总预算约束（单通道预算与剩余预算取小）
              const recallAvail = Math.max(0, Math.min(autoRecallBudgetChars, remainingBudget))
              // M11 收口：同教训通道——估算 used 不含标题与「🔗 关联」行等包装
              const recallFitted = fitByRenderedLength(
                fitBudget(recalledItems, recallAvail, autoRecallMaxChars, sanitizeValue, { atLeastOne: false }).kept,
                recallAvail,
                (xs) => formatRecall(xs, items, autoRecallMaxChars),
              )
              recalledItems = recallFitted.kept
              const recallText = recallFitted.text
              // recallEmpty 必须在重排与预算裁剪之后定：否则被砍空后既不注内容、也不注索引 = 白屏
              recallEmpty = recalledItems.length === 0
              if (recalledItems.length > 0) {
                remainingBudget -= recallText.length
                const text = recallText
                const alreadyEntered = entered.some((message: unknown) => isOwnInjected(message, 'memory-recall'))
                // 已在本会话可见表面出现过则不重复注入
                let onSurface = false
                const surface = payload.agent?.session?.surface
                if (!alreadyEntered && Array.isArray(surface?.nodes) && Array.isArray(payload.agent?.session?.events)) {
                  onSurface = surface.nodes.some((seq: number) => {
                    const event = payload.agent.session.events[seq]
                    return event?.type === 'user/message' && isOwnInjected(event.data, 'memory-recall')
                  })
                }
                if (!alreadyEntered && !onSurface) {
                  entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                    role: 'user',
                    id: makeId(),
                    content: [{ type: 'text', text }],
                    source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'memory-recall', summary: `记忆自动召回 ${recalledItems.length} 条` },
                  })
                  setBounded(sessionInjections, sid, Date.now())
                  persistInjectionState()
                  changed = true
                }
              }
            }
          }
        }

        // ④ 索引兜底：首轮没有任何召回且不是看图提问 → 注入索引而不是画像（v0.1.6）
        // 教训通道不再阻止索引：它给的是「可能是坑的内容」，索引给的是「库里还有什么」；
        // 教训通道命中的条目会从目录里排除，两者不重复。
        if (runtime.autoRecall && payload.step === 1 && !isSubagentAgent(payload.agent)) {
          const { hasImage } = extractQuery(payload.messages)
          const idxKey = `${sid}:index`
          if (!hasImage && !sessionInjections.has(idxKey) && recallEmpty) {
            const items = await withLock(async () => readItems())
            const text = items.length > 0 ? buildIndexBlock(items, currentWorkspaceScopes(), lessonKeys) : ''
            // M11：索引兜底在剩余总预算内才注入（守则/教训/召回已先分配）
            if (text && text.length <= remainingBudget) {
              entered.splice(lastClaimedIndex + 1 + (changed ? 1 : 0), 0, {
                role: 'user',
                id: makeId(),
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'memory-index', summary: '记忆索引（未召回）' },
              })
              setBounded(sessionInjections, idxKey, Date.now())
              // v0.1.20 互斥：索引块与召回共用会话主键——首轮给过目录就不再补一次
              // 召回，避免同一会话叠两套重叠记忆（实测索引 424 + 召回 460 = 884 字）。
              // 需要具体内容时模型手上有 memory_search。
              setBounded(sessionInjections, sid, Date.now())
              persistInjectionState()
              changed = true
            }
          }
        }

        if (changed) return { kind: 'enter', messages: entered }
        return decision
      } catch (error) {
        ctx.logger.warn(`dsh-persistent-memory: auto injection failed: %o`, error)
        // M1：注入链被坏数据/故障打断时不再整体静默——降级为仅注入守则（守则是静态文案，不受库数据影响）
        if (changed) return { kind: 'enter', messages: entered }
        try {
          if (runtime.autoCapture && payload.step === 1 && decision && Array.isArray(decision.messages)) {
            const guideKey = `${sid}:capture-guide`
            const guideForm = isSubagentAgent(payload.agent) ? 'memory-capture-guide-subagent' : AUTO_CAPTURE_FORM
            // R2（复审）：兜底路径必须与主路径同口径——只判 sessionInjections 时，注入状态文件
            // 丢失/过期（插件重载）会在这里重复注入整份守则（实测 3066 字 + 历史那条共 2 份）。
            if (!sessionInjections.has(guideKey) && !entered.some((message: unknown) => isOwnInjected(message, guideForm))) {
              const guideText = buildGuideText(payload.agent)
              entered.splice(lastClaimedIndex + 1, 0, {
                role: 'user',
                id: makeId(),
                content: [{ type: 'text', text: guideText }],
                source: { kind: 'plugin', plugin: PLUGIN_NAME, form: guideForm, summary: '记忆守则自动注入' },
              })
              // R2（复审）：与其余 5 处一致走 setBounded——裸 set 绕过 T4 的 max=200 上界
              setBounded(sessionInjections, guideKey, Date.now())
              persistInjectionState()
              return { kind: 'enter', messages: entered }
            }
          }
        } catch { /* 降级失败则维持原 decision */ }
        return decision
      }
    })
  }
}
