# dsh-rss-news-browser-fetch

「浏览器传输」——dsh 基建服务插件：为其他插件提供 `browserFetch` 服务，用**专用 Chrome 实例 + CDP** 执行真浏览器级 fetch（真实指纹、独立持久 cookie、同源上下文）。本插件自身不做任何抓取业务。

## 它解决什么问题

部分数据源接口对 Node 运行时做指纹风控（TLS 指纹、UA、挑战页）——插件的 node fetch 稳定挂起或被拦。`browserFetch` 让源包以「浏览器页面内 fetch」的方式取数：同源无 CORS、cookie 全真、指纹与普通浏览完全一致。

## 功能

- **专用 Chrome 实例**：懒拉起（首次 fetch 才启动），独立持久 profile——与日常浏览器 cookie 完全隔离，登录一次长期有效
- **域白名单**：调用方 `declareDomains` 显式声明域，只放行声明过的精确 host（同源 fetch 语义）
- **域→tab 池**：每个 API 域一个轻量同源页（默认 `robots.txt`，加载失败自动回退域根页），fetch 在该页 `Runtime.evaluate` 执行
- **授权流**：adapter 判定登录墙/验证码后 `markAuthRequired`，用户可经 `openForAuth` 把 tab 顶到前台登录；授权中自动暂停漂移巡检
- **watchdog**：5 分钟巡检——tab 被关自动重建、URL 漂移自动拉回、实例崩溃自动重拉；用户连续关闭 ≥3 次转为暂停（尊重用户意愿），设置页可手动恢复
- **冷启动静默**：worker 路径拉起时窗口最小化，用户主动操作才恢复前台——浏览器传输是无声基建
- **设置页**：实例/域/授权状态展示、「打开 Chrome」调试入口、「清除所有数据」（cookie/登录态/声明全清）

## 安装

```bash
dsh plugin --profile <你的profile名> add dsh-rss-news-browser-fetch
```

需要一个 Chromium 系浏览器（自动探测：Chrome / Edge / Chromium / Brave）。

## 消费方式（插件开发者）

```ts
export function apply(ctx: Context) {
  ctx.inject(['browserFetch'], (c) => {
    const bf = c.browserFetch // 可选依赖：未装则降级纯 node fetch
    bf.declareDomains('my-plugin', ['api.example.com'])
    const r = await bf.fetch('api.example.com', 'https://api.example.com/list')
    // r = { status, body }——在 api.example.com 的同源页内执行，cookie 全真
  })
}
```

| API | 说明 |
|---|---|
| `declareDomains(caller, domains)` | 声明可 fetch 的域（并集白名单，caller 自报仅作审计） |
| `fetch(domain, url, init?)` | 域同源页内执行 fetch，返回 `{status, body}` |
| `markAuthRequired(domain, on?)` | 标记/清除「需用户授权」（登录墙/验证码命中时） |
| `authRequired(domain)` | 查询域是否待授权 |
| `openForAuth(domain, url?)` | 把域 tab 顶到前台让用户登录/过验证 |
| `resume()` / `status()` | 手动恢复暂停实例 / 状态查询 |

apiVersion: 1

## 内部说明

- cordis entry id：`rss-news-browser-fetch`；提供服务名 `browserFetch`
- 数据目录：`~/.dsh/data/rss-news-browser-fetch/`（专用 Chrome profile 所在地）
- Chrome 136+ 硬约束：`--remote-debugging-port` 仅在非默认 `--user-data-dir` 生效——这正是独立 profile 存在的技术原因之一

## License

Apache-2.0

---

# dsh-rss-news-browser-fetch (English)

**Browser transport** — a dsh infrastructure plugin providing the `browserFetch` service: real browser-grade fetching via a **dedicated Chrome instance + CDP** (genuine fingerprint, isolated persistent cookies, same-origin context). It performs no scraping business itself.

## What it solves

Some data-source endpoints fingerprint non-browser runtimes (TLS fingerprint, UA, challenge pages), so a plugin's Node fetch hangs or gets blocked. `browserFetch` lets source packs fetch **inside a real browser page**: same-origin (no CORS), authentic cookies, indistinguishable from normal browsing.

## Features

- **Dedicated Chrome instance**: lazily spawned on first fetch; isolated persistent profile — cookies fully separated from your daily browser, login once and it sticks
- **Domain whitelist**: callers declare domains via `declareDomains`; only declared exact hosts pass (same-origin fetch semantics)
- **Domain→tab pool**: one light same-origin page per API domain (`robots.txt` by default, auto-fallback to domain root on load failure); fetch runs via `Runtime.evaluate` in that page
- **Auth flow**: adapters mark `markAuthRequired` on login walls/captchas; `openForAuth` brings the tab forward for user login; drift watchdog is suspended while auth is pending
- **Watchdog**: 5-minute sweep — rebuilds closed tabs, pulls drifted tabs back, respawns crashed instances; after 3 consecutive user closes the instance pauses (respects user intent), resumable from the settings page
- **Silent cold start**: worker-path spawns minimize the window — browser transport is invisible infrastructure
- **Settings page**: instance/domain/auth status, "open Chrome" debug entry, "clear all data" (cookies/login/declarations wiped)

## Install

```bash
dsh plugin --profile <profile> add dsh-rss-news-browser-fetch
```

Requires a Chromium-family browser (auto-detected: Chrome / Edge / Chromium / Brave).

## Consuming (plugin developers)

```ts
export function apply(ctx: Context) {
  ctx.inject(['browserFetch'], (c) => {
    const bf = c.browserFetch // optional dep: fall back to plain node fetch when absent
    bf.declareDomains('my-plugin', ['api.example.com'])
    const r = await bf.fetch('api.example.com', 'https://api.example.com/list')
    // r = { status, body } — executed inside an api.example.com same-origin page
  })
}
```

| API | Description |
|---|---|
| `declareDomains(caller, domains)` | Declare fetchable domains (union whitelist; caller is self-reported for audit only) |
| `fetch(domain, url, init?)` | Page-context fetch; returns `{status, body}` |
| `markAuthRequired(domain, on?)` | Mark/clear "user auth needed" (login wall / captcha detected) |
| `authRequired(domain)` | Query whether a domain awaits auth |
| `openForAuth(domain, url?)` | Bring the domain's tab forward for user login/verification |
| `resume()` / `status()` | Resume paused instance / query status |

apiVersion: 1

## Internals

- cordis entry id: `rss-news-browser-fetch`; provided service name: `browserFetch`
- Data dir: `~/.dsh/data/rss-news-browser-fetch/` (hosts the dedicated Chrome profile)
- Chrome 136+ hard constraint: `--remote-debugging-port` only works with a non-default `--user-data-dir` — one technical reason the isolated profile exists

## License

Apache-2.0
