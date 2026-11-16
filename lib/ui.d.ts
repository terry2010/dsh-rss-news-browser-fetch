/**
 * 设置页挂载：静态页 /dsh-rss-news-browser-fetch/ + /api/* JSON 端点。
 * 与主插件同一套 webServer 路由惯例（kind: exact|prefix + sameSite 防护）。
 */
import type { BrowserFetchService } from './service.js';
import type { LogSink } from './types.js';
interface Req {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    on(ev: string, cb: (c?: unknown) => void): void;
}
interface Res {
    statusCode: number;
    setHeader(k: string, v: string): void;
    end(b?: string): void;
}
interface WebServerLike {
    register(opts: {
        kind: string;
        path: string;
        handler: (req: Req, res: Res) => void;
    }): () => void;
}
/** 注册设置页全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export declare function mountUi(ws: WebServerLike, svc: BrowserFetchService, log: LogSink): () => void;
export {};
//# sourceMappingURL=ui.d.ts.map