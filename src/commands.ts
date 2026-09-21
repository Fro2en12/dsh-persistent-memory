/**
 * /memory 斜杠命令（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * 人直接查看/写入记忆，不依赖模型调用工具：status|recall|remember|forget|dream|import|export|
 * restore|panel。命令注册仍挂 ctx.effect，标签字符串逐字未变
 * （tests/minor-batch.spec.ts 断言 effect 名称含 /memory command）。
 *
 * 依赖形态：registerCommands(ctx, deps, writeOps)；写侧复用 write-ops 的同一实例，
 * 面板 HTML 复用 panel.buildPanelHtml。
 */
import { promises as fs } from 'node:fs'
import type { Context } from 'cordis'
import { dirname, isAbsolute, join } from 'node:path'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { MemoryItem } from './types.js'
import { sanitizeValue } from './sanitize.js'
import { normalizeScope } from './write-gate.js'
import { withConflictRetry } from './store.js'
import { buildPanelHtml } from './panel.js'
import { isCompletedMark, MAX_IMPORT_BYTES, type WriteOps } from './write-ops.js'
import type { MemoryDeps } from './deps.js'

export function registerCommands(ctx: Context, deps: MemoryDeps, writeOps: WriteOps): void {
  const {
    dataDir, dataFile, defaultScope, approveOnSet,
    fullMaxChars, store, readItems, writeItems,
    withLock, searchItems, makeId,
  } = deps

  // ── /memory 斜杠命令：人直接查看/写入记忆，不依赖模型调用工具 ────────
  ctx.effect(() => ctx.commands.register({
    name: 'memory',
    description: '查看/写入持久记忆：status / recall <查询> / remember <key> <内容> / forget <key> / dream / import <文件> / export <文件> / restore <文件> / panel',
    input: { hint: '<status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|export <文件>|restore <文件>|panel>' },
    recordInput: false,
    handler: (invocation) => executeMemoryCommand(invocation),
  }), 'dsh-external/dsh-persistent-memory: /memory command')


  // M12：/memory restore 的条目归一（导出文件的 items → MemoryItem）。
  // 原则是「忠实恢复」：不跑写侧闸门（前缀白名单/凭据闸门约束的是新内容的来源，
  // 恢复的是本库既往数据，卡住等于救援失败），只按 store.readItems 的坏行口径丢弃结构非法项。
  function normalizeRestoredItems(raw: unknown[]): { items: MemoryItem[]; skipped: number } {
    const out: MemoryItem[] = []
    let skipped = 0
    for (const entry of raw) {
      const e = entry as Record<string, unknown> | null
      if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.key !== 'string' || !e.key.trim() || typeof e.value !== 'string') {
        skipped++
        continue
      }
      const nowIso = new Date().toISOString()
      const tags = Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : []
      const links = Array.isArray(e.links) ? e.links.filter((l): l is string => typeof l === 'string') : []
      out.push({
        id: typeof e.id === 'string' && e.id ? e.id : makeId(),
        key: e.key.trim(),
        value: e.value,
        // F1（复审）：restore 是四条写入路径里唯一不设 full 上限的入口；导出文件里的 full 原样入库后，
        // memory_get(includeFull) 会把它整段送进模型上下文。与 memory_set / memory_dream 同口径截断。
        ...(typeof e.full === 'string' ? { full: e.full.slice(0, fullMaxChars) } : {}),
        ...(links.length ? { links } : {}),
        scope: normalizeScope(typeof e.scope === 'string' ? e.scope : '', defaultScope),
        tags,
        createdAt: typeof e.createdAt === 'string' && e.createdAt ? e.createdAt : nowIso,
        updatedAt: typeof e.updatedAt === 'string' && e.updatedAt ? e.updatedAt : nowIso,
        ...(typeof e.source === 'string' ? { source: e.source } : {}),
      })
    }
    return { items: out, skipped }
  }

  async function executeMemoryCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const raw = invocation.rawInput.trim()
    const [sub, ...rest] = raw.split(/\s+/)
    const arg = rest.join(' ').trim()
    const USAGE = 'Usage: /memory <status|recall <查询>|remember <key> <内容>|forget <key>|dream|import <文件>|export <文件>|restore <文件>|panel>'
    switch (sub) {
      case 'status':
      case 'stats': {
        const items = await withLock(async () => readItems())
        if (items.length === 0) return { kind: 'success', text: '记忆库为空（0 条）。' }
        const scopes = new Map<string, number>()
        for (const item of items) scopes.set(item.scope, (scopes.get(item.scope) || 0) + 1)
        const lines = [...scopes.entries()].map(([scope, count]) => `- ${scope}: ${count}`).join('\n')
        return { kind: 'success', text: `记忆库共 ${items.length} 条：\n${lines}` }
      }
      case 'recall': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory recall <查询词>' }
        const result = await searchItems({ query: arg, limit: 8 })
        if (result.count === 0) return { kind: 'success', text: '没有匹配的记忆。' }
        const lines = result.items.map((item) => {
          const cleaned = sanitizeValue(item.value)
          const value = cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned
          return `- [${item.scope}/${item.key}] ${value}`
        })
        return { kind: 'success', text: `找到 ${result.count} 条记忆：\n${lines.join('\n')}` }
      }
      case 'remember': {
        const key = rest[0]?.trim() || ''
        const value = rest.slice(1).join(' ').trim()
        if (!key || !value) return { kind: 'error', text: 'Usage: /memory remember <key> <内容>' }
        // M14：复用 memory_set 的完整写侧闸门（前缀/tags/凭据/截断/冲突重试）；
        // approveOnSet 对用户亲自输入豁免——人本身就是审批者
        try {
          const r = await writeOps.commitMemory({ key, value, scope: defaultScope, source: 'slash:/memory remember', fromUser: true })
          const warnText = r.warnings?.length ? '\n⚠️ ' + r.warnings.join('；') : ''
          return { kind: 'success', text: `已写入记忆：${r.scope}/${r.key}${warnText}` }
        } catch (err) {
          return { kind: 'error', text: String(err instanceof Error ? err.message : err) }
        }
      }
      case 'forget': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory forget <key>' }
        const removed = await withLock(() => withConflictRetry(async () => {
          const items = await readItems()
          const next = items.filter((item) => !(item.scope === defaultScope && item.key === arg))
          if (next.length === items.length) return false
          await writeItems(next)
          return true
        }))
        return removed
          ? { kind: 'success', text: `已删除记忆：${defaultScope}/${arg}` }
          : { kind: 'success', text: `未找到要删除的记忆：${defaultScope}/${arg}` }
      }
      case 'dream': {
        const items = await withLock(async () => readItems())
        const nowMs = Date.now()
        const DAY = 86_400_000
        const cands = items
          .filter((item) => !item.key.startsWith('auth.'))
          .map((item) => {
            const ageDays = Math.floor((nowMs - Date.parse(item.updatedAt)) / DAY)
            let reason = ''
            let suggest = ''
            if (item.key.startsWith('task.') && ageDays > 30) { reason = 'task 状态超 30 天未更新'; suggest = '更新或删除' }
            else if (ageDays > 90) { reason = '超 90 天未更新'; suggest = '归档或删除' }
            else if (isCompletedMark(item.value) && ageDays > 14) { reason = '标记完成超 14 天'; suggest = '删除或归档' }
            return { item, ageDays, reason, suggest }
          })
          .filter((c) => c.reason)
          .sort((a, b) => b.ageDays - a.ageDays)
          .slice(0, 20)
        if (cands.length === 0) return { kind: 'success', text: '记忆代谢：没有过期候选，记忆库很健康。' }
        const lines = cands.map((c) => `- [${c.item.scope}/${c.item.key}] ${c.ageDays} 天前，${c.reason} → ${c.suggest}`).join('\n')
        return { kind: 'success', text: `记忆代谢候选（${cands.length} 条）：\n${lines}\n\n处理：让 agent 用 memory_set 更新 / memory_forget 删除，或你直接确认。` }
      }
      case 'import': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory import <文件绝对路径>' }
        try {
          const r = await writeOps.importFileToStore(arg, writeOps.defaultImportScope(), { fromUser: true })
          return { kind: 'success', text: r.summary }
        } catch (err) {
          return { kind: 'error', text: String(err instanceof Error ? err.message : err) }
        }
      }
      case 'export': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory export <文件路径>' }
        // S7：与 memory_import 同口径——拒绝 UNC/设备路径（导出文件含 full 原文与 auth.* 明文）
        if (/^\\\\/.test(arg)) return { kind: 'error', text: '导出失败：拒绝 \\\\?\\ / UNC / 设备路径' }
        const outPath = isAbsolute(arg) ? arg : join(dataDir, arg)
        try {
          const items = await withLock(async () => readItems())
          await fs.mkdir(dirname(outPath), { recursive: true })
          await fs.writeFile(outPath, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 2), 'utf8')
          const credCount = items.filter((item) => item.key.toLowerCase().startsWith('auth.')).length
          return {
            kind: 'success',
            text: `已导出 ${items.length} 条记忆（含 full 原文）到：${outPath}`
              + (credCount > 0 ? `\n⚠️ 其中 ${credCount} 条 auth.* 凭据为明文，请妥善保管该文件。` : ''),
          }
        } catch (err) {
          return { kind: 'error', text: '导出失败：' + String(err instanceof Error ? err.message : err) }
        }
      }
      case 'restore': {
        if (!arg) return { kind: 'error', text: 'Usage: /memory restore <导出文件路径>' }
        // S7：与 memory_import 同口径——拒绝 UNC/设备路径 + 大小上限，避免超大同文件撑爆内存
        if (/^\\\\/.test(arg)) return { kind: 'error', text: '恢复失败：拒绝 \\\\?\\ / UNC / 设备路径' }
        const srcPath = isAbsolute(arg) ? arg : join(dataDir, arg)
        try {
          const st = await fs.stat(srcPath)
          if (st.size > MAX_IMPORT_BYTES) {
            return { kind: 'error', text: `恢复失败：文件超过 ${MAX_IMPORT_BYTES} 字节上限，记忆库未改动。` }
          }
        } catch {
          /* 读不到交给下面的 readFile 统一报错 */
        }
        // 先校验来源文件：非法文件必须在备份/写库之前被挡住（不留无意义备份，更不留半截状态）
        let parsed: { items?: unknown } | null = null
        try {
          parsed = JSON.parse(await fs.readFile(srcPath, 'utf8')) as { items?: unknown }
        } catch (err) {
          return { kind: 'error', text: `恢复失败：无法读取或解析 ${srcPath}（${String(err instanceof Error ? err.message : err)}），记忆库未改动。` }
        }
        if (!parsed || !Array.isArray(parsed.items)) {
          return { kind: 'error', text: `恢复失败：${srcPath} 不是有效的导出文件（缺少 items 数组），记忆库未改动。` }
        }
        const { items: incoming, skipped } = normalizeRestoredItems(parsed.items)
        // 再备份：恢复是覆盖式写入，必须先留一条回滚通道（B2 崩溃/误删场景唯一的自救口）
        const backupPath = join(dataDir, `memory.jsonl.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        try {
          await fs.mkdir(dataDir, { recursive: true })
          let rawCurrent = ''
          try {
            rawCurrent = await fs.readFile(dataFile, 'utf8')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          }
          await fs.writeFile(backupPath, rawCurrent, 'utf8')
        } catch (err) {
          return { kind: 'error', text: `恢复中止：备份当前记忆库失败（${String(err instanceof Error ? err.message : err)}），记忆库未改动。` }
        }
        try {
          const outcome = await withLock(() => withConflictRetry(async () => {
            const items = await readItems()
            let overwritten = 0
            let added = 0
            for (const item of incoming) {
              const idx = items.findIndex((entry) => entry.scope === item.scope && entry.key === item.key)
              if (idx >= 0) { items[idx] = item; overwritten++ } else { items.push(item); added++ }
            }
            // 空 items 的导出文件不做任何删除：恢复只覆盖/新增，绝不清库
            if (incoming.length > 0) await writeItems(items)
            return { total: items.length, overwritten, added }
          }))
          return {
            kind: 'success',
            text: `已从 ${srcPath} 恢复：新增 ${outcome.added} 条、覆盖 ${outcome.overwritten} 条，当前共 ${outcome.total} 条`
              + (skipped > 0 ? `（跳过结构非法的 ${skipped} 条）` : '')
              + `\n原记忆库已备份到：${backupPath}`
              + `\n如需回滚：把该备份文件复制回 ${dataFile} 即可（恢复只做覆盖/新增，不会删除库中其它条目）。`,
          }
        } catch (err) {
          return { kind: 'error', text: `恢复失败：${String(err instanceof Error ? err.message : err)}。原记忆库已备份到 ${backupPath}，复制回去即可回滚。` }
        }
      }
      case 'panel': {
        const items = await withLock(async () => readItems())
        const safe = items.filter((i) => !i.key.startsWith('auth.')).map((i) => ({ scope: i.scope, key: i.key, value: sanitizeValue(i.value), tags: i.tags, updatedAt: i.updatedAt }))
        // m8：写到 dataDir 而非 process.cwd()（host 进程目录，用户不会去那里找，
        // 且可能是只读目录导致命令直接抛错）
        const outPath = join(dataDir, `memory-panel-${new Date().toISOString().slice(0, 10)}.html`)
        try {
          await fs.mkdir(dataDir, { recursive: true })
          await fs.writeFile(outPath, buildPanelHtml(safe), 'utf8')
        } catch (err) {
          return { kind: 'error', text: '生成面板失败：' + String(err instanceof Error ? err.message : err) }
        }
        return { kind: 'success', text: `已生成记忆面板：${outPath}\n浏览器打开即可浏览/搜索全部记忆（auth.* 凭据已排除）。` }
      }
      default:
        return { kind: 'error', text: USAGE }
    }
  }
}
