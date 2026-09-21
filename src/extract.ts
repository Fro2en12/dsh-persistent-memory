/**
 * 轮末自动提取（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * 订阅 session/event 火线缓冲每个会话当前 turn 的文本；agent/turn-stopping 时异步调 LLM
 * 提取高置信候选，过最小闸门后落盘。互斥：主 agent 30s 内手动写过记忆 → 跳过；提取中 →
 * 跳过；冷却内 → 跳过。两个监听器都绝不抛错。
 *
 * deps 化说明：本模块不再闭包 apply()，所有共享状态与常量经 deps 传入；其中
 * turnBuffers / lastExtractAt / lastManualWriteAt / extractingSessions 是引用传递，
 * extractCounters 必须整体传引用（解构成 number 会让全局并发上限失效）。
 */
import type { Context } from 'cordis'
import { EXTRACTION_SYSTEM_PROMPT } from './prompts.js'
import { KEY_PREFIX_WHITELIST } from './types.js'
import { findCredentialMatch, upsertMemory } from './write-gate.js'
import { withConflictRetry } from './store.js'
import { bigramJaccard, keySimilarity, truncate } from './recall.js'
import { PLUGIN_NAME } from './const.js'
import type { MemoryDeps } from './deps.js'

export function registerExtraction(ctx: Context, deps: MemoryDeps): void {
  const {
    valueMaxChars, withLock, readItems, writeItems, defaultScope, makeId, maxItems,
    autoExtract, autoExtractCooldownMs, turnBuffers, lastExtractAt, lastManualWriteAt,
    extractingSessions, extractCounters, isSubagentAgent, setBounded,
  } = deps

  const MAX_CONCURRENT_EXTRACT = 2

  /** M4：提炼库容量软上限——超过后提取器只接受高价值或可合并候选 */
  const EXTRACT_LIBRARY_SOFT_CAP = 500

  /** 提取器落盘路径：与 memory_set 同源的最小闸门（前缀白名单/凭据词/value 截断/tags 裁剪）。
   *  P1-2（复审收口）：返回值从 boolean 改成归宿枚举——原先所有拒绝都只 return false，
   *  调用方无法区分「闸门拒绝」「软上限拒绝」「库满拒绝」「内容全等」，于是容量丢弃被静默吞掉、
   *  日志还把这一轮报成成功。
   *  @returns written 真写入｜noop 内容全等未落盘｜rejected 闸门/软上限拒绝｜capacity 库达 maxItems */
  async function writeExtractedMemory(raw: { key?: unknown; value?: unknown; tags?: unknown[] }): Promise<'written' | 'noop' | 'rejected' | 'capacity'> {
    const key = String(raw.key ?? '').trim()
    if (!key) return 'rejected'
    const prefix = key.split('.')[0].toLowerCase()
    if (!KEY_PREFIX_WHITELIST.includes(prefix)) return 'rejected'
    if (prefix === 'auth') return 'rejected'
    let value = String(raw.value ?? '').trim()
    if (!value) return 'rejected'
    if (findCredentialMatch(value)) return 'rejected'
    if (value.length > valueMaxChars) value = truncate(value, valueMaxChars)
    const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)).filter(Boolean).slice(0, 3) : []
    const now = new Date().toISOString()
    let outcome: 'written' | 'noop' | 'rejected' | 'capacity' = 'noop'
    await withLock(() => withConflictRetry(async () => {
      const items = await readItems()
      // M4 容量软上限：无人值守的提取器不能无限撑大库（scoreItem 与全量重写随条数线性劣化）。
      // 超限后只接受两类候选：rule./lesson. 高价值条目，或「其实是在更新已有记忆」（足够相似）。
      if (items.length > EXTRACT_LIBRARY_SOFT_CAP && prefix !== 'rule' && prefix !== 'lesson') {
        const mergeable = items.some((item) => item.scope === defaultScope
          && (keySimilarity(item.key, key) >= 0.6 || bigramJaccard(item.value, value) >= 0.6))
        if (!mergeable) {
          outcome = 'rejected'
          return
        }
      }
      // M4：复用 memory_set 的合并逻辑——修复前只按精确 key 匹配，同一事实的 key 漂移
      // （env.node-version / env.nodejs-version / tool.node-version）每次都新建一条。
      const result = upsertMemory(items, {
        key,
        value,
        full: undefined,
        links: undefined,   // F7：提取不覆盖已有 links
        tags: tags.length ? tags : undefined,   // 候选没给 tags 时保持旧值
        scope: defaultScope,
        createdAt: now,
        updatedAt: now,
        source: '轮末提取',
        // P2-1（复审收口）：explicitSource=true 会让 upsertMemory 用常量 '轮末提取' 覆盖掉
        // memory_set 写下的「日期+会话」引证，并且因为 prev.source !== '轮末提取' 而让合并路径
        // 的 changed 恒为真——T17 的省盘在提取器路径几乎失效。改为 false：已有条目保留原引证
        // （不参与 changed 比较），新建条目仍由 upsertMemory 的 push 分支写入 '轮末提取'。
        explicitSource: false,
      }, { dedupe: true, makeId })
      // M12 容量守卫（第七轮补）：与 memory_set:1365 同口径——只挡「新增」，更新已有 key 不受限。
      // 修复前提取器完全不看 maxItems，只受 EXTRACT_LIBRARY_SOFT_CAP 软上限约束，且 rule/lesson
      // 可穿透软上限，无人值守路径能把库推到硬上限之上。
      if (result.created && items.length > maxItems) {
        items.pop()
        outcome = 'capacity'
        return
      }
      // T17：内容全等（含 dedupe 合并到等价条目）时不落盘——省掉抢锁与写盘；
      // 此时记为 noop，调用方会继续尝试下一条候选。
      if (result.changed) await writeItems(items)
      outcome = result.changed ? 'written' : 'noop'
    }))
    return outcome
  }


  // 日志级别说明：cordis 的默认阈值是 INFO（vendor/cordis/src/logger.ts:155-156 的
  // targetLevel ?? LoggerLevel.INFO），warn 与 debug 都被丢弃；默认部署也没有挂
  // logger-console（它的 getDefaults 不设 levels），所以下面的 warn 在默认环境下不可见。
  // 级别仍按官方惯例取 warn——官方对可预期的后台失败一律 warn（session-title/src/index.ts:570、
  // session-persistence-jsonl/src/storage.ts:536）。要看它需挂 logger-console 且 levels.default ≥ 2。
  async function extractAndWrite(sid: string, dialogue: string): Promise<void> {
    const llm = ctx.get('llm') as any
    // P2-11（复审）：这几处原先静默返回，「提取器空转」与「正常但本轮无候选」不可区分。
    // 环境类原因用 debug（每轮都有，不该刷屏），内容类原因用 info（真的出现了异常回包）。
    if (!llm) { ctx.logger.debug('[mem] extract skipped: llm service unavailable'); return }
    const sel = (ctx.get('agentDefaultModel') as any)?.currentSelection?.() as { provider?: string; model?: string } | undefined
    const provider = sel?.provider
    const model = sel?.model
    if (!provider || !model) { ctx.logger.debug('[mem] extract skipped: no provider/model selected'); return }
    const timeout = AbortSignal.timeout(5000)
    const textChunks: string[] = []
    try {
      const stream = llm.stream({
        provider,
        model,
        system: EXTRACTION_SYSTEM_PROMPT,
        maxTokens: 300,
        temperature: 0,
        signal: timeout,
        messages: [{
          id: `mid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text: `对话摘录：\n${dialogue}` }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME },
        }],
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') textChunks.push(chunk.text)
      }
    } catch (err) {
      ctx.logger.warn('[mem] extract llm failed: %o', err)
      return
    }
    const text = textChunks.join('').trim()
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) { ctx.logger.info('[mem] extract: LLM reply contained no JSON object — nothing extracted'); return }
    let parsed: any
    try { parsed = JSON.parse(m[0]) } catch { ctx.logger.info('[mem] extract: LLM reply JSON parse failed'); return }
    const memories = Array.isArray(parsed?.memories) ? parsed.memories : []
    let written = 0
    // 上限由 slice(0, 3) 决定；原先这里还有一句 if (written >= 3) break —— 每轮至多 +1 且候选 ≤3，
    // 永远到不了 3，是死代码，且会让人误以为上限由它把守（R4 复审 F-B）。
    let skipped = 0
    let droppedByCapacity = 0
    for (const cand of memories.slice(0, 3)) {
      try {
        const outcome = await writeExtractedMemory(cand)
        if (outcome === 'written') written += 1
        else {
          skipped += 1
          if (outcome === 'capacity') droppedByCapacity += 1
        }
      } catch (err) {
        skipped += 1
        // 闸门拒绝走的是 writeExtractedMemory 的 return 'rejected'，不抛错；能到这里的是
        // withLock/withConflictRetry/writeItems 的存储层异常，别把两者混为一谈。
        ctx.logger.warn('[mem] extract write failed (存储层异常，非闸门拒绝): %o', err)
      }
    }
    // P1-2（复审收口）：库满是用户可操作的条件，此前完全静默、还被报成成功。
    // 默认日志阈值是 INFO（warn 不可见，见上方级别说明），故给两条：warn 表达语义级别，
    // info 摘要兜住默认部署下的可见性。
    if (droppedByCapacity > 0) {
      ctx.logger.warn('[mem] extract: library at maxItems=%d, %d candidate(s) dropped — run memory_dream', maxItems, droppedByCapacity)
    }
    // P2-11：无论是否写入都留一条摘要——「提取器跑过但 0 候选」与「压根没跑」必须可区分。
    ctx.logger.info('[mem] extract: %d candidate(s), %d written, %d skipped%s', memories.length, written, skipped,
      droppedByCapacity > 0 ? ` (${droppedByCapacity} dropped: library at maxItems=${maxItems}; run memory_dream)` : '')
  }

  if (autoExtract) {
    // ① 火线缓冲：每会话当前 turn 的文本（user/message 与 assistant/message）
    ctx.on('session/event', (session: any, event: any) => {
      try {
        if (!session?.id || !event) return
        const sid = String(session.id)
        if (event.type === 'turn/start') {
          turnBuffers.set(sid, [])
          return
        }
        let text = ''
        if (event.type === 'user/message') {
          const blocks = Array.isArray(event.data?.content) ? event.data.content : []
          text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('\n')
        } else if (event.type === 'assistant/message') {
          const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
          text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('\n')
        }
        text = text.trim()
        if (!text) return
        const buf = turnBuffers.get(sid)
        if (!buf) return
        buf.push(text.slice(0, 2000))
        if (buf.length > 30) buf.splice(0, buf.length - 30)
        if (turnBuffers.size > 64) {
          const oldest = turnBuffers.keys().next().value
          if (oldest !== undefined) turnBuffers.delete(oldest)
        }
      } catch { /* 观察者绝不抛 */ }
    }, { global: true })

    // ② 轮末触发：异步提取（serial 监听器立即返回，不拖慢 turn 收尾）
    ctx.on('agent/turn-stopping', (payload: any) => {
      try {
        const agent = payload?.agent
        if (!agent || isSubagentAgent(agent)) return
        const sid = String(agent.session?.id ?? '')
        if (!sid) return
        if (extractingSessions.has(sid)) return                  // 同会话不重入
        if (extractCounters.globalInFlight >= MAX_CONCURRENT_EXTRACT) return  // 超全局上限：本次放弃，且不写冷却（下轮可重试）
        const now = Date.now()
        const last = lastExtractAt.get(sid)
        if (last !== undefined && now - last < autoExtractCooldownMs) return
        const manual = lastManualWriteAt.get(sid)
        if (manual !== undefined && now - manual < 30_000) return
        const buf = turnBuffers.get(sid)
        if (!buf || buf.length === 0) return
        // 冷却与占位在「真正发起请求」之后才写：修复前先写 lastExtractAt 再 return，
        // 被上限/互斥跳过的会话会白等一个冷却周期
        extractingSessions.add(sid)
        extractCounters.globalInFlight += 1
        setBounded(lastExtractAt, sid, now)
        void extractAndWrite(sid, buf.join('\n').slice(-4000))
          .catch((err) => ctx.logger.warn('[mem] extract failed: %o', err))
          .finally(() => {
            extractingSessions.delete(sid)
            extractCounters.globalInFlight -= 1
          })
      } catch { /* 观察者绝不抛 */ }
    }, { global: true })
  }
}
