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
    headers?: Record<string, string>;
    body?: string;
    credentials?: 'omit' | 'same-origin' | 'include';
    referrer?: string;
}
export interface BrowserFetchResult {
    status: number;
    body: string;
}
export declare class BrowserFetchService extends Service {
    readonly apiVersion = 1;
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
    });
    /** 调用方先声明域——只放行声明过的域（及子域）。 */
    declareDomains(caller: string, domains: string[]): void;
    /** url 的 hostname 必须精确等于已声明域——白名单唯一防线（纯函数实现见文件尾，导出供测试）。 */
    private assertAllowed;
    /** 域的轻量同源页内执行 fetch。实例未启动时懒拉起。 */
    fetch(domain: string, url: string, init?: BrowserFetchInit): Promise<BrowserFetchResult>;
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
/** 域白名单校验：domain 须先声明；url 的 host 须精确等于声明域。
 *  页面 origin 就是 domain 本身——子域 fetch 本来就过不了 CORS，放行只会把
 *  「清晰报错」换成「莫名 CORS 失败」。 */
export declare function checkAllowedUrl(declared: ReadonlySet<string>, domain: string, url: string): void;
/** 设置页 URL 输入消毒：空 → about:blank；只放行 http(s)/about:*；其余协议（javascript:/file:/data:）拒绝。 */
export declare function sanitizeOpenUrl(url?: string): string;
//# sourceMappingURL=service.d.ts.map