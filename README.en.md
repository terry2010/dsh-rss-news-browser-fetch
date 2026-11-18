<p align="center">
  <img src="https://raw.githubusercontent.com/terry2010/dsh-rss-news-browser-fetch/master/assets/banner.svg" alt="browserFetch" width="760">
</p>

# dsh-rss-news-browser-fetch

> Dedicated Chrome instance + CDP (Chrome DevTools Protocol) browser-fetch service for dsh plugins — run requests inside the user's own real browser session (persistent cookies, same-origin page fetch) as a compatibility fallback for sources that respond unreliably to Node.js requests.

[中文](./README.md) | English

[![npm version](https://img.shields.io/npm/v/dsh-rss-news-browser-fetch)](https://www.npmjs.com/package/dsh-rss-news-browser-fetch)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

`browserFetch` is an infrastructure **service plugin** for the dsh plugin ecosystem. It performs no scraping business itself — it gives *other* plugins a "fetch inside the user's real browser page" capability. Some source endpoints respond unreliably to non-browser requests (hangs, errors, JS-required pages); the browser channel serves as an automatic compatibility fallback.

## The problem it solves

Some data endpoints respond unreliably to non-browser clients — a plugin's Node-side `fetch` hangs, errors out, or receives a page that only has content after JS executes. `browserFetch` executes `fetch()` inside a real Chrome tab via CDP: the request originates from the user's own browser session — same-origin context (no CORS), the domain's cookies attached automatically — equivalent to the user opening the page themselves. No Selenium, Puppeteer, or heavyweight automation frameworks (zero runtime dependencies).

## Features

- **Dedicated Chrome instance** — lazily spawned on first fetch; isolated persistent profile, so cookies/login state are fully separate from the user's daily browser. Login once, session persists.
- **Domain whitelist** — callers declare fetchable domains via `declareDomains`; only declared exact hosts pass (same-origin semantics). No open proxy surface.
- **Domain→tab pool** — one light same-origin page per API domain (`robots.txt` by default, automatic fallback to the domain root when it fails); page `fetch` runs through `Runtime.evaluate`.
- **Auth flow** — adapters mark `markAuthRequired` on login walls/interactive checks; `openForAuth` brings the domain tab to the foreground so the *user* completes sign-in/verification once, exactly like a normal visit.
- **Watchdog** — periodic sweep rebuilds closed tabs, pulls drifted tabs back, respawns crashed instances; after 3 consecutive user closes the instance pauses (respecting user intent) and can be resumed manually.
- **Silent cold start** — worker-path spawns minimize the window; the browser transport stays invisible infrastructure.
- **Settings page** — instance/domain/auth status at `/dsh-rss-news-browser-fetch/`, "open Chrome" debug entry, "clear all data" (cookies, login state, declarations wiped).

## Install

```bash
dsh plugin --profile desktop add dsh-rss-news-browser-fetch
```

(Most users' profile name is `desktop`; if you renamed yours, substitute your own profile name.)

Requires a Chromium-family browser (auto-detected: Google Chrome / Microsoft Edge / Chromium / Brave on macOS, Windows, Linux).

## Consuming it (plugin developers)

```ts
export function apply(ctx: Context) {
  ctx.inject(['browserFetch'], (c) => {
    const bf = c.browserFetch // optional dependency: degrade to plain Node fetch when absent
    bf.declareDomains('my-plugin', ['api.example.com'])
    const r = await bf.fetch('api.example.com', 'https://api.example.com/list')
    // r = { status, body } — executed inside an api.example.com same-origin page
  })
}
```

| API | Description |
|---|---|
| `declareDomains(caller, domains)` | Declare fetchable domains (union whitelist; `caller` is self-reported for audit) |
| `fetch(domain, url, init?)` | Page-context fetch, returns `{ status, body }` |
| `markAuthRequired(domain, on?)` | Mark/clear "user auth needed" (login wall / interactive check detected) |
| `authRequired(domain)` | Query whether a domain currently awaits auth |
| `openForAuth(domain, url?)` | Bring the domain's tab forward for user login/verification |
| `resume()` / `status()` | Resume a paused instance / query instance status |

Service name: `browserFetch` · apiVersion: 2

## Internals

- cordis entry id: `rss-news-browser-fetch`; provided service: `browserFetch`
- Data dir: `~/.dsh/rss-news-browser-fetch/` (hosts the dedicated Chrome profile; under `$DSH_HOME/data/` when `DSH_HOME` is set)
- Instance state `instance.json`: records pid + debug port. If the host crashes or is killed, Chrome survives as an orphan holding the profile's singleton lock — the next start reaps it by pid (SIGTERM→SIGKILL), avoiding the "singleton hand-off, instant exit" path that would fail every first fetch
- Watchdog counting semantics: 3 consecutive user closes pause the instance; automatic respawns do NOT reset the counter — only the settings page's "re-enable" (`resume()`) does, otherwise the pause would never trigger under frequent polling
- Chrome 136+ hard constraint: `--remote-debugging-port` only works with a non-default `--user-data-dir` — one technical reason the isolated profile exists
- CDP threat model: the debug port binds 127.0.0.1 only, and CDP itself has no authentication — any local process can take over the dedicated instance (read cookies, arbitrary evaluate). The isolated profile bounds the blast radius to scraping cookies; the settings API serves loopback Hosts only (DNS-rebinding defense) with same-origin Origin checks, and `/api/clear` requires a server-side `confirm:true`
- Minimal dependency-free CDP client on Node's built-in WebSocket (Node ≥ 22.18)
- Known consumer: [dsh-rss-news-flash-kuaixun](https://github.com/terry2010/dsh-rss-news-flash-kuaixun) — node-first fetch with automatic browser fallback

## Related plugins

- **[dsh-rss-news-daily](https://github.com/terry2010/dsh-rss-news-daily)** — RSS subscriptions + AI daily digest/period briefings + sidebar news reader
- **[dsh-rss-news-flash-kuaixun](https://github.com/terry2010/dsh-rss-news-flash-kuaixun)** — real-time finance flash-news companion (known consumer): node-first fetch, automatic fallback to this service

## License

Apache-2.0 — see [LICENSE](./LICENSE)
