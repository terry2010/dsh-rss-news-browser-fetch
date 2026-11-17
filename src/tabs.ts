/**
 * 域→tab 池 + 页面内 fetch：每个 API 源一个「轻量同源页」tab（默认 robots.txt），
 * fetch 在该页 Runtime.evaluate 执行——同源无 CORS、cookie/Origin 全真。
 */

import { Cdp } from './cdp.js'
import type { ChromeInstance, InstanceInfo } from './instance.js'
import type { LogSink } from './types.js'

export interface PageTab {
  targetId: string
  sessionId: string
  url: string
}

interface TargetInfo {
  targetId: string
  type: string
  url: string
}

/** 域的轻量页：API 所在源的 robots.txt（同源保证；失败时退回域根页）。 */
export function lightPageFor(domain: string): string {
  return `https://${domain}/robots.txt`
}

export class TabPool {
  private cdp?: Cdp
  private tabs = new Map<string, PageTab>() // domain → tab
  private readonly log: LogSink

  constructor(
    private readonly inst: ChromeInstance,
    log: LogSink,
  ) {
    this.log = log
  }

  /** firstUrl 只在冷启动生效——窗口首 tab 直接开目标页，不留 about:blank 空壳。 */
  private async conn(firstUrl?: string): Promise<{ cdp: Cdp; info: InstanceInfo }> {
    const info = await this.inst.ensure(firstUrl)
    if (!this.cdp || this.cdp.closed) {
      this.cdp = await Cdp.connect(info.browserWsUrl)
    }
    return { cdp: this.cdp, info }
  }

  /** 窗口显隐：worker 冷启动最小化（无声基建），用户主动操作恢复前台。best-effort，失败不阻塞。 */
  private async setWindowState(cdp: Cdp, state: 'normal' | 'minimized'): Promise<void> {
    try {
      const { targetInfos } = await cdp.call<{ targetInfos: TargetInfo[] }>('Target.getTargets')
      const page = (targetInfos ?? []).find((t) => t.type === 'page')
      if (!page) return
      const { windowId } = await cdp.call<{ windowId: number }>('Browser.getWindowForTarget', { targetId: page.targetId })
      await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: state } })
    } catch (e) {
      this.log.info(`setWindowState(${state}) ignored: ${(e as Error).message}`)
    }
  }

  /** 取/建某域的轻量页 tab，返回 attach 好的 sessionId。 */
  async ensure(domain: string): Promise<PageTab> {
    const want = lightPageFor(domain)
    const { cdp } = await this.conn(want)
    if (this.inst.consumeColdStart()) await this.setWindowState(cdp, 'minimized')
    const cached = this.tabs.get(domain)
    const { targetInfos } = await cdp.call<{ targetInfos: TargetInfo[] }>('Target.getTargets')
    const pages = (targetInfos ?? []).filter((t) => t.type === 'page')

    if (cached && pages.some((t) => t.targetId === cached.targetId)) return cached

    // 找已存在的同域 tab：冷启动时首 tab 就是轻量页（可能还在导航中），
    // 先等它落地再决定是否 createTarget，避免同 URL 双开
    let target = pages.find((t) => t.url === want || safeUrl(t.url)?.hostname === domain)
    if (!target) target = await this.waitForTarget(cdp, (t) => t.url === want || safeUrl(t.url)?.hostname === domain)
    if (!target) {
      const { targetId } = await cdp.call<{ targetId: string }>('Target.createTarget', { url: want, background: true })
      target = { targetId, type: 'page', url: want }
      await this.waitLoaded(cdp, targetId)
    }
    const { sessionId } = await cdp.call<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const tab: PageTab = { targetId: target.targetId, sessionId, url: target.url }
    // 轻量页加载失败会停在 chrome-error://（opaque origin，页面 fetch 必挂且不自愈）——
    // origin 校验不属目标域时回退到域根页兜底
    const { result } = await this.evalRaw<unknown>(sessionId, 'location.origin')
    const host = safeUrl(String(result?.value ?? ''))?.hostname
    if (host !== domain) {
      await cdp.call('Page.navigate', { url: `https://${domain}/` }, sessionId).catch(() => {})
    }
    this.tabs.set(domain, tab)
    return tab
  }

  /** 短轮询等一个满足条件的 page target 出现（冷启动首个 tab 正在导航时用）。 */
  private async waitForTarget(cdp: Cdp, match: (t: TargetInfo) => boolean, tries = 8): Promise<TargetInfo | undefined> {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 400))
      const { targetInfos } = await cdp.call<{ targetInfos: TargetInfo[] }>('Target.getTargets')
      const hit = (targetInfos ?? []).find((t) => t.type === 'page' && match(t))
      if (hit) return hit
    }
    return undefined
  }

  private async waitLoaded(cdp: Cdp, targetId: string): Promise<void> {
    // 新 tab 导航到 light page：最多等 8s，失败不算致命（fetch 时再验）
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const { targetInfos } = await cdp.call<{ targetInfos: TargetInfo[] }>('Target.getTargets')
      const t = targetInfos.find((x) => x.targetId === targetId)
      if (t && t.url !== 'about:blank' && t.url !== 'chrome://new-tab-page/') return
    }
  }

  /** tab 漂出预期域 → navigate 回轻量页（watchdog 调用）。 */
  async resetIfDrifted(domain: string): Promise<void> {
    const tab = this.tabs.get(domain)
    if (!tab) return
    try {
      const { result } = await this.evalRaw<string>(tab.sessionId, 'location.href')
      const url = String(result?.value ?? '')
      const host = safeUrl(url)?.hostname
      if (host !== domain && !host?.endsWith(`.${domain}`)) {
        await this.cdp!.call('Page.navigate', { url: lightPageFor(domain) }, tab.sessionId)
        this.log.info(`tab for ${domain} drifted to ${url}; navigated back`)
      }
    } catch { /* tab 可能已死，下次 ensure 重建 */ }
  }

  /** 在 tab 上下文执行表达式（awaitPromise），返回 result.value。 */
  async evalRaw<T = unknown>(sessionId: string, expression: string, timeoutMs = 15_000): Promise<{ result?: { value?: T } }> {
    const { cdp } = await this.conn()
    return cdp.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
    }, sessionId, timeoutMs + 1000)
  }

  /** 激活 tab 到前台（授权态：用户登录/过验证）。 */
  async activate(domain: string): Promise<void> {
    const { cdp } = await this.conn(lightPageFor(domain))
    this.inst.consumeColdStart() // 用户路径消费掉冷启动标——不最小化
    await this.setWindowState(cdp, 'normal') // 可能缩在 Dock——恢复
    const tab = await this.ensure(domain)
    await cdp.call('Target.activateTarget', { targetId: tab.targetId })
  }

  /** 用户主动开一个前台页面（设置页「打开 Chrome」/授权 URL）——不走域白名单，用户的窗口用户作主。 */
  async openPage(url: string): Promise<void> {
    const { cdp } = await this.conn(url)
    this.inst.consumeColdStart()
    await this.setWindowState(cdp, 'normal')
    const { targetInfos } = await cdp.call<{ targetInfos: TargetInfo[] }>('Target.getTargets')
    const existing = (targetInfos ?? []).find((t) => t.type === 'page' && t.url === url)
    if (existing) {
      await cdp.call('Target.activateTarget', { targetId: existing.targetId })
      return
    }
    // 冷启动时窗口首 tab 已在本 URL 导航中——等它出现而不是再开一个
    const hit = await this.waitForTarget(cdp, (t) => t.url === url, 4)
    if (hit) { await cdp.call('Target.activateTarget', { targetId: hit.targetId }); return }
    const { targetId } = await cdp.call<{ targetId: string }>('Target.createTarget', { url })
    await cdp.call('Target.activateTarget', { targetId })
  }

  /** 页面内 fetch：返回值交给调用方（adapter）判定非 JSON/挑战页。 */
  async pageFetch(domain: string, url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
    const tab = await this.ensure(domain)
    const expr = `fetch(${JSON.stringify(url)}, ${JSON.stringify(init ?? {})})
      .then(async r => ({ status: r.status, body: await r.text() }))
      .catch(e => ({ error: String(e) }))`
    const { result } = await this.evalRaw<{ status?: number; body?: string; error?: string }>(tab.sessionId, expr, 20_000)
    const v = result?.value
    if (v?.error) throw new Error(`page fetch failed: ${v.error}`)
    if (typeof v?.status !== 'number') throw new Error('page fetch returned no result (tab dead?)')
    return { status: v.status, body: v.body ?? '' }
  }

  /** 域→tab 清单（watchdog/状态展示用）。 */
  domains(): string[] { return [...this.tabs.keys()] }

  /** 巡检：实例活着、tab 在、URL 没漂。skipDrift 命中的域跳过漂移重置（授权登录中）。 */
  async sweep(skipDrift?: (domain: string) => boolean): Promise<void> {
    if (!this.inst.running) return
    try {
      const { cdp } = await this.conn()
      const { targetInfos } = await cdp.call<{ targetInfos: TargetInfo[] }>('Target.getTargets')
      const alive = new Set((targetInfos ?? []).filter((t) => t.type === 'page').map((t) => t.targetId))
      for (const [domain, tab] of [...this.tabs]) {
        if (!alive.has(tab.targetId)) this.tabs.delete(domain) // 用户关了 tab → 下次 ensure 重建
      }
      for (const domain of this.tabs.keys()) {
        if (skipDrift?.(domain)) continue
        await this.resetIfDrifted(domain)
      }
    } catch (e) {
      this.log.warn(`watchdog sweep failed: ${(e as Error).message}`)
      if (this.cdp?.closed) { this.cdp = undefined; this.tabs.clear() }
    }
  }

  async close(): Promise<void> {
    this.tabs.clear()
    this.cdp?.close()
    this.cdp = undefined
  }
}

/** URL 解析防御：非法 URL 返回 undefined 而不是 throw。 */
function safeUrl(u: string): URL | undefined {
  try { return new URL(u) } catch { return undefined }
}
