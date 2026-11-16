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
  private readonly inst: ChromeInstance
  private readonly pool: TabPool
  private readonly callers = new Map<string, string[]>() // caller → domains（审计）
  private readonly declared = new Set<string>()          // 域并集白名单
  private readonly authDomains = new Set<string>()       // auth-required 标记
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor(ctx: Context, opts: { dataDir: string; log: LogSink }) {
    super(ctx, 'browserFetch')
    this.log = opts.log
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

  /** 把该域 tab 顶到前台让用户登录/过验证；返回是否成功激活。 */
  async openForAuth(domain: string, url?: string): Promise<boolean> {
    try {
      await this.inst.ensure(url ?? lightPageFor(domain))
      await this.pool.activate(domain)
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

  status(): { available: boolean; running: boolean; paused: boolean; domains: string[]; tabs: string[]; authRequired: string[] } {
    return {
      available: this.inst.available,
      running: this.inst.running,
      paused: this.inst.paused,
      domains: [...this.declared],
      tabs: this.pool.domains(),
      authRequired: [...this.authDomains],
    }
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined }
    await this.pool.close()
    await this.inst.stop()
  }
}
