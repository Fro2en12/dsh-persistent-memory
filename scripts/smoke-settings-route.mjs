#!/usr/bin/env node
// T16（第五轮）：设置路由信任围栏的真机冒烟——默认不执行，需显式 --run-e2e。
//
// 用法：
//   node scripts/smoke-settings-route.mjs --run-e2e [--base=http://127.0.0.1:3080]
//
// 安全性：本脚本只发「预期被拒绝」的请求 + 一个只读 GET，**不会**发送合法的 save POST，
// 因此不会改动你的设置或记忆库。合法请求 200 的那一条请按交付文档的清单手动验证。
import http from 'node:http'

const args = process.argv.slice(2)
if (!args.includes('--run-e2e')) {
  console.log('[skip] 真机冒烟脚本默认不执行。用法：node scripts/smoke-settings-route.mjs --run-e2e [--base=http://127.0.0.1:3080]')
  process.exit(0)
}
const baseArg = args.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:3080'
const base = new URL(baseArg.slice('--base='.length))
const route = '/_dsh/dsh-persistent-memory/settings'

function request({ method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: base.hostname,
      port: base.port || 80,
      method,
      path: route,
      headers,
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data.slice(0, 200) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const localHost = base.host
const cases = [
  {
    name: '合法只读 GET（本机 Host，无 Origin）',
    req: { method: 'GET', headers: { host: localHost } },
    expect: (s) => s === 200,
    expectText: '200',
  },
  {
    name: 'DNS rebinding：伪造 Host（GET）',
    req: { method: 'GET', headers: { host: 'evil.example' } },
    expect: (s) => s === 403,
    expectText: '403',
  },
  {
    name: 'CSRF：跨站 Origin + text/plain POST',
    req: {
      method: 'POST',
      headers: { host: localHost, origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ action: 'save', expectedRevision: 0, value: {} }),
    },
    expect: (s) => s === 403 || s === 415,
    expectText: '403 或 415',
  },
  {
    name: 'Sec-Fetch-Site: cross-site',
    req: { method: 'GET', headers: { host: localHost, 'sec-fetch-site': 'cross-site' } },
    expect: (s) => s === 403,
    expectText: '403',
  },
  {
    name: '非 JSON Content-Type 的 POST（无 Origin 也挡）',
    req: {
      method: 'POST',
      headers: { host: localHost, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=save',
    },
    expect: (s) => s === 415,
    expectText: '415',
  },
]

let failed = 0
for (const item of cases) {
  try {
    const res = await request(item.req)
    const ok = item.expect(res.status)
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${item.name} → 实测 ${res.status}（期望 ${item.expectText}）`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${item.name} → 请求失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log(`\n共 ${cases.length} 项，失败 ${failed} 项。`)
console.log('提醒：合法 save POST 的 200 分支未在脚本内验证（会改设置），请按交付文档清单手动确认。')
process.exit(failed === 0 ? 0 : 1)
