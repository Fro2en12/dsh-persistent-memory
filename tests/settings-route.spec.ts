import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { cleanTempDir, makeFakeCtx, makeTempDir } from './helpers'

// C2：设置路由信任围栏——强制 JSON Content-Type（415）+ Host 围栏 + Origin/Sec-Fetch-Site（403）

const tmpDirs: string[] = []
function setup() {
  const dir = makeTempDir()
  tmpDirs.push(dir)
  const fake = makeFakeCtx()
  apply(fake.ctx, { dataDir: dir, defaultScope: 'global', autoRecall: false, autoCapture: false, autoExtract: false })
  const route = fake.routes.find((r) => r.path === '/_dsh/dsh-persistent-memory/settings')
  expect(route).toBeTruthy()
  return { fake, dir, handler: route.handler }
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) cleanTempDir(d)
})

function makeReq(overrides: Record<string, unknown> = {}) {
  const headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:3080',
    ...((overrides.headers as Record<string, string> | undefined) ?? {}),
  }
  const req: any = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
    headers,
  }
  return req
}
function makeBodyReq(body: string, overrides: Record<string, unknown> = {}) {
  const req = makeReq(overrides)
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(body) }
  return req
}
function makeRes() {
  const res: any = {
    status: 0,
    body: '',
    headers: {},
    setHeader(k: string, v: string) { this.headers[k] = v },
    writeHead(s: number) { this.status = s },
    end(d: unknown) { this.body = String(d) },
  }
  return res
}

const SAVE_BODY = JSON.stringify({
  action: 'save',
  expectedRevision: 0,
  value: { autoRecall: false, autoCapture: true, autoRecallRerank: true, rrfRecall: true, rrfFirstTurnOnly: true, approveOnSet: false },
})

describe('C2 设置路由信任围栏', () => {
  it('跨站 Origin + text/plain POST → 403/415（当前返回 200 并落盘）', async () => {
    const { handler } = setup()
    const req = makeBodyReq(SAVE_BODY, { headers: { 'content-type': 'text/plain', origin: 'https://evil.example' } })
    const res = makeRes()
    await handler(req, res)
    expect([403, 415]).toContain(res.status)
  })

  it('Sec-Fetch-Site: cross-site → 403', async () => {
    const { handler } = setup()
    const req = makeBodyReq(SAVE_BODY, { headers: { 'sec-fetch-site': 'cross-site' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.status).toBe(403)
  })

  it('伪造 Host（DNS rebinding）→ 403', async () => {
    const { handler } = setup()
    const req = makeBodyReq(SAVE_BODY, { headers: { host: 'evil.example' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.status).toBe(403)
  })

  it('GET 伪造 Host → 403（读取面同样受保护）', async () => {
    const { handler } = setup()
    const req = makeReq({ method: 'GET', headers: { host: 'evil.example' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.status).toBe(403)
  })

  it('本机合法 POST（application/json + 本机 Host + 无 Origin）→ 200 并生效', async () => {
    const { handler, fake } = setup()
    const req = makeBodyReq(SAVE_BODY)
    const res = makeRes()
    await handler(req, res)
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.settings.value.autoRecall).toBe(false)
  })

  it('本机合法 GET → 200', async () => {
    const { handler } = setup()
    const req = makeReq({ method: 'GET' })
    const res = makeRes()
    await handler(req, res)
    expect(res.status).toBe(200)
  })

  it('Origin 与本机 authority 一致 → 放行', async () => {
    const { handler } = setup()
    const req = makeBodyReq(SAVE_BODY, { headers: { origin: 'http://127.0.0.1:3080' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.status).toBe(200)
  })

  it('Origin 指向外部（即使 Host 头正常）→ 403', async () => {
    const { handler } = setup()
    const req = makeBodyReq(SAVE_BODY, { headers: { origin: 'https://evil.example' } })
    const res = makeRes()
    await handler(req, res)
    expect(res.status).toBe(403)
  })
})
