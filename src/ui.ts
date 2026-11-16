/**
 * 设置页挂载：静态页 /dsh-rss-news-browser-fetch/ + /api/* JSON 端点。
 * 与主插件同一套 webServer 路由惯例（kind: exact|prefix + sameSite 防护）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BrowserFetchService } from './service.js'
import type { LogSink } from './types.js'

const BASE = '/dsh-rss-news-browser-fetch'

interface Req {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  on(ev: string, cb: (c?: unknown) => void): void
}
interface Res {
  statusCode: number
  setHeader(k: string, v: string): void
  end(b?: string): void
}
interface WebServerLike {
  register(opts: { kind: string; path: string; handler: (req: Req, res: Res) => void }): () => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function sendJson(res: Res, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function readBody(req: Req, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: unknown) => {
      const buf = c as Buffer
      size += buf.length
      if (size > limit) { reject(new Error('body too large')); return }
      chunks.push(buf)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

/** 同源防护：拒绝 cross-site 请求（设置页只服务本实例页面）。 */
function sameSite(req: Req): boolean {
  const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase()
  return site !== 'cross-site'
}

async function serveStatic(res: Res, rel: string): Promise<void> {
  const webDir = join(fileURLToPath(new URL('.', import.meta.url)), 'web')
  const safe = rel.split('?')[0].replace(/^\/+|\.{2,}/g, '') || 'index.html'
  const file = join(webDir, safe)
  try {
    const body = await readFile(file)
    res.statusCode = 200
    res.setHeader('content-type', MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream')
    res.end(body as unknown as string)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}

/** 注册设置页全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export function mountUi(ws: WebServerLike, svc: BrowserFetchService, log: LogSink): () => void {
  const disposers: Array<() => void> = []
  const guard = (fn: (req: Req, res: Res) => void | Promise<void>) => (req: Req, res: Res): Promise<void> => {
    if (!sameSite(req)) { res.statusCode = 403; res.end('forbidden'); return Promise.resolve() }
    return Promise.resolve(fn(req, res)).catch((e) => sendJson(res, 500, { ok: false, error: String((e as Error).message || e) }))
  }
  const post = (fn: (body: Record<string, unknown>) => unknown | Promise<unknown>) => guard(async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
    const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>
    sendJson(res, 200, { ok: true, result: await fn(body) })
  })

  // 静态页
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/`, handler: guard((_q, r) => serveStatic(r, 'index.html')) }))
  disposers.push(ws.register({ kind: 'exact', path: BASE, handler: guard((_q, r) => serveStatic(r, 'index.html')) }))
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/web`, handler: guard((q, r) => serveStatic(r, (q.url || '').replace(`${BASE}/web/`, ''))) }))

  // JSON API
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/status`, handler: guard((_q, r) => sendJson(r, 200, svc.status())) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/open`, handler: post(async (b) => svc.openWindow(typeof b.url === 'string' ? b.url : undefined)) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/clear`, handler: post(async () => { await svc.clearAllData(); return 'cleared' }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/resume`, handler: post(async () => { svc.resume(); return 'resumed' }) }))

  log.info('browser-fetch settings page mounted')
  return () => { for (const d of disposers) d() }
}
