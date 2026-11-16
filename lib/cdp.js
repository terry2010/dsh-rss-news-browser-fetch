/**
 * 最小 CDP client：Node ≥22.5 自带全局 WebSocket，零依赖。
 * 单连接复用 browser 域 + 多 sessionId（flatten attach）。
 */
export class Cdp {
    ws;
    seq = 0;
    pending = new Map();
    handlers = new Map();
    ready;
    closed = false;
    constructor(ws) {
        this.ws = ws;
        this.ready = new Promise((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error('cdp websocket error')), { once: true });
        });
        ws.addEventListener('message', (ev) => this.onMessage(ev));
        ws.addEventListener('close', () => {
            this.closed = true;
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error('cdp closed'));
            }
            this.pending.clear();
        });
    }
    static async connect(wsUrl) {
        const cdp = new Cdp(new WebSocket(wsUrl));
        await cdp.ready;
        return cdp;
    }
    on(method, cb) {
        let set = this.handlers.get(method);
        if (!set)
            this.handlers.set(method, (set = new Set()));
        set.add(cb);
    }
    async call(method, params, sessionId, timeoutMs = 15_000) {
        if (this.closed)
            throw new Error('cdp closed');
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`cdp timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve: resolve, reject, timer });
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
    onMessage(ev) {
        let msg;
        try {
            msg = JSON.parse(String(ev.data));
        }
        catch {
            return;
        }
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (!p)
                return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error)
                p.reject(new Error(msg.error.message ?? `cdp error ${msg.id}`));
            else
                p.resolve(msg.result);
            return;
        }
        if (msg.method) {
            const set = this.handlers.get(msg.method);
            if (set)
                for (const cb of set) {
                    try {
                        cb(msg.params, msg.sessionId);
                    }
                    catch { /* listener 不拖垮连接 */ }
                }
        }
    }
    close() {
        this.closed = true;
        try {
            this.ws.close();
        }
        catch { /* noop */ }
    }
}
//# sourceMappingURL=cdp.js.map