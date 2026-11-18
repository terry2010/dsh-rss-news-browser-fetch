/**
 * 域→tab 池 + 页面内 fetch：每个 API 源一个「轻量同源页」tab（默认 robots.txt），
 * fetch 在该页 Runtime.evaluate 执行——同源无 CORS、cookie/Origin 全真。
 */
import type { ChromeInstance } from './instance.js';
import type { LogSink } from './types.js';
export interface PageTab {
    targetId: string;
    sessionId: string;
    url: string;
}
/** 域的轻量页：API 所在源的 robots.txt（同源保证；失败时退回域根页）。 */
export declare function lightPageFor(domain: string): string;
export declare class TabPool {
    private readonly inst;
    /** 返回 true 的域跳过漂移修复——授权登录中（用户可能正跨域 OAuth），抢回 tab 会打断流程。
     *  watchdog 巡检与 ensure 的缓存修复共用这一谓词。 */
    private readonly skipDrift?;
    private cdp?;
    private connecting?;
    private tabs;
    private inflight;
    private readonly log;
    constructor(inst: ChromeInstance, log: LogSink, 
    /** 返回 true 的域跳过漂移修复——授权登录中（用户可能正跨域 OAuth），抢回 tab 会打断流程。
     *  watchdog 巡检与 ensure 的缓存修复共用这一谓词。 */
    skipDrift?: ((domain: string) => boolean) | undefined);
    /** firstUrl 只在冷启动生效——窗口首 tab 直接开目标页，不留 about:blank 空壳。 */
    private conn;
    /** 窗口显隐：worker 冷启动最小化（无声基建），用户主动操作恢复前台。best-effort，失败不阻塞。 */
    private setWindowState;
    /** 取/建某域的轻量页 tab，返回 attach 好的 sessionId。并发调用按 domain 去重。
     *  coldWindowState：冷启动时窗口怎么摆——worker 路径最小化，用户路径（activate）恢复前台。 */
    ensure(domain: string, coldWindowState?: 'minimized' | 'normal'): Promise<PageTab>;
    private ensure0;
    /** 短轮询等一个满足条件的 page target 出现（冷启动首个 tab 正在导航时用）。 */
    private waitForTarget;
    /** 等 target 落地到 match 的 URL（最多 8s）。失败不算致命——fetch 时再验 origin。 */
    private waitLoaded;
    /** tab 当前 location.origin 的 hostname；opaque origin（'null'）等解析失败 → undefined。 */
    private originHost;
    /** tab 漂出预期域 → navigate 回轻量页（watchdog 调用）。 */
    private resetIfDrifted;
    /** 在 tab 上下文执行表达式（awaitPromise）。超时由 cdp.call 计时（Runtime.evaluate 本身没有
     *  timeout 参数）；页内任务超时后仍在跑、结果被丢弃——对只读 fetch 无害。 */
    evalRaw<T = unknown>(sessionId: string, expression: string, timeoutMs?: number): Promise<{
        result?: {
            value?: T;
        };
    }>;
    /** 激活 tab 到前台（授权态：用户登录/过验证）。 */
    activate(domain: string): Promise<void>;
    /** 用户主动开一个前台页面（设置页「打开 Chrome」/授权 URL）——不走域白名单，用户的窗口用户作主。 */
    openPage(url: string): Promise<void>;
    /** 页面内 fetch：返回值交给调用方（adapter）判定非 JSON/挑战页。init 已由 service 层归一化。 */
    pageFetch(domain: string, url: string, init?: Record<string, unknown>): Promise<{
        status: number;
        body: string;
    }>;
    /**
     * 渲染档：域 tab 真导航到 url → 等 readyState=complete + waitMs 稳定 →
     * 取 outerHTML → 导航回轻量页（tab 是域的 fetch origin，不还给它就漂移了）。
     * 挑战页 JS 在导航里自然跑完（含 reload 链），拿到的 DOM 是渲染后的。
     */
    renderPage(domain: string, url: string, opts?: {
        waitMs?: number;
    }): Promise<{
        status: number;
        html: string;
        url: string;
    }>;
    /** 域→tab 清单（watchdog/状态展示用）。 */
    domains(): string[];
    /** 巡检：实例活着、tab 在、URL 没漂（skipDrift 命中的域跳过——授权登录中）。 */
    sweep(): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=tabs.d.ts.map