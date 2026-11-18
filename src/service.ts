/**
 * browserFetch 服务（公开 API 面，进 semver）：
 *   declareDomains(caller, domains)  声明式域白名单——只放行声明过的域，意图显式可审计
 *   fetch(domain, url, init?)        唯一抓取面：在域的轻量同源页内执行 fetch（不暴露裸 evaluate）
 *   authRequired(domain) / openForAuth(domain) / markAuthRequired(domain)
 *   status()                         实例/域/暂停状态展示
 *
 * 语义边界：caller 自报（审计用）；域名单是并集共享——A 包声明的域 B 包也能 fetch；
 * init 经 Runtime.evaluate 序列化，只支持 JSON-safe 子集（method/headers/body/credentials）。
 */

import { rm } from 'node:fs/promises'

import { Context, Service } from '@deepseek-ai/cordis'

import { ChromeInstance } from './instance.js'
import { TabPool, lightPageFor } from './tabs.js'
import type { LogSink } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserFetch: BrowserFetchService
  }
}

export interface BrowserFetchInit {
  method?: string
  headers?: Record<string, string> | Headers | [string, string][]
  body?: string
  credentials?: 'omit' | 'same-origin' | 'include'
  referrer?: string
}

const KNOWN_INIT_KEYS = new Set(['method', 'headers', 'body', 'credentials', 'referrer'])

/** init 归一化（导出供测试）：Headers 实例/键值对数组 → plain object；不认识的 key、
 *  非 string 值显式报错——JSON.stringify 会把 Headers、AbortSignal 之类静默序列化成
 *  {}，字段被吞后 fetch 行为漂移且难排查。 */
export function normalizeInit(init?: BrowserFetchInit): Record<string, unknown> {
  if (init == null) return {}
  if (typeof init !== 'object') throw new Error('browserFetch: init must be an object')
  for (const k of Object.keys(init)) {
    if (!KNOWN_INIT_KEYS.has(k)) {
      throw new Error(`browserFetch: init.${k} not supported (page-side fetch takes a JSON-safe subset: method/headers/body/credentials/referrer)`)
    }
  }
  const out: Record<string, unknown> = {}
  if (init.method != null) out.method = String(init.method)
  if (init.credentials != null) out.credentials = init.credentials
  if (init.referrer != null) out.referrer = String(init.referrer)
  if (init.body != null) {
    if (typeof init.body !== 'string') throw new Error('browserFetch: init.body must be a string (page-side serialization limit)')
    out.body = init.body
  }
  if (init.headers != null) {
    const h: Record<string, string> = {}
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => { h[k] = v })
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) h[k] = v
    } else if (typeof init.headers === 'object') {
      for (const [k, v] of Object.entries(init.headers)) {
        if (typeof v !== 'string') throw new Error(`browserFetch: init.headers.${k} must be a string`)
        h[k] = v
      }
    } else {
      throw new Error('browserFetch: init.headers must be a plain object, Headers, or [string, string][]')
    }
    out.headers = h
  }
  return out
}

export interface BrowserFetchResult {
  status: number
  body: string
}

/** 渲染抓取结果：导航到真实页面后的 outerHTML（挑战页/SPA 用），url=落地后地址。 */
export interface RenderHtmlResult {
  status: number
  html: string
  url: string
}

export class BrowserFetchService extends Service {
  readonly apiVersion = 2

  private readonly log: LogSink
  private readonly dataDir: string
  private readonly inst: ChromeInstance
  private readonly pool: TabPool
  private readonly callers = new Map<string, string[]>() // caller → domains（审计）
  private readonly declared = new Set<string>()          // 域并集白名单
  private readonly authDomains = new Set<string>()       // auth-required 标记
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor(ctx: Context, opts: { dataDir: string; log: LogSink; proxyUrl?: () => string | undefined }) {
    super(ctx, 'browserFetch')
    this.log = opts.log
    this.dataDir = opts.dataDir
    this.inst = new ChromeInstance({ dataDir: opts.dataDir, log: opts.log, proxyUrl: opts.proxyUrl })
    // auth-required 域跳过漂移修复——用户可能正在 OAuth/SSO 跨域登录流程中，
    // 此时把 tab 拽回轻量页会直接打断授权；watchdog 巡检与 ensure 的缓存修复共用这一谓词。
    this.pool = new TabPool(this.inst, opts.log, (d) => this.authDomains.has(d.toLowerCase()))
    // 巡检：5min 一轮，修复幂等；用 ctx.effect 挂卸载清理。
    this.sweepTimer = setInterval(() => void this.pool.sweep(), 5 * 60_000)
    this.sweepTimer.unref?.()
    ctx.effect(() => () => this.dispose(), 'browser-fetch dispose')
  }

  /** 调用方先声明域——只放行声明过的域（精确 host）。 */
  declareDomains(caller: string, domains: string[]): void {
    const clean = domains.map((d) => d.trim().toLowerCase()).filter(Boolean)
    for (const d of clean) validateDomainFormat(d)
    this.callers.set(caller, [...(this.callers.get(caller) ?? []), ...clean])
    for (const d of clean) this.declared.add(d)
  }

  /** url 的 hostname 必须精确等于已声明域——白名单唯一防线（纯函数实现见文件尾，导出供测试）。 */
  private assertAllowed(domain: string, url: string): void {
    checkAllowedUrl(this.declared, domain, url)
  }

  /** 域的轻量同源页内执行 fetch。实例未启动时懒拉起。 */
  async fetch(domain: string, url: string, init?: BrowserFetchInit): Promise<BrowserFetchResult> {
    const d = domain.trim().toLowerCase()
    this.assertAllowed(d, url)
    const r = await this.pool.pageFetch(d, url, normalizeInit(init))
    return { status: r.status, body: r.body }
  }

  /**
   * 渲染档抓取：在域 tab 里真导航到 url，等 readyState=complete + waitMs 稳定后
   * 返回 outerHTML。与 fetch 同一域白名单；不暴露裸 evaluate——返回值只有 DOM 文本。
   * JS 挑战页/SPA 专用档（node fetch 拿到空壳或验证页时升级上来）。
   */
  async renderHtml(domain: string, url: string, opts?: { waitMs?: number }): Promise<RenderHtmlResult> {
    const d = domain.trim().toLowerCase()
    this.assertAllowed(d, url)
    return this.pool.renderPage(d, url, opts)
  }

  /** 某域当前是否需要用户授权（登录墙/验证码）——adapter 置位，源包据此标源状态。 */
  authRequired(domain: string): boolean {
    return this.authDomains.has(domain.toLowerCase())
  }

  /** adapter 判定登录墙/挑战页后调用；恢复后再 markAuthRequired(domain,false)。 */
  markAuthRequired(domain: string, on = true): void {
    const d = domain.toLowerCase()
    if (on) { this.authDomains.add(d); this.log.info(`domain ${d} marked auth-required`) }
    else this.authDomains.delete(d)
  }

  /** 把该域 tab 顶到前台让用户登录/过验证；返回是否成功激活。给了 url 就直接开那个授权页。 */
  async openForAuth(domain: string, url?: string): Promise<boolean> {
    const d = domain.trim().toLowerCase()
    try {
      if (url) { this.assertAllowed(d, url); await this.pool.openPage(url) }
      else await this.pool.activate(d)
      return true
    } catch (e) {
      this.log.warn(`openForAuth(${domain}) failed: ${(e as Error).message}`)
      return false
    }
  }

  /** 用户连关后手动恢复实例。 */
  resume(): void {
    this.inst.resume()
  }

  /** 设置页「打开 Chrome」：实例未起则带 URL 冷启动，已起则前台开 tab。空值开 about:blank。 */
  async openWindow(url?: string): Promise<string> {
    const target = sanitizeOpenUrl(url)
    if (this.inst.paused) this.inst.resume()
    await this.pool.openPage(target)
    return target
  }

  /** 设置页「清除所有数据」：杀实例 + 删整个数据目录（profile cookie/缓存/声明状态全清）。 */
  async clearAllData(): Promise<void> {
    await this.pool.close()
    await this.inst.stop()
    this.callers.clear()
    this.declared.clear()
    this.authDomains.clear()
    await rm(this.dataDir, { recursive: true, force: true })
    this.log.info(`all browser-fetch data cleared (${this.dataDir})`)
  }

  status(): { available: boolean; running: boolean; paused: boolean; domains: string[]; tabs: string[]; authRequired: string[]; binary?: string; dataDir: string } {
    return {
      available: this.inst.available,
      running: this.inst.running,
      paused: this.inst.paused,
      domains: [...this.declared],
      tabs: this.pool.domains(),
      authRequired: [...this.authDomains],
      binary: this.inst.binaryPath,
      dataDir: this.dataDir,
    }
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined }
    await this.pool.close()
    await this.inst.stop()
  }
}

/** 域白名单校验：domain 须先声明；url 的 host 须精确等于声明域，且必须 https。
 *  页面 origin 就是 domain 本身——子域 fetch 本来就过不了 CORS，放行只会把
 *  「清晰报错」换成「莫名 CORS 失败」；http 则是 https 页面里的混合内容，必被浏览器拦。 */
export function checkAllowedUrl(declared: ReadonlySet<string>, domain: string, url: string): void {
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`browserFetch: bad url ${url}`) }
  const host = u.hostname.toLowerCase()
  const d = domain.toLowerCase()
  if (!declared.has(d)) throw new Error(`browserFetch: domain "${domain}" not declared (call declareDomains first)`)
  if (host !== d) {
    throw new Error(`browserFetch: url host "${host}" != declared domain "${d}" (declare the API host itself; page fetch is same-origin only)`)
  }
  if (u.protocol !== 'https:') {
    throw new Error(`browserFetch: only https:// urls are fetchable (light page origin is https://${d}; http:// is blocked as mixed content)`)
  }
}

/** 域格式校验（导出供测试）：只收纯 host。带 scheme/端口/路径的声明在 checkAllowedUrl 的
 *  hostname 语义下永不匹配（URL.hostname 不含端口），提前拒绝给出清晰报错。 */
export function validateDomainFormat(domain: string): void {
  const d = domain.trim().toLowerCase()
  const ok = /^\[[0-9a-f:.]+\]$/.test(d) // IPv6 字面量
    || (/^[a-z0-9._-]+$/.test(d)
      && !d.startsWith('.') && !d.endsWith('.') && !d.includes('..'))
  if (!ok) throw new Error(`browserFetch: invalid domain "${domain}" — declare a bare hostname like "api.example.com" (no scheme/port/path)`)
}

/** 设置页 URL 输入消毒：空 → about:blank；只放行 http(s)/about:*；其余协议（javascript:/file:/data:）拒绝。 */
export function sanitizeOpenUrl(url?: string): string {
  const u = (url ?? '').trim()
  if (!u) return 'about:blank'
  if (u === 'about:blank') return u
  if (/^https?:\/\//i.test(u)) return u
  throw new Error(`只允许 http(s) 或 about:blank：${u}`)
}
