/**
 * 专用 Chrome 实例生命周期：懒拉起、专用持久 profile、就绪探测、
 * 用户连关三次转「已暂停」（尊重用户意愿，给重新启用手动出口）。
 *
 * 硬约束（Chrome 136+）：--remote-debugging-port 只在非默认 --user-data-dir 下生效。
 * 插件自有 profile → 与用户主浏览器完全隔离（cookie jar 独立，登录一次长期有效）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

import { locateBrowser } from './locate.js'
import type { LogSink } from './types.js'

export interface InstanceInfo {
  port: number
  httpBase: string
  browserWsUrl: string
}

const USER_CLOSE_LIMIT = 3
const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 300

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
    srv.on('error', reject)
  })
}

export class ChromeInstance {
  private proc?: ChildProcess
  private info?: InstanceInfo
  private starting?: Promise<InstanceInfo>
  private userCloses = 0
  private ourKill = false
  paused = false        // 用户连关 ≥3 → 暂停，需显式 resume()
  private readonly binary?: string
  private readonly profileDir: string
  private readonly log: LogSink

  constructor(opts: { dataDir: string; log: LogSink }) {
    this.log = opts.log
    this.profileDir = join(opts.dataDir, 'chrome-profile')
    this.binary = locateBrowser()
    if (!this.binary) this.log.warn('no Chromium-based browser found; browserFetch disabled')
  }

  get available(): boolean { return !!this.binary }
  get running(): boolean { return !!this.info && !this.paused }
  get binaryPath(): string | undefined { return this.binary }
  get profile(): string { return this.profileDir }

  private coldStart = false
  /** 本次 ensure 是否触发了冷启动（消费一次——工位路径据此最小化窗口，用户路径据此恢复窗口）。 */
  consumeColdStart(): boolean { const c = this.coldStart; this.coldStart = false; return c }

  /** 懒拉起：未启动则拉起并等待就绪；已暂停/无浏览器则抛错。 */
  async ensure(firstUrl?: string): Promise<InstanceInfo> {
    if (this.paused) throw new Error('browser-fetch paused (user closed the instance repeatedly)')
    if (!this.binary) throw new Error('no Chromium-based browser found')
    if (this.info && this.proc && !this.proc.killed) return this.info
    this.starting ??= this.spawn(firstUrl).finally(() => { this.starting = undefined })
    return this.starting
  }

  private async spawn(firstUrl?: string): Promise<InstanceInfo> {
    const port = await freePort()
    mkdirSync(this.profileDir, { recursive: true })
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--silent-launch', // macOS：拉起不抢前台焦点（worker 路径随后 CDP 最小化，用户路径照常显示）
      firstUrl ?? 'about:blank',
    ]
    this.ourKill = false
    const proc = spawn(this.binary!, args, { detached: true, stdio: 'ignore' })
    this.proc = proc
    proc.unref()
    proc.on('exit', () => this.onExit())
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
        const j = (await r.json()) as { webSocketDebuggerUrl?: string }
        if (j.webSocketDebuggerUrl) {
          this.info = { port, httpBase: `http://127.0.0.1:${port}`, browserWsUrl: j.webSocketDebuggerUrl }
          this.userCloses = 0
          this.coldStart = true
          this.log.info(`chrome instance ready on 127.0.0.1:${port} (profile ${this.profileDir})`)
          return this.info
        }
      } catch { /* 未就绪继续等 */ }
      if (Date.now() > deadline) {
        try { proc.kill() } catch { /* noop */ }
        throw new Error('chrome instance did not become ready in time')
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
  }

  /** 用户关了实例/窗口：自动重拉，连关 ≥3 转已暂停（不再自动拉起）。 */
  private onExit(): void {
    const wasOurKill = this.ourKill
    this.info = undefined
    this.proc = undefined
    if (wasOurKill) return
    this.userCloses += 1
    if (this.userCloses >= USER_CLOSE_LIMIT) {
      this.paused = true
      this.log.warn(`chrome instance closed ${this.userCloses}× by user → paused; call resume() to re-enable`)
      return
    }
    this.log.warn(`chrome instance exited (close ${this.userCloses}/${USER_CLOSE_LIMIT}); will respawn on next fetch`)
  }

  /** 手动恢复（面板「重新启用」按钮）。 */
  resume(): void {
    this.paused = false
    this.userCloses = 0
  }

  async stop(): Promise<void> {
    this.ourKill = true
    this.info = undefined
    const p = this.proc
    this.proc = undefined
    if (p) { try { p.kill() } catch { /* noop */ } }
  }
}
