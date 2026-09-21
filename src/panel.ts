/**
 * 记忆面板 + 设置面板（第 2 批拆分；原 index.ts apply() 闭包）。
 *
 * - buildPanelHtml：/memory panel 用的自包含 HTML（数据内嵌 JSON，纯函数，无闭包依赖）；
 * - registerPanel：settings 面板注册（官方契约：inject 声明 settings 强制依赖，apply 内直接
 *   register；面板只写 runtime）+ settings 后端路由（webServer 可选服务 + exact 路由 +
 *   localhost-only 信任围栏）。
 *
 * 时机：registerPanel 在 apply() 末尾调用，与拆分前 settings 注册 / web 路由的位置一致。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'
import type { MemoryDeps } from './deps.js'

// 自包含 HTML 记忆面板（v0.1.9）：浏览器打开即用，数据内嵌 JSON，支持搜索
export function buildPanelHtml(items: { scope: string; key: string; value: string; tags: string[]; updatedAt: string }[]): string {
  const data = JSON.stringify(items).replace(/</g, '\\u003c')
  const css = 'body{font-family:system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#222}input{width:100%;padding:8px 10px;font-size:15px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px}.item{border:1px solid #e0e0e0;border-radius:8px;padding:10px 14px;margin:10px 0}.key{font-weight:600}.meta{color:#999;font-size:12px;margin-left:8px}.tag{background:#eef2ff;border-radius:4px;padding:1px 6px;font-size:12px;margin-right:4px;color:#334}'
  const js = [
    'const ITEMS = ' + data + ';',
    `const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));`,
    `function render(){const q=document.getElementById('q').value.toLowerCase();const list=ITEMS.filter((i)=>!q||(i.key+' '+i.value+' '+i.tags.join(' ')).toLowerCase().includes(q));document.getElementById('count').textContent='共 '+ITEMS.length+' 条（不含 auth.*）';document.getElementById('list').innerHTML=list.map((i)=>'<div class="item"><div><span class="key">'+esc(i.scope+'/'+i.key)+'</span><span class="meta">'+esc(i.updatedAt.slice(0,10))+'</span>'+i.tags.map((t)=>'<span class="tag">'+esc(t)+'</span>').join('')+'</div><div>'+esc(i.value)+'</div></div>').join('');}`,
    `document.getElementById('q').addEventListener('input',render);render();`,
  ].join('\n')
  return '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 记忆面板</title><style>' + css + '</style></head><body><h2>DSH 记忆面板</h2><p id="count"></p><input id="q" placeholder="搜索 key / 内容 / 标签…"><div id="list"></div><script>' + js + '</script></body></html>'
}

export function registerPanel(ctx: Context, deps: MemoryDeps): void {
  const { dataDir, runtime } = deps

  // settings 面板（v0.1.10）：官方契约——inject 声明 'settings' 强制依赖，apply 内直接 register。
  // register 挂插件 fiber、describe() 供配置 UI 渲染；结果写文件日志便于诊断（不依赖 web 日志重定向）。
  const panelLogFile = join(dataDir, 'settings-panel.log')
  const panelLog = (msg: string) => {
    void fs.appendFile(panelLogFile, `[${new Date().toISOString()}] ${msg}\n`).catch(() => { /* 日志失败不影响插件 */ })
  }
  try {
    const settingsEntry: Record<string, boolean> = {
      autoRecall: runtime.autoRecall,
      autoCapture: runtime.autoCapture,
      autoRecallRerank: runtime.autoRecallRerank,
      rrfRecall: runtime.rrfRecall,
      rrfFirstTurnOnly: runtime.rrfFirstTurnOnly,
      approveOnSet: runtime.approveOnSet,
    }
    const settingsSvc = ctx as unknown as {
      settings: {
        register: (ns: string, schema: unknown, opts: { base?: Record<string, unknown>; applies?: string }) => {
          get: () => Record<string, unknown>
          watch: (fn: (next: Record<string, unknown>) => void) => void
        }
      }
    }
    const panelShape = {
      autoRecall: z.boolean().default(true),
      autoCapture: z.boolean().default(true),
      autoRecallRerank: z.boolean().default(true),
      rrfRecall: z.boolean().default(true),
      rrfFirstTurnOnly: z.boolean().default(true),
      approveOnSet: z.boolean().default(false),
    }
    const scope = settingsSvc.settings.register('dsh-persistent-memory', z.object(panelShape), { base: settingsEntry, applies: 'live' })
    const applyPanel = (next?: Record<string, unknown>) => {
      const v = next ?? scope.get()
      runtime.autoRecall = Boolean(v.autoRecall)
      runtime.autoCapture = Boolean(v.autoCapture)
      runtime.autoRecallRerank = Boolean(v.autoRecallRerank)
      runtime.rrfRecall = Boolean(v.rrfRecall)
      runtime.rrfFirstTurnOnly = Boolean(v.rrfFirstTurnOnly)
      runtime.approveOnSet = Boolean(v.approveOnSet)
    }
    scope.watch((next) => applyPanel(next))
    applyPanel()
    // M13：字段数动态取自 schema 键数，杜绝 host/client/日志三方漂移
    panelLog('settings panel registered: ns=dsh-persistent-memory fields=' + Object.keys(panelShape).length + ' applies=live')
  } catch (err) {
    panelLog('settings panel register FAILED: ' + String(err instanceof Error ? (err.stack || err.message) : err))
  }

  // settings 面板后端路由（v0.1.13）：浏览器组件经同源 fetch 读写本命名空间
  // 模式照 dsh-email：webServer 可选服务 + exact 路由 + localhost-only 访问
  ctx.inject(['webServer'], (webCtx) => {
    const wctx = webCtx as unknown as {
      webServer: { register: (opts: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => () => void }
      effect: (fn: () => (() => void) | void, name?: string) => void
    }
    wctx.effect(() => {
      const NS = 'dsh-persistent-memory'
      const ROUTE = '/_dsh/dsh-persistent-memory/settings'
      const svc = ctx as unknown as {
        settings: {
          describe: () => { ns: string; revision?: number; applies?: string }[]
          get: (ns: string) => unknown
          replace: (ns: string, section: unknown, expectedRevision?: number) => Promise<void>
          writable?: boolean
        }
      }
      const respond = (res: { setHeader: (a: string, b: string) => void; writeHead: (n: number) => void; end: (d: unknown) => void }, status: number, body: unknown) => {
        const bytes = Buffer.from(JSON.stringify(body))
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', String(bytes.length))
        res.setHeader('Cache-Control', 'no-store')
        res.writeHead(status)
        res.end(bytes)
      }
      // C2 信任围栏（v0.1.23）：remoteAddress 本机 + Host 白名单（防 DNS rebinding）+
      // Sec-Fetch-Site/Origin 校验（防 CSRF）+ 强制 JSON Content-Type（逼跨源进 preflight）。
      const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])
      const headerOf = (req: any, name: string): string => {
        const v = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()]
        return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
      }
      const hostnameOf = (host: string): string => {
        const m = /^\[([^\]]+)\](?::\d+)?$/.exec(host.trim())
        if (m) return m[1].toLowerCase()
        return host.trim().split(':')[0].toLowerCase()
      }
      const handler = async (req: any, res: unknown) => {
        const rr = res as { setHeader: (a: string, b: string) => void; writeHead: (n: number) => void; end: (d: unknown) => void }
        const remote = String(req.socket?.remoteAddress ?? '')
        if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
          respond(rr, 403, { ok: false, error: { code: 'forbidden', message: 'dsh-persistent-memory settings route is localhost-only' } })
          return
        }
        // 长期路径：与 /api 共用 DSH 官方信任围栏（connection.requestRejection，isTrustedApiRequest）
        try {
          const conn = ctx.get('connection') as { requestRejection?: (r: unknown) => unknown } | undefined
          if (conn?.requestRejection?.(req)) {
            respond(rr, 403, { ok: false, error: { code: 'forbidden', message: 'rejected by connection trust fence' } })
            return
          }
        } catch { /* 无 connection 服务时继续本地围栏 */ }
        // Host 围栏（防 DNS rebinding 读取与写入）
        const host = headerOf(req, 'host')
        if (!host || !LOOPBACK_HOSTS.has(hostnameOf(host))) {
          respond(rr, 403, { ok: false, error: { code: 'forbidden', message: 'host must be 127.0.0.1 / [::1] / localhost' } })
          return
        }
        // Sec-Fetch-Site / Origin 围栏（防 CSRF 盲写与跨站读取）
        if (headerOf(req, 'sec-fetch-site').toLowerCase() === 'cross-site') {
          respond(rr, 403, { ok: false, error: { code: 'forbidden', message: 'cross-site requests are not allowed' } })
          return
        }
        const origin = headerOf(req, 'origin')
        if (origin) {
          let originUrl: URL
          try { originUrl = new URL(origin) } catch {
            respond(rr, 403, { ok: false, error: { code: 'forbidden', message: 'invalid origin' } })
            return
          }
          if (!LOOPBACK_HOSTS.has(hostnameOf(originUrl.host)) || originUrl.host !== host) {
            respond(rr, 403, { ok: false, error: { code: 'forbidden', message: 'origin must match the local authority' } })
            return
          }
        }
        if (req.method === 'POST') {
          // 强制 JSON Content-Type：所有跨源请求都带非 JSON 类型 → 必须走 preflight 被 CORS 拒绝
          const ct = headerOf(req, 'content-type')
          if (!/^application\/json/.test(ct)) {
            respond(rr, 415, { ok: false, error: { code: 'unsupported-media-type', message: 'application/json required' } })
            return
          }
        }
        if (req.method === 'GET') {
          try {
            const descriptor = svc.settings.describe().find((row) => row.ns === NS)
            respond(rr, 200, {
              ok: true,
              value: {
                settings: { value: svc.settings.get(NS), revision: descriptor?.revision ?? 0, applies: descriptor?.applies ?? 'live' },
                writable: svc.settings.writable !== false,
              },
            })
          } catch (err) {
            respond(rr, 503, { ok: false, error: { code: 'unavailable', message: String(err) } })
          }
          return
        }
        if (req.method !== 'POST') {
          rr.setHeader('Allow', 'GET, POST')
          respond(rr, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } })
          return
        }
        let body: { action?: string; value?: unknown; expectedRevision?: number }
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (chunks.reduce((n, c) => n + c.length, 0) + part.length > 256 * 1024) throw new RangeError('request body too large')
            chunks.push(part)
          }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (err) {
          respond(rr, 400, { ok: false, error: { code: 'invalid-request', message: String(err) } })
          return
        }
        try {
          if (body?.action === 'save') {
            if (!Number.isSafeInteger(body.expectedRevision)) throw new Error('expectedRevision must be a non-negative integer')
            await svc.settings.replace(NS, body.value, body.expectedRevision)
            const descriptor = svc.settings.describe().find((row) => row.ns === NS)
            respond(rr, 200, { ok: true, value: { settings: { value: svc.settings.get(NS), revision: descriptor?.revision ?? 0, applies: descriptor?.applies ?? 'live' } } })
          } else {
            respond(rr, 400, { ok: false, error: { code: 'invalid-request', message: 'unsupported action' } })
          }
        } catch (err) {
          const conflict = (err as { code?: string })?.code === 'SETTINGS_CONFLICT'
          respond(rr, conflict ? 409 : 400, { ok: false, error: { code: conflict ? 'settings-conflict' : 'rejected', message: String(err) } })
        }
      }
      const dispose = wctx.webServer.register({ kind: 'exact', path: ROUTE, handler: handler as unknown as (req: unknown, res: unknown) => void })
      return dispose
    }, 'dsh-persistent-memory: settings route')
  })
}
