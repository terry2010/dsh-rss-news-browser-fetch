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
import { ChromeInstance } from './instance.js';
import { TabPool, lightPageFor } from './tabs.js';
export class BrowserFetchService extends Service {
    apiVersion = 1;
    log;
    inst;
    pool;
    callers = new Map(); // caller → domains（审计）
    declared = new Set(); // 域并集白名单
    authDomains = new Set(); // auth-required 标记
    sweepTimer;
    constructor(ctx, opts) {
        super(ctx, 'browserFetch');
        this.log = opts.log;
        this.inst = new ChromeInstance({ dataDir: opts.dataDir, log: opts.log });
        this.pool = new TabPool(this.inst, opts.log);
        // 巡检：5min 一轮，修复幂等；用 ctx.effect 挂卸载清理
        this.sweepTimer = setInterval(() => void this.pool.sweep(), 5 * 60_000);
        this.sweepTimer.unref?.();
        ctx.effect(() => () => this.dispose(), 'browser-fetch dispose');
    }
    /** 调用方先声明域——只放行声明过的域（及子域）。 */
    declareDomains(caller, domains) {
        const clean = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
        this.callers.set(caller, [...(this.callers.get(caller) ?? []), ...clean]);
        for (const d of clean)
            this.declared.add(d);
    }
    /** url 的 hostname 必须是已声明域或其子域——白名单唯一防线。 */
    assertAllowed(domain, url) {
        let host = '';
        try {
            host = new URL(url).hostname.toLowerCase();
        }
        catch {
            throw new Error(`browserFetch: bad url ${url}`);
        }
        const d = domain.toLowerCase();
        if (!this.declared.has(d))
            throw new Error(`browserFetch: domain "${domain}" not declared (call declareDomains first)`);
        if (host !== d && !host.endsWith(`.${d}`)) {
            throw new Error(`browserFetch: url host "${host}" is outside declared domain "${d}"`);
        }
    }
    /** 域的轻量同源页内执行 fetch。实例未启动时懒拉起。 */
    async fetch(domain, url, init) {
        this.assertAllowed(domain, url);
        const r = await this.pool.pageFetch(domain, url, init);
        return { status: r.status, body: r.body };
    }
    /** 某域当前是否需要用户授权（登录墙/验证码）——adapter 置位，源包据此标源状态。 */
    authRequired(domain) {
        return this.authDomains.has(domain.toLowerCase());
    }
    /** adapter 判定登录墙/挑战页后调用；恢复后再 markAuthRequired(domain,false)。 */
    markAuthRequired(domain, on = true) {
        const d = domain.toLowerCase();
        if (on) {
            this.authDomains.add(d);
            this.log.info(`domain ${d} marked auth-required`);
        }
        else
            this.authDomains.delete(d);
    }
    /** 把该域 tab 顶到前台让用户登录/过验证；返回是否成功激活。 */
    async openForAuth(domain, url) {
        try {
            await this.inst.ensure(url ?? lightPageFor(domain));
            await this.pool.activate(domain);
            return true;
        }
        catch (e) {
            this.log.warn(`openForAuth(${domain}) failed: ${e.message}`);
            return false;
        }
    }
    /** 用户连关后手动恢复实例。 */
    resume() {
        this.inst.resume();
    }
    status() {
        return {
            available: this.inst.available,
            running: this.inst.running,
            paused: this.inst.paused,
            domains: [...this.declared],
            tabs: this.pool.domains(),
            authRequired: [...this.authDomains],
        };
    }
    async dispose() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
        await this.pool.close();
        await this.inst.stop();
    }
}
//# sourceMappingURL=service.js.map