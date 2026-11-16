/**
 * 最小 CDP client：Node ≥22.5 自带全局 WebSocket，零依赖。
 * 单连接复用 browser 域 + 多 sessionId（flatten attach）。
 */
type EventHandler = (params: unknown, sessionId?: string) => void;
export declare class Cdp {
    private ws;
    private seq;
    private pending;
    private handlers;
    private ready;
    closed: boolean;
    private constructor();
    static connect(wsUrl: string): Promise<Cdp>;
    on(method: string, cb: EventHandler): void;
    call<T = unknown>(method: string, params?: unknown, sessionId?: string, timeoutMs?: number): Promise<T>;
    private onMessage;
    close(): void;
}
export {};
//# sourceMappingURL=cdp.d.ts.map