/**
 * 域→tab 池 + 页面内 fetch：每个 API 源一个「轻量同源页」tab（默认 robots.txt），
 * fetch 在该页 Runtime.evaluate 执行——同源无 CORS、cookie/Origin 全真。
 */
import { Cdp } from './cdp.js';
/** 域的轻量页：API 所在源的 robots.txt（同源保证；失败时退回域根页）。 */
export function lightPageFor(domain) {
    return `https://${domain}/robots.txt`;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export class TabPool {
    inst;
    skipDrift;
    cdp;
    connecting;
    tabs = new Map(); // domain → tab
    inflight = new Map(); // domain → ensure 进行中（并发去重，防双开 tab）
    log;
    constructor(inst, log, 
    /** 返回 true 的域跳过漂移修复——授权登录中（用户可能正跨域 OAuth），抢回 tab 会打断流程。
     *  watchdog 巡检与 ensure 的缓存修复共用这一谓词。 */
    skipDrift) {
        this.inst = inst;
        this.skipDrift = skipDrift;
        this.log = log;
    }
    /** firstUrl 只在冷启动生效——窗口首 tab 直接开目标页，不留 about:blank 空壳。 */
    async conn(firstUrl) {
        const info = await this.inst.ensure(firstUrl);
        if (!this.cdp || this.cdp.closed) {
            // 并发去重：两个同时到达的 conn 只建一条 WS，否则先建的那条会泄漏
            this.connecting ??= Cdp.connect(info.browserWsUrl)
                .then((c) => { this.cdp = c; return c; })
                .finally(() => { this.connecting = undefined; });
            await this.connecting;
        }
        return { cdp: this.cdp, info };
    }
    /** 窗口显隐：worker 冷启动最小化（无声基建），用户主动操作恢复前台。best-effort，失败不阻塞。 */
    async setWindowState(cdp, state) {
        try {
            const { targetInfos } = await cdp.call('Target.getTargets');
            const page = (targetInfos ?? []).find((t) => t.type === 'page');
            if (!page)
                return;
            const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId: page.targetId });
            await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
        }
        catch (e) {
            this.log.info(`setWindowState(${state}) ignored: ${e.message}`);
        }
    }
    /** 取/建某域的轻量页 tab，返回 attach 好的 sessionId。并发调用按 domain 去重。
     *  coldWindowState：冷启动时窗口怎么摆——worker 路径最小化，用户路径（activate）恢复前台。 */
    ensure(domain, coldWindowState = 'minimized') {
        let task = this.inflight.get(domain);
        if (!task) {
            task = this.ensure0(domain, coldWindowState).finally(() => { this.inflight.delete(domain); });
            this.inflight.set(domain, task);
        }
        return task;
    }
    async ensure0(domain, coldWindowState) {
        const want = lightPageFor(domain);
        const { cdp } = await this.conn(want);
        const cold = this.inst.consumeColdStart();
        if (cold)
            await this.setWindowState(cdp, coldWindowState);
        const sameHost = (u) => u === want || safeUrl(u)?.hostname === domain;
        const cached = this.tabs.get(domain);
        const { targetInfos } = await cdp.call('Target.getTargets');
        const pages = (targetInfos ?? []).filter((t) => t.type === 'page');
        // 缓存命中也要复核 origin：漂移/授权跳转回来后 origin 可能已不对——
        // chrome-error 等 opaque origin 页面里 fetch 必挂且不自愈，只在建 tab 时校验一次是不够的
        if (cached && pages.some((t) => t.targetId === cached.targetId)) {
            let host = await this.originHost(cdp, cached.sessionId).catch(() => undefined);
            if (host === domain)
                return cached;
            // 授权流程中不抢 tab（与 watchdog 的 skipDrift 一致）：cross-origin 失败交给消费方
            if (this.skipDrift?.(domain))
                return cached;
            const nav = await cdp.call('Page.navigate', { url: want }, cached.sessionId).then(() => true, () => false);
            if (nav) {
                await this.waitLoaded(cdp, cached.targetId, sameHost);
                host = await this.originHost(cdp, cached.sessionId).catch(() => undefined);
                if (host === domain)
                    return cached;
            }
            this.tabs.delete(domain); // session 失效或修不回来 → 走下方重建
        }
        // 找已存在的同域 tab：仅冷启动时首 tab 可能还在导航中——先等它落地，避免同 URL 双开。
        // （非冷启动的缓存 miss 直接 createTarget，不再白等 3.2s 轮询）
        let target = pages.find((t) => sameHost(t.url));
        if (!target && cold)
            target = await this.waitForTarget(cdp, (t) => sameHost(t.url));
        if (!target) {
            const { targetId } = await cdp.call('Target.createTarget', { url: want, background: true });
            target = { targetId, type: 'page', url: want };
            await this.waitLoaded(cdp, targetId, sameHost);
        }
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const tab = { targetId: target.targetId, sessionId, url: target.url };
        // 轻量页加载失败会停在 chrome-error://（opaque origin，页面 fetch 必挂且不自愈）——
        // origin 校验不属目标域时回退到域根页兜底
        let host = await this.originHost(cdp, sessionId).catch(() => undefined);
        if (host !== domain) {
            await cdp.call('Page.navigate', { url: `https://${domain}/` }, sessionId).catch(() => { });
            await this.waitLoaded(cdp, target.targetId, (u) => safeUrl(u)?.hostname === domain);
        }
        this.tabs.set(domain, tab);
        return tab;
    }
    /** 短轮询等一个满足条件的 page target 出现（冷启动首个 tab 正在导航时用）。 */
    async waitForTarget(cdp, match, tries = 8) {
        for (let i = 0; i < tries; i++) {
            await sleep(400);
            const { targetInfos } = await cdp.call('Target.getTargets');
            const hit = (targetInfos ?? []).find((t) => t.type === 'page' && match(t));
            if (hit)
                return hit;
        }
        return undefined;
    }
    /** 等 target 落地到 match 的 URL（最多 8s）。失败不算致命——fetch 时再验 origin。 */
    async waitLoaded(cdp, targetId, match) {
        for (let i = 0; i < 16; i++) {
            await sleep(500);
            const { targetInfos } = await cdp.call('Target.getTargets');
            const t = (targetInfos ?? []).find((x) => x.targetId === targetId);
            if (!t)
                return;
            if (match ? match(t.url) : (t.url !== 'about:blank' && t.url !== 'chrome://new-tab-page/'))
                return;
        }
    }
    /** tab 当前 location.origin 的 hostname；opaque origin（'null'）等解析失败 → undefined。 */
    async originHost(cdp, sessionId) {
        const { result } = await this.evalRaw(sessionId, 'location.origin');
        return safeUrl(String(result?.value ?? ''))?.hostname;
    }
    /** tab 漂出预期域 → navigate 回轻量页（watchdog 调用）。 */
    async resetIfDrifted(cdp, domain) {
        const tab = this.tabs.get(domain);
        if (!tab)
            return;
        try {
            const { result } = await this.evalRaw(tab.sessionId, 'location.href');
            const url = String(result?.value ?? '');
            const host = safeUrl(url)?.hostname;
            if (host !== domain && !host?.endsWith(`.${domain}`)) {
                await cdp.call('Page.navigate', { url: lightPageFor(domain) }, tab.sessionId);
                this.log.info(`tab for ${domain} drifted to ${url}; navigated back`);
            }
        }
        catch { /* tab 可能已死，下次 ensure 重建 */ }
    }
    /** 在 tab 上下文执行表达式（awaitPromise）。超时由 cdp.call 计时（Runtime.evaluate 本身没有
     *  timeout 参数）；页内任务超时后仍在跑、结果被丢弃——对只读 fetch 无害。 */
    async evalRaw(sessionId, expression, timeoutMs = 15_000) {
        const { cdp } = await this.conn();
        return cdp.call('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true,
        }, sessionId, timeoutMs);
    }
    /** 激活 tab 到前台（授权态：用户登录/过验证）。 */
    async activate(domain) {
        const { cdp } = await this.conn(lightPageFor(domain));
        await this.setWindowState(cdp, 'normal'); // 可能缩在 Dock——恢复
        const tab = await this.ensure(domain, 'normal'); // 用户路径：冷启动也不最小化
        await cdp.call('Target.activateTarget', { targetId: tab.targetId });
    }
    /** 用户主动开一个前台页面（设置页「打开 Chrome」/授权 URL）——不走域白名单，用户的窗口用户作主。 */
    async openPage(url) {
        const { cdp } = await this.conn(url);
        const cold = this.inst.consumeColdStart();
        await this.setWindowState(cdp, 'normal');
        const { targetInfos } = await cdp.call('Target.getTargets');
        const pages = (targetInfos ?? []).filter((t) => t.type === 'page');
        const parsed = safeUrl(url);
        const bring = (t) => cdp.call('Target.activateTarget', { targetId: t.targetId });
        // 精确 URL 优先；其次同 origin（重定向后的落地页也算「已开着」——避免每次点都双开 tab）
        const existing = pages.find((t) => t.url === url)
            ?? (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
                ? pages.find((t) => safeUrl(t.url)?.origin === parsed.origin)
                : undefined);
        if (existing) {
            await bring(existing);
            return;
        }
        // 冷启动时窗口首 tab 已在本 URL 导航中——等它出现而不是再开一个
        if (cold && parsed) {
            const hit = await this.waitForTarget(cdp, (t) => t.url === url || safeUrl(t.url)?.origin === parsed.origin, 4);
            if (hit) {
                await bring(hit);
                return;
            }
        }
        const { targetId } = await cdp.call('Target.createTarget', { url });
        await cdp.call('Target.activateTarget', { targetId });
    }
    /** 页面内 fetch：返回值交给调用方（adapter）判定非 JSON/挑战页。init 已由 service 层归一化。 */
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
    /**
     * 渲染档：域 tab 真导航到 url → 等 readyState=complete + waitMs 稳定 →
     * 取 outerHTML → 导航回轻量页（tab 是域的 fetch origin，不还给它就漂移了）。
     * 挑战页 JS 在导航里自然跑完（含 reload 链），拿到的 DOM 是渲染后的。
     */
    async renderPage(domain, url, opts) {
        const tab = await this.ensure(domain);
        const { cdp } = await this.conn();
        await cdp.call('Page.enable', {}, tab.sessionId).catch(() => { });
        await cdp.call('Page.navigate', { url }, tab.sessionId);
        const deadline = Date.now() + 25_000;
        let ready = false;
        while (Date.now() < deadline) {
            const { result } = await this.evalRaw(tab.sessionId, 'document.readyState').catch(() => ({ result: undefined }));
            if (result?.value === 'complete') {
                ready = true;
                break;
            }
            await sleep(500);
        }
        if (!ready)
            this.log.info(`renderPage ${domain}: readyState wait timed out, extracting anyway`);
        await sleep(Math.min(Math.max(opts?.waitMs ?? 1500, 0), 10_000));
        const { result } = await this.evalRaw(tab.sessionId, 'JSON.stringify({u: location.href, h: document.documentElement.outerHTML})');
        let html = '', finalUrl = url;
        try {
            const v = JSON.parse(String(result?.value ?? '{}'));
            html = v.h ?? '';
            finalUrl = v.u ?? url;
        }
        catch { /* 解析失败保持空 */ }
        await cdp.call('Page.navigate', { url: tab.url }, tab.sessionId).catch((e) => this.log.info(`renderPage restore light page failed: ${e.message}`));
        return { status: 200, html, url: finalUrl };
    }
    /** 域→tab 清单（watchdog/状态展示用）。 */
    domains() { return [...this.tabs.keys()]; }
    /** 巡检：实例活着、tab 在、URL 没漂（skipDrift 命中的域跳过——授权登录中）。 */
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
            for (const domain of this.tabs.keys()) {
                if (this.skipDrift?.(domain))
                    continue;
                await this.resetIfDrifted(cdp, domain);
            }
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