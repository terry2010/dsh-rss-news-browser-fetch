/**
 * dsh-rss-news-browser-fetch 插件入口。
 *
 * 契约（cordis bundle）：
 *  - name    'rss-news-browser-fetch'（cordis.patch.yml 里 id 必须一致）
 *  - provide 'browserFetch'（服务名——源包经 inject 消费）
 *  - apply   挂载 BrowserFetchService：专用 Chrome 实例懒拉起 + CDP 页面内 fetch
 *
 * 本插件不做任何抓取业务——它是基建服务插件，只提供「真浏览器 fetch」能力。
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { BrowserFetchService } from './service.js'

export { BrowserFetchService }
export type { BrowserFetchInit, BrowserFetchResult } from './service.js'

export const name = 'rss-news-browser-fetch'

/** 对外提供的服务名——源包 `ctx.inject(['browserFetch'])` 消费。 */
export const provide = 'browserFetch'

/** 无静态依赖：Chrome 缺席时服务照常注册，fetch 时按实例不可用降级报错。 */
export const inject: string[] = []

function resolveDataDir(): string {
  const home = process.env.DSH_HOME
  if (home) return join(home, 'data', 'rss-news-browser-fetch')
  return join(process.env.HOME || '.', '.dsh', 'rss-news-browser-fetch')
}

export function apply(ctx: Context) {
  const log = ctx.logger('browser-fetch')
  try {
    new BrowserFetchService(ctx, { dataDir: resolveDataDir(), log })
    log.info('browserFetch service registered (lazy: chrome spawns on first fetch)')
  } catch (e) {
    // 非完整 cordis 宿主（stub ctx/极简宿主）——服务注册失败不拖垮宿主
    log.warn(`browserFetch service unavailable: ${(e as Error).message}`)
  }
}
