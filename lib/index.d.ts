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
import type { Context } from '@deepseek-ai/cordis';
import { BrowserFetchService } from './service.js';
export { BrowserFetchService };
export type { BrowserFetchInit, BrowserFetchResult } from './service.js';
export declare const name = "rss-news-browser-fetch";
/** 对外提供的服务名——源包 `ctx.inject(['browserFetch'])` 消费。 */
export declare const provide = "browserFetch";
/** 无静态依赖：Chrome 缺席时服务照常注册，fetch 时按实例不可用降级报错。 */
export declare const inject: string[];
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map