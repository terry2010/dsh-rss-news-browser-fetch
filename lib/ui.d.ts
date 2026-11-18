/**
 * 设置页挂载：静态页 /dsh-rss-news-browser-fetch/ + /api/* JSON 端点。
 * 与主插件同一套 webServer 路由惯例（kind: exact|prefix + sameSite 防护）。
 *
 * 防线（全部路由）：
 *  - Host 只收 loopback——DNS 重绑定下 sec-fetch-site 是 same-origin，挡不住，Host 校验才挡得住
 *  - Origin 头存在时必须与 Host 同源（file:// 的 'null' 拒绝）
 *  - Sec-Fetch-Site != cross-site（现代浏览器跨站请求都带）
 *  - /api/clear 是 rm -rf 级破坏性操作——服务端要求 confirm:true，不依赖前端弹窗
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
    readonly headersSent: boolean;
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
/** Host 只收 loopback（导出供测试）——设置页只服务本机用户。 */
export declare function hostAllowed(host: string | undefined): boolean;
/** Origin 头存在时必须与 Host 同源（导出供测试）；缺失放行——非浏览器客户端
 *  （curl）没有 Origin，由 hostAllowed + sameSite 兜底；'null'（file:// 等）拒绝。 */
export declare function originAllowed(origin: string | undefined, host: string | undefined): boolean;
/** 三道防线合体（导出供测试）。 */
export declare function trusted(req: Req): boolean;
/** 把 rel 安全映射进 webDir（导出供测试）：resolve + 前缀校验，杜绝 ../ 遍历；
 *  不做字符删除——`a..b.js` 这类合法文件名不再被误伤。返回 undefined → 404。 */
export declare function resolveWebPath(webDir: string, rel: string): string | undefined;
/** 注册设置页全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export declare function mountUi(ws: WebServerLike, svc: BrowserFetchService, log: LogSink): () => void;
export {};
//# sourceMappingURL=ui.d.ts.map