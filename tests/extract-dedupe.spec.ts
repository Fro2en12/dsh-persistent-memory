import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// M4：轮末提取器复用 upsertMemory 去重（key 漂移不再让库单调膨胀）+ 库容量软上限

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

function feedTurn(fake: any, sid: string, text: string) {
  const session = { id: sid }
  const onEvent = fake.handlers.get('session/event')[0]
  const onTurn = fake.handlers.get('agent/turn-stopping')[0]
  onEvent(session, { type: 'turn/start' })
  onEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text }] } })
  onTurn({ agent: { session: { id: sid, header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } })
}

async function waitFile(dir: string, predicate: (raw: string) => boolean, ms = 2000): Promise<string> {
  let raw = ''
  for (let i = 0; i < ms / 25; i++) {
    await new Promise((r) => setTimeout(r, 25))
    try { raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8') } catch { raw = '' }
    if (predicate(raw)) return raw
  }
  return raw
}

/** 等待插件日志出现某个片段（fake logger 是同步 push 的数组）。用作「异步流程已跑完」的完成锚。 */
async function waitLog(fake: any, needle: string, ms = 2000): Promise<boolean> {
  const hit = () => (fake.logs as Array<{ message: string }>).some((l) => String(l.message).includes(needle))
  for (let i = 0; i < Math.max(1, ms / 25); i++) {
    if (hit()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return hit()
}

/** 解析 memory.jsonl 里的条目（跳过 schema 哨兵行与空行） */
function parseItems(dir: string): any[] {
  return readFileSync(join(dir, 'memory.jsonl'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((x: any) => typeof x?.key === 'string')
}

/**
 * H7b 落盘探针：writeItems（src/store.ts:443）每次写盘前都会 copyFile(memory.jsonl → memory.jsonl.bak)，
 * 所以 .bak 的「内容 + mtime」就是「这一轮到底有没有真的写过盘」的可观测证据，且不依赖 updatedAt。
 * 选内容为主判据（时钟无关，NTFS/粗粒度时间戳都影响不到），mtime 为辅（多一道独立信号）。
 */
function bakSnapshot(dir: string): { content: string; mtimeMs: number } | null {
  try {
    return { content: readFileSync(join(dir, 'memory.jsonl.bak'), 'utf8'), mtimeMs: statSync(join(dir, 'memory.jsonl.bak')).mtimeMs }
  } catch {
    return null
  }
}

const stats = async (fake: any) => fake.toolDefs.get('memory_stats').execute({})

describe('M4 提取器去重', () => {
  it('同一会话库内顺序提取 3 个等价 key → 合并为 1 条', async () => {
    const llmBox = { text: '' }
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: llmBox.text } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    const cands = ['env.node-version', 'env.nodejs-version', 'tool.node-version']
    for (let i = 0; i < cands.length; i++) {
      llmBox.text = JSON.stringify({ memories: [{ key: cands[i], value: '本机 Node 版本 v26.8.1', tags: [] }] })
      const before = (await stats(fake)).total
      feedTurn(fake, 'sess-' + i, '记住这个')
      await waitFile(dir, (raw) => (raw.match(/\n/g) ?? []).length >= before + 1 || before === 0)
      await new Promise((r) => setTimeout(r, 150))
    }
    const s = await stats(fake)
    expect(s.total).toBe(1)
    const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf8')
    expect(raw.trim().split('\n').filter((l) => !l.includes('__schema'))).toHaveLength(1)   // 排除 n3 哨兵行
  })

  it('与已有条目高度相似的候选 → 更新而非新建', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const seed = [{ id: 'x', key: 'env.node-version', value: '旧描述', scope: 'global', tags: [], createdAt: now, updatedAt: now }]
    const dir = makeTempDir()
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'env.nodejs-version', value: '本机 Node 版本 v26.8.1', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-merge', '记住这个')
    await waitFile(dir, (raw) => raw.includes('v26.8.1'))
    const s = await stats(fake)
    expect(s.total).toBe(1)
    expect(readFileSync(join(dir, 'memory.jsonl'), 'utf8')).toContain('v26.8.1')
  })
})

describe('M4 库容量软上限', () => {
  function seedMany(n: number) {
    const now = '2026-09-17T00:00:00.000Z'
    return Array.from({ length: n }, (_, i) => ({
      id: 'i' + i, key: 'task.item-' + i, value: '历史条目 ' + i, scope: 'global', tags: [], createdAt: now, updatedAt: now,
    }))
  }
  it('库超 500 条时拒绝全新的低价值（非 rule/lesson）候选', async () => {
    const seed = seedMany(501)
    const dir = makeTempDir()
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'env.brand-new', value: '全新环境事实', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-cap', '记住这个')
    await new Promise((r) => setTimeout(r, 400))
    const s = await stats(fake)
    expect(s.total).toBe(501)
  })

  it('库超 500 条时 rule.* 高价值候选仍可写入', async () => {
    const seed = seedMany(501)
    const dir = makeTempDir()
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'rule.new-lesson', value: '这是新踩的坑', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-cap2', '记住这个')
    await waitFile(dir, (raw) => raw.includes('rule.new-lesson'))
    const s = await stats(fake)
    expect(s.total).toBe(502)
  })
})

// ── F6（第七轮）：提取器复用 memory_set 的 maxItems 容量守卫 ────────────────
// 缺陷态：writeExtractedMemory 完全不看 maxItems（只受 EXTRACT_LIBRARY_SOFT_CAP 软上限约束，
// 且 rule/lesson 可穿透软上限），无人值守路径能把库推到硬上限之上。
describe('F6 提取器容量守卫', () => {
  const NOW = '2026-09-17T00:00:00.000Z'
  const seedN = (n: number, extra: any[] = []) => [
    ...Array.from({ length: n }, (_, i) => ({ id: 'i' + i, key: 'task.item-' + i, value: '历史条目 ' + i, scope: 'global', tags: [], createdAt: NOW, updatedAt: NOW })),
    ...extra,
  ]
  function mkFake(dir: string, mems: any[], maxItems: number) {
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: mems }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000, maxItems })
    return fake
  }

  it('库达 maxItems 时拒绝全新候选（修复前会照写，把库推过上限）', async () => {
    const dir = makeTempDir(); tmpDirs.push(dir)
    // 库已满：5 条 = 4 条 task.* + 1 条 env.node-version
    writeFileSync(
      join(dir, 'memory.jsonl'),
      seedN(4, [{ id: 'x', key: 'env.node-version', value: '旧描述', scope: 'global', tags: [], createdAt: NOW, updatedAt: NOW }])
        .map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8',
    )
    const fake = mkFake(dir, [
      // ① 全新候选：库满（5/5）→ 必须被容量守卫拒绝。
      //    刻意排在同一次提取的第一位：提取器是顺序 await 处理候选的，因此②一旦落盘，
      //    ①的裁决必然已经做完（H5：不再靠「固定等 600ms + 纯负向断言」，那分不清
      //    「被拒绝」与「写入发生得晚一点」）。
      { key: 'env.brand-new', value: '全新环境事实', tags: [] },
      // ② 更新已有 key：容量守卫只挡新增 → 必然落盘，作为「提取器确实跑完并裁决过①」的正向锚。
      { key: 'env.node-version', value: '本机 Node v26.8.1', tags: [] },
    ], 5)
    feedTurn(fake, 'sess-cap-new', '记住这个')
    const raw = await waitFile(dir, (r) => r.includes('v26.8.1'))
    expect(raw, '正向锚缺失：更新类候选没落盘，说明提取器可能压根没跑，「拒绝」无从证明').toContain('v26.8.1')
    // 静默窗口：若「拒绝」被实现成「晚一点再写」，也会在这里被抓住
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 25))
      expect(readFileSync(join(dir, 'memory.jsonl'), 'utf8'), '超限候选不应落盘（含延迟落盘）').not.toContain('brand-new')
    }
    const items = parseItems(dir)
    expect(items.map((x: any) => x.key).sort(), '最终库内容：5 条旧条目 + ②的更新').toEqual(
      ['env.node-version', 'task.item-0', 'task.item-1', 'task.item-2', 'task.item-3'],
    )
    expect(items.find((x: any) => x.key === 'env.node-version').value, '②确实生效（不是靠整次提取不落盘换来的「没超限」）').toBe('本机 Node v26.8.1')
    expect((await stats(fake)).total, '库不应超过 maxItems').toBe(5)
  })

  it('库达 maxItems 时仍可更新已有 key（与 memory_set 同口径：只挡新增）', async () => {
    const dir = makeTempDir(); tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seedN(4, [{ id: 'x', key: 'env.node-version', value: '旧描述', scope: 'global', tags: [], createdAt: NOW, updatedAt: NOW }]).map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = mkFake(dir, [{ key: 'env.node-version', value: '本机 Node v26.8.1', tags: [] }], 5)
    feedTurn(fake, 'sess-cap-upd', '记住这个')
    await waitFile(dir, (raw) => raw.includes('v26.8.1'))
    expect(readFileSync(join(dir, 'memory.jsonl'), 'utf8')).toContain('v26.8.1')
    expect((await stats(fake)).total).toBe(5)
  })

  it('候选与旧值全等时跳过该条：不刷新 updatedAt、不触发第二次落盘（T17 在提取器路径同样成立）', async () => {
    const dir = makeTempDir(); tmpDirs.push(dir)
    const same = { id: 'x', key: 'env.node-version', value: '本机 Node v26.8.1', scope: 'global', tags: [], createdAt: NOW, updatedAt: NOW, source: '轮末提取' }
    writeFileSync(join(dir, 'memory.jsonl'), [same].map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    // 候选顺序有讲究：① 会落盘的新候选在前，② 全等候选在后。
    // 于是「最后一次落盘」若是②引起的，.bak 就会被刷成含 env.other 的版本——把注释里那句
    // 「空操作跳过整次落盘」变成可断言的落盘证据（H7b：无条件写盘时 updatedAt 与内容都不变，
    // 只断言 updatedAt 会漏掉这个变异）。
    const fake = mkFake(dir, [
      { key: 'env.other', value: '另一个环境事实', tags: [] },
      { key: 'env.node-version', value: '本机 Node v26.8.1', tags: [] },
    ], 50)
    feedTurn(fake, 'sess-cap-noop', '记住这个')
    await waitFile(dir, (raw) => raw.includes('env.other'))
    // 完成锚：extractAndWrite 只在遍历完所有候选之后才打这条日志
    // （src/index.ts:990）→ ②已被裁决过，后续对 .bak 的检查不再是「抢跑」。
    // P1-2 起摘要行改口径为「N written, M skipped」；锚点同步（原为 '[mem] extract wrote'）
  expect(await waitLog(fake, '[mem] extract:'), '提取器应当跑完并记账').toBe(true)
    const items = parseItems(dir)
    const kept = items.find((x: any) => x.key === 'env.node-version')
    expect(kept.updatedAt, '内容全等 → updatedAt 不应被刷新').toBe(NOW)
    expect(items.some((x: any) => x.key === 'env.other'), '对照组：新候选确实写入了').toBe(true)
    // 落盘探针：修复态只有①写盘 → .bak 仍是「写盘前」的版本（只有 env.node-version）；
    // 缺陷态（result.changed 被无视、②也调用 writeItems）→ .bak 被刷成含 env.other 的版本。
    const bakAtAnchor = bakSnapshot(dir)
    expect(bakAtAnchor, '.bak 是「写过盘」的探针，①落盘后必然存在').not.toBeNull()
    expect(bakAtAnchor!.content, '空操作又写了一次盘：.bak 被刷成含 env.other 的版本').not.toContain('env.other')
    await new Promise((r) => setTimeout(r, 120))   // 静默窗口：晚一点才落盘的实现也会被抓住
    const bakAfter = bakSnapshot(dir)
    expect(bakAfter!.content, '空操作不应改写 .bak').toBe(bakAtAnchor!.content)
    expect(bakAfter!.mtimeMs, '空操作不应刷新 .bak 的 mtime').toBe(bakAtAnchor!.mtimeMs)
  })
})

// ── F12（第七轮，对齐 Claude Code 的 hasMemoryWritesSince）：空操作不算「主模型写过」──
// 缺陷态：无论 changed 与否都刷新 lastManualWriteAt，于是「只是把同一条旧记忆又重申了一遍」
// 也会把轮末提取器压住 30s——而模型实际上什么都没记。
describe('F12 空操作不压制轮末提取器', () => {
  it('memory_set 写一条内容全等的旧记忆：本身不落盘，且不压制轮末提取器', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const seed = [{ id: 'x', key: 'env.node-version', value: '旧描述', scope: 'global', tags: [], createdAt: now, updatedAt: now }]
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'env.other', value: '另一个环境事实', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    const execOf = (sid: string) => ({ agent: { session: { id: sid, header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } })
    const set = (args: any, sid: string) => fake.toolDefs.get('memory_set').execute(args, execOf(sid))

    // ① 预热：先做一次「真的会落盘」的写入，让 .bak 出现并定下基线——这同时是落盘探针的正向对照。
    //    刻意换一个会话 id：memory_set 的真写入会按会话记 lastManualWriteAt(30s)，预热若记在
    //    sess-f12 上，会与 ③「提取器仍应运行」的断言互相干扰（那是另一个语义，不是本用例要测的）。
    const warm = await set({ key: 'env.baseline', value: '基线环境事实' }, 'sess-f12-warmup')
    expect(warm.changed, '前提：预热写入必须真的落盘').toBe(true)
    const bakAfterWarmup = bakSnapshot(dir)
    expect(bakAfterWarmup, '.bak 必须存在：writeItems 每次写盘都会 copyFile(memory.jsonl → .bak)').not.toBeNull()
    expect(bakAfterWarmup!.content, '落盘探针自检：.bak 是「写盘前」的版本，所以还不含刚写入的 env.baseline').not.toContain('env.baseline')
    await new Promise((r) => setTimeout(r, 60))    // 拉开时间戳，避免时钟粒度掩盖「又写了一次」

    // ② 空操作：内容与库里那条全等 → changed=false（不是一次真正的写入）
    const r = await set({ key: 'env.node-version', value: '旧描述' }, 'sess-f12')
    expect(r.changed, '前提：这次 memory_set 必须是空操作').toBe(false)
    // 落盘证据：空操作若仍然调用 writeItems，.bak 会被刷成「已含 env.baseline」的主文件当前版本；
    // 修复态下 .bak 必须原封不动（内容与 mtime 都不前进）。内容为主判据（与时钟精度无关），mtime 为辅。
    const bakAfterNoop = bakSnapshot(dir)
    expect(bakAfterNoop!.content, '空操作落盘了：.bak 被刷成主文件当前版本').toBe(bakAfterWarmup!.content)
    expect(bakAfterNoop!.content, '空操作不应产生第二次落盘').not.toContain('env.baseline')
    expect(bakAfterNoop!.mtimeMs, '空操作不应刷新 .bak 的 mtime').toBe(bakAfterWarmup!.mtimeMs)

    // ③ 空操作不算「主模型写过」→ 轮末提取器仍应照常运行
    feedTurn(fake, 'sess-f12', '记住这个')
    await waitFile(dir, (raw) => raw.includes('env.other'))
    expect(parseItems(dir).some((x: any) => x.key === 'env.other'), '空操作不应压制提取器').toBe(true)
    expect(readFileSync(join(dir, 'memory.jsonl'), 'utf8'), '空操作不应压制提取器').toContain('env.other')
  })
})

// ── 复审 P1-2：容量拒绝必须可见，且不得报成纯成功 ────────────────────────────
describe('复审 P1-2 提取器容量拒绝的可见性', () => {
  it('库达 maxItems 时：摘要行报出被丢弃数，且不得只报成功', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const seed = Array.from({ length: 5 }, (_, i) => ({ id: 'i' + i, key: 'task.item-' + i, value: '历史条目 ' + i, scope: 'global', tags: [], createdAt: now, updatedAt: now }))
    const dir = makeTempDir()
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'rule.cannot-add', value: '全新高价值教训', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000, maxItems: 5 })
    feedTurn(fake, 'sess-p12', '记住这个')
    expect(await waitLog(fake, '[mem] extract:'), '提取器跑完必须留下一条摘要（原先库满时连一条日志都没有）').toBe(true)
    const text = fake.logs.map((l: any) => l.level + ' ' + l.message).join('\n')
    expect(text, '库满与丢弃数必须出现在日志里').toMatch(/maxItems=5/)
    expect(text, '不得把被丢弃的候选报成纯成功').toMatch(/dropped/)
    expect(readFileSync(join(dir, 'memory.jsonl'), 'utf8'), '超限候选不得落盘').not.toContain('cannot-add')
  })
})

// ── 复审 P2：提取器不得覆盖用户的 source 引证 / 不得静默吞掉异常回包 ──────────
describe('复审 P2 提取器收口', () => {
  it('P2-1 合并到已有条目时保留用户写的 source，且内容全等不刷新 updatedAt', async () => {
    const now = '2026-09-17T00:00:00.000Z'
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const seed = [{ id: 'x', key: 'env.node-version', value: '本机 Node v26.8.1', scope: 'global', tags: [], createdAt: now, updatedAt: now, source: '2026-09-17 s=SEED' }]
    writeFileSync(join(dir, 'memory.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ memories: [{ key: 'env.nodejs-version', value: '本机 Node v26.8.1', tags: [] }] }) } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-p21', '记住这个')
    expect(await waitLog(fake, '[mem] extract:'), '必须留下摘要').toBe(true)
    const item = parseItems(dir).find((x: any) => x.key === 'env.node-version')
    expect(item.source, 'P2-1：用户写的引证不得被常量覆盖').toBe('2026-09-17 s=SEED')
    expect(item.updatedAt, 'P2-1：内容全等 ⇒ 不因 source 差异被判为变化').toBe(now)
  })

  it('P2-11 LLM 回包不含 JSON 时必须留下可见痕迹（不再静默返回）', async () => {
    const dir = makeTempDir()
    tmpDirs.push(dir)
    const fake = makeFakeCtx({}, {
      llm: { stream: async function* () { yield { type: 'text-delta', text: '抱歉，我无法提取。' } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: true, autoExtractCooldownMs: 30000 })
    feedTurn(fake, 'sess-p211', '记住这个')
    expect(await waitLog(fake, 'no JSON object'), 'P2-11：非 JSON 回包必须留痕').toBe(true)
  })
})
