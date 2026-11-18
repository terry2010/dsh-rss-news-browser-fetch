/** Chrome/Edge 二进制发现：macOS → Windows → Linux；Edge 同 CDP 可作 fallback。 */

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** win32 候选：env 缺失时拼出 'undefined\...' 字符串没意义，先过滤再进候选表。 */
function win32Candidates(): string[] {
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const lad = process.env.LOCALAPPDATA
  return [
    pf && `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    pf86 && `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    lad && `${lad}\\Google\\Chrome\\Application\\chrome.exe`,
    pf86 && `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    pf && `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
}

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  win32: win32Candidates(),
}

/** PATH 查找（which/where 兜底）——只查 PATH 里可能出现的短名 */
function which(name: string): string | undefined {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000 })
    return out.split('\n').map((s) => s.trim()).find((s) => s && existsSync(s))
  } catch { return undefined }
}

/** 返回首个可用的 Chromium 系浏览器二进制；无则 undefined（功能整体降级）。 */
export function locateBrowser(): string | undefined {
  for (const p of CANDIDATES[process.platform] ?? []) {
    if (existsSync(p)) return p
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser', 'chrome', 'msedge']) {
    const hit = which(name)
    if (hit) return hit
  }
  return undefined
}
