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
    private cdp?;
    private tabs;
    private readonly log;
    constructor(inst: ChromeInstance, log: LogSink);
    private conn;
    /** 取/建某域的轻量页 tab，返回 attach 好的 sessionId。 */
    ensure(domain: string): Promise<PageTab>;
    private waitLoaded;
    /** tab 漂出预期域 → navigate 回轻量页（watchdog 调用）。 */
    resetIfDrifted(domain: string): Promise<void>;
    /** 在 tab 上下文执行表达式（awaitPromise），返回 result.value。 */
    evalRaw<T = unknown>(sessionId: string, expression: string, timeoutMs?: number): Promise<{
        result?: {
            value?: T;
        };
    }>;
    /** 激活 tab 到前台（授权态：用户登录/过验证）。 */
    activate(domain: string): Promise<void>;
    /** 页面内 fetch：返回值交给调用方（adapter）判定非 JSON/挑战页。 */
    pageFetch(domain: string, url: string, init?: RequestInit): Promise<{
        status: number;
        body: string;
    }>;
    /** 域→tab 清单（watchdog/状态展示用）。 */
    domains(): string[];
    /** 巡检：实例活着、tab 在、URL 没漂。 */
    sweep(): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=tabs.d.ts.map