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
  headers?: Record<string, string>
  body?: string
  credentials?: 'omit' | 'same-origin' | 'include'
  referrer?: string
}

export interface BrowserFetchResult {
  status: number
  body: string
}

export class BrowserFetchService extends Service {
  readonly apiVersion = 1

  private readonly log: LogSink
  private readonly dataDir: string
  private readonly inst: ChromeInstance
  private readonly pool: TabPool
  private readonly callers = new Map<string, string[]>() // caller → domains（审计）
  private readonly declared = new Set<string>()          // 域并集白名单
  private readonly authDomains = new Set<string>()       // auth-required 标记
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor(ctx: Context, opts: { dataDir: string; log: LogSink }) {
    super(ctx, 'browserFetch')
    this.log = opts.log
    this.dataDir = opts.dataDir
    this.inst = new ChromeInstance({ dataDir: opts.dataDir, log: opts.log })
    this.pool = new TabPool(this.inst, opts.log)
    // 巡检：5min 一轮，修复幂等；用 ctx.effect 挂卸载清理
    this.sweepTimer = setInterval(() => void this.pool.sweep(), 5 * 60_000)
    this.sweepTimer.unref?.()
    ctx.effect(() => () => this.dispose(), 'browser-fetch dispose')
  }

  /** 调用方先声明域——只放行声明过的域（及子域）。 */
  declareDomains(caller: string, domains: string[]): void {
    const clean = domains.map((d) => d.trim().toLowerCase()).filter(Boolean)
    this.callers.set(caller, [...(this.callers.get(caller) ?? []), ...clean])
    for (const d of clean) this.declared.add(d)
  }

  /** url 的 hostname 必须是已声明域或其子域——白名单唯一防线。 */
  private assertAllowed(domain: string, url: string): void {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { throw new Error(`browserFetch: bad url ${url}`) }
    const d = domain.toLowerCase()
    if (!this.declared.has(d)) throw new Error(`browserFetch: domain "${domain}" not declared (call declareDomains first)`)
    if (host !== d && !host.endsWith(`.${d}`)) {
      throw new Error(`browserFetch: url host "${host}" is outside declared domain "${d}"`)
    }
  }

  /** 域的轻量同源页内执行 fetch。实例未启动时懒拉起。 */
  async fetch(domain: string, url: string, init?: BrowserFetchInit): Promise<BrowserFetchResult> {
    this.assertAllowed(domain, url)
    const r = await this.pool.pageFetch(domain, url, init)
    return { status: r.status, body: r.body }
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
    try {
      if (url) { this.assertAllowed(domain, url); await this.pool.openPage(url) }
      else await this.pool.activate(domain)
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

/** 设置页 URL 输入消毒：空 → about:blank；只放行 http(s)/about:*；其余协议（javascript:/file:/data:）拒绝。 */
function sanitizeOpenUrl(url?: string): string {
  const u = (url ?? '').trim()
  if (!u) return 'about:blank'
  if (u === 'about:blank') return u
  if (/^https?:\/\//i.test(u)) return u
  throw new Error(`只允许 http(s) 或 about:blank：${u}`)
}
