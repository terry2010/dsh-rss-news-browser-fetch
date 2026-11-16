/**
 * 最小 CDP client：Node ≥22.5 自带全局 WebSocket，零依赖。
 * 单连接复用 browser 域 + 多 sessionId（flatten attach）。
 */

interface PendingCall {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type EventHandler = (params: unknown, sessionId?: string) => void

export class Cdp {
  private ws: WebSocket
  private seq = 0
  private pending = new Map<number, PendingCall>()
  private handlers = new Map<string, Set<EventHandler>>()
  private ready: Promise<void>
  closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.ready = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('cdp websocket error')), { once: true })
    })
    ws.addEventListener('message', (ev) => this.onMessage(ev))
    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('cdp closed')) }
      this.pending.clear()
    })
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const cdp = new Cdp(new WebSocket(wsUrl))
    await cdp.ready
    return cdp
  }

  on(method: string, cb: EventHandler): void {
    let set = this.handlers.get(method)
    if (!set) this.handlers.set(method, (set = new Set()))
    set.add(cb)
  }

  async call<T = unknown>(method: string, params?: unknown, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closed) throw new Error('cdp closed')
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  private onMessage(ev: MessageEvent): void {
    let msg: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string } }
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? `cdp error ${msg.id}`))
      else p.resolve(msg.result)
      return
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method)
      if (set) for (const cb of set) { try { cb(msg.params, msg.sessionId) } catch { /* listener 不拖垮连接 */ } }
    }
  }

  close(): void {
    this.closed = true
    try { this.ws.close() } catch { /* noop */ }
  }
}
