/**
 * browserFetch 服务（公开 API 面，进 semver）：
 *   declareDomains(caller, domains)  声明式域白名单——只放行声明过的域，意图显式可审计
 *   fetch(domain, url, init?)        唯一抓取面：在域的轻量同源页内执行 fetch（不暴露裸 evaluate）
 *   authRequired(domain) / openForAuth(domain) / markAuthRequired(domain)
 *   status()                         实例/域/暂停状态展示
 *
 * 语义边界：caller 自报（审计用）；域名单是并集共享——A 包声明的域 B 包也能 fetch；
 * init 经 Runtime.evaluate 序列化，只支持 JSON-safe 子集（method/headers/body/credentials）。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { LogSink } from './types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        browserFetch: BrowserFetchService;
    }
}
export interface BrowserFetchInit {
    method?: string;
    headers?: Record<string, string> | Headers | [string, string][];
    body?: string;
    credentials?: 'omit' | 'same-origin' | 'include';
    referrer?: string;
}
/** init 归一化（导出供测试）：Headers 实例/键值对数组 → plain object；不认识的 key、
 *  非 string 值显式报错——JSON.stringify 会把 Headers、AbortSignal 之类静默序列化成
 *  {}，字段被吞后 fetch 行为漂移且难排查。 */
export declare function normalizeInit(init?: BrowserFetchInit): Record<string, unknown>;
export interface BrowserFetchResult {
    status: number;
    body: string;
}
/** 渲染抓取结果：导航到真实页面后的 outerHTML（挑战页/SPA 用），url=落地后地址。 */
export interface RenderHtmlResult {
    status: number;
    html: string;
    url: string;
}
export declare class BrowserFetchService extends Service {
    readonly apiVersion = 2;
    private readonly log;
    private readonly dataDir;
    private readonly inst;
    private readonly pool;
    private readonly callers;
    private readonly declared;
    private readonly authDomains;
    private sweepTimer?;
    constructor(ctx: Context, opts: {
        dataDir: string;
        log: LogSink;
        proxyUrl?: () => string | undefined;
    });
    /** 调用方先声明域——只放行声明过的域（精确 host）。 */
    declareDomains(caller: string, domains: string[]): void;
    /** url 的 hostname 必须精确等于已声明域——白名单唯一防线（纯函数实现见文件尾，导出供测试）。 */
    private assertAllowed;
    /** 域的轻量同源页内执行 fetch。实例未启动时懒拉起。 */
    fetch(domain: string, url: string, init?: BrowserFetchInit): Promise<BrowserFetchResult>;
    /**
     * 渲染档抓取：在域 tab 里真导航到 url，等 readyState=complete + waitMs 稳定后
     * 返回 outerHTML。与 fetch 同一域白名单；不暴露裸 evaluate——返回值只有 DOM 文本。
     * JS 挑战页/SPA 专用档（node fetch 拿到空壳或验证页时升级上来）。
     */
    renderHtml(domain: string, url: string, opts?: {
        waitMs?: number;
    }): Promise<RenderHtmlResult>;
    /** 某域当前是否需要用户授权（登录墙/验证码）——adapter 置位，源包据此标源状态。 */
    authRequired(domain: string): boolean;
    /** adapter 判定登录墙/挑战页后调用；恢复后再 markAuthRequired(domain,false)。 */
    markAuthRequired(domain: string, on?: boolean): void;
    /** 把该域 tab 顶到前台让用户登录/过验证；返回是否成功激活。给了 url 就直接开那个授权页。 */
    openForAuth(domain: string, url?: string): Promise<boolean>;
    /** 用户连关后手动恢复实例。 */
    resume(): void;
    /** 设置页「打开 Chrome」：实例未起则带 URL 冷启动，已起则前台开 tab。空值开 about:blank。 */
    openWindow(url?: string): Promise<string>;
    /** 设置页「清除所有数据」：杀实例 + 删整个数据目录（profile cookie/缓存/声明状态全清）。 */
    clearAllData(): Promise<void>;
    status(): {
        available: boolean;
        running: boolean;
        paused: boolean;
        domains: string[];
        tabs: string[];
        authRequired: string[];
        binary?: string;
        dataDir: string;
    };
    dispose(): Promise<void>;
}
/** 域白名单校验：domain 须先声明；url 的 host 须精确等于声明域，且必须 https。
 *  页面 origin 就是 domain 本身——子域 fetch 本来就过不了 CORS，放行只会把
 *  「清晰报错」换成「莫名 CORS 失败」；http 则是 https 页面里的混合内容，必被浏览器拦。 */
export declare function checkAllowedUrl(declared: ReadonlySet<string>, domain: string, url: string): void;
/** 域格式校验（导出供测试）：只收纯 host。带 scheme/端口/路径的声明在 checkAllowedUrl 的
 *  hostname 语义下永不匹配（URL.hostname 不含端口），提前拒绝给出清晰报错。 */
export declare function validateDomainFormat(domain: string): void;
/** 设置页 URL 输入消毒：空 → about:blank；只放行 http(s)/about:*；其余协议（javascript:/file:/data:）拒绝。 */
export declare function sanitizeOpenUrl(url?: string): string;
//# sourceMappingURL=service.d.ts.map