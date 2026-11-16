/**
 * 域→tab 池 + 页面内 fetch：每个 API 源一个「轻量同源页」tab（默认 robots.txt），
 * fetch 在该页 Runtime.evaluate 执行——同源无 CORS、cookie/Origin 全真。
 */
import { Cdp } from './cdp.js';
/** 域的轻量页：API 所在源的 robots.txt（同源保证；失败时退回域根页）。 */
export function lightPageFor(domain) {
    return `https://${domain}/robots.txt`;
}
export class TabPool {
    inst;
    cdp;
    tabs = new Map(); // domain → tab
    log;
    constructor(inst, log) {
        this.inst = inst;
        this.log = log;
    }
    async conn() {
        const info = await this.inst.ensure();
        if (!this.cdp || this.cdp.closed) {
            this.cdp = await Cdp.connect(info.browserWsUrl);
        }
        return { cdp: this.cdp, info };
    }
    /** 取/建某域的轻量页 tab，返回 attach 好的 sessionId。 */
    async ensure(domain) {
        const { cdp } = await this.conn();
        const cached = this.tabs.get(domain);
        const { targetInfos } = await cdp.call('Target.getTargets');
        const pages = (targetInfos ?? []).filter((t) => t.type === 'page');
        if (cached && pages.some((t) => t.targetId === cached.targetId))
            return cached;
        // 找已存在的同域 tab（比如用户/auth 流程留下的）
        const want = lightPageFor(domain);
        let target = pages.find((t) => t.url === want || safeUrl(t.url)?.hostname === domain);
        if (!target) {
            const { targetId } = await cdp.call('Target.createTarget', { url: want, background: true });
            // 等页面落地（导航非阻塞，fetch 前有加载等待）
            target = { targetId, type: 'page', url: want };
            await this.waitLoaded(cdp, targetId);
        }
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const tab = { targetId: target.targetId, sessionId, url: target.url };
        this.tabs.set(domain, tab);
        return tab;
    }
    async waitLoaded(cdp, targetId) {
        // 新 tab 导航到 light page：最多等 8s，失败不算致命（fetch 时再验）
        for (let i = 0; i < 16; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const { targetInfos } = await cdp.call('Target.getTargets');
            const t = targetInfos.find((x) => x.targetId === targetId);
            if (t && t.url !== 'about:blank' && t.url !== 'chrome://new-tab-page/')
                return;
        }
    }
    /** tab 漂出预期域 → navigate 回轻量页（watchdog 调用）。 */
    async resetIfDrifted(domain) {
        const tab = this.tabs.get(domain);
        if (!tab)
            return;
        try {
            const { result } = await this.evalRaw(tab.sessionId, 'location.href');
            const url = String(result?.value ?? '');
            const host = safeUrl(url)?.hostname;
            if (host !== domain && !host?.endsWith(`.${domain}`)) {
                await this.cdp.call('Page.navigate', { url: lightPageFor(domain) }, tab.sessionId);
                this.log.info(`tab for ${domain} drifted to ${url}; navigated back`);
            }
        }
        catch { /* tab 可能已死，下次 ensure 重建 */ }
    }
    /** 在 tab 上下文执行表达式（awaitPromise），返回 result.value。 */
    async evalRaw(sessionId, expression, timeoutMs = 15_000) {
        const { cdp } = await this.conn();
        return cdp.call('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
        }, sessionId, timeoutMs + 1000);
    }
    /** 激活 tab 到前台（授权态：用户登录/过验证）。 */
    async activate(domain) {
        const { cdp } = await this.conn();
        const tab = await this.ensure(domain);
        await cdp.call('Target.activateTarget', { targetId: tab.targetId });
    }
    /** 页面内 fetch：返回值交给调用方（adapter）判定非 JSON/挑战页。 */
    async pageFetch(domain, url, init) {
        const tab = await this.ensure(domain);
        const expr = `fetch(${JSON.stringify(url)}, ${JSON.stringify(init ?? {})})
      .then(async r => ({ status: r.status, body: await r.text() }))
      .catch(e => ({ error: String(e) }))`;
        const { result } = await this.evalRaw(tab.sessionId, expr, 20_000);
        const v = result?.value;
        if (v?.error)
            throw new Error(`page fetch failed: ${v.error}`);
        if (typeof v?.status !== 'number')
            throw new Error('page fetch returned no result (tab dead?)');
        return { status: v.status, body: v.body ?? '' };
    }
    /** 域→tab 清单（watchdog/状态展示用）。 */
    domains() { return [...this.tabs.keys()]; }
    /** 巡检：实例活着、tab 在、URL 没漂。 */
    async sweep() {
        if (!this.inst.running)
            return;
        try {
            const { cdp } = await this.conn();
            const { targetInfos } = await cdp.call('Target.getTargets');
            const alive = new Set((targetInfos ?? []).filter((t) => t.type === 'page').map((t) => t.targetId));
            for (const [domain, tab] of [...this.tabs]) {
                if (!alive.has(tab.targetId))
                    this.tabs.delete(domain); // 用户关了 tab → 下次 ensure 重建
            }
            for (const domain of this.tabs.keys())
                await this.resetIfDrifted(domain);
        }
        catch (e) {
            this.log.warn(`watchdog sweep failed: ${e.message}`);
            if (this.cdp?.closed) {
                this.cdp = undefined;
                this.tabs.clear();
            }
        }
    }
    async close() {
        this.tabs.clear();
        this.cdp?.close();
        this.cdp = undefined;
    }
}
/** URL 解析防御：非法 URL 返回 undefined 而不是 throw。 */
function safeUrl(u) {
    try {
        return new URL(u);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=tabs.js.map