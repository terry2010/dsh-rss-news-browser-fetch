/**
 * 专用 Chrome 实例生命周期：懒拉起、专用持久 profile、就绪探测、
 * 孤儿实例收割（instance.json 记 pid+端口）、用户连关三次转「已暂停」。
 *
 * 硬约束（Chrome 136+）：--remote-debugging-port 只在非默认 --user-data-dir 下生效。
 * 插件自有 profile → 与用户主浏览器完全隔离（cookie jar 独立，登录一次长期有效）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { locateBrowser } from './locate.js';
const USER_CLOSE_LIMIT = 3;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 300;
const STOP_GRACE_MS = 3_000;
const CRASH_SIGNALS = ['SIGSEGV', 'SIGBUS', 'SIGABRT', 'SIGILL', 'SIGFPE'];
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
        });
        srv.on('error', reject);
    });
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** 进程存活探测（kill 0）。 */
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 出口分类（纯函数，导出供测试）：
 *  - ours      自己 kill 的（stop/dispose/超时回收）
 *  - boot-fail 启动期内退出——典型是 profile 被上一轮孤儿实例占用（单例交接后即刻退出），不算用户关闭
 *  - crash     非零退出码或崩溃信号——不计用户关闭
 *  - user      干净退出 / 终止信号（TERM/HUP/INT/KILL）——计一次用户关闭
 */
export function classifyExit(code, signal, ourKill, booting) {
    if (ourKill)
        return 'ours';
    if (booting)
        return 'boot-fail';
    const crash = (code !== 0 && code !== null)
        || (signal !== null && CRASH_SIGNALS.includes(signal));
    return crash ? 'crash' : 'user';
}
/**
 * 连关计数状态机（导出供测试）。只有显式 resume() 才清零——自动重拉不清零：
 * 否则高频消费下每次自动重拉都清零，「连关 3 次转暂停」永远达不到。
 */
export class CloseCounter {
    limit;
    n = 0;
    paused = false;
    constructor(limit) {
        this.limit = limit;
    }
    get count() { return this.n; }
    bump() {
        this.n += 1;
        if (this.n >= this.limit)
            this.paused = true;
    }
    resume() {
        this.paused = false;
        this.n = 0;
    }
}
export class ChromeInstance {
    proc;
    info;
    starting;
    booting = false;
    ourKill = false;
    coldStart = false;
    closes = new CloseCounter(USER_CLOSE_LIMIT);
    /** 取值函数：每次冷启动重读——改代理后下次拉起即生效（进程级参数，运行中不改） */
    proxyUrl;
    binary;
    profileDir;
    stateFile;
    log;
    constructor(opts) {
        this.log = opts.log;
        this.proxyUrl = opts.proxyUrl;
        this.profileDir = join(opts.dataDir, 'chrome-profile');
        this.stateFile = join(opts.dataDir, 'instance.json');
        this.binary = locateBrowser();
        if (!this.binary)
            this.log.warn('no Chromium-based browser found; browserFetch disabled');
    }
    get available() { return !!this.binary; }
    get running() { return !!this.info && !this.paused; }
    get paused() { return this.closes.paused; }
    get binaryPath() { return this.binary; }
    get profile() { return this.profileDir; }
    /** 本次 ensure 是否触发了冷启动（消费一次——工位路径据此最小化窗口，用户路径据此恢复窗口）。 */
    consumeColdStart() { const c = this.coldStart; this.coldStart = false; return c; }
    /** 懒拉起：未启动则拉起并等待就绪；已暂停/无浏览器则抛错。 */
    async ensure(firstUrl) {
        if (this.paused)
            throw new Error('browser-fetch paused (user closed the instance repeatedly)');
        if (!this.binary)
            throw new Error('no Chromium-based browser found');
        if (this.info && this.proc && !this.proc.killed)
            return this.info;
        this.starting ??= this.spawn(firstUrl).finally(() => { this.starting = undefined; });
        return this.starting;
    }
    async spawn(firstUrl) {
        await this.reapOrphan();
        const port = await freePort();
        mkdirSync(this.profileDir, { recursive: true });
        const args = [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${this.profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate',
            '--disable-session-crashed-bubble',
            '--hide-crash-restore-bubble',
            '--silent-launch', // macOS：拉起不抢前台焦点（worker 路径随后 CDP 最小化，用户路径照常显示）
        ];
        const proxy = this.proxyUrl?.();
        if (proxy)
            args.push(`--proxy-server=${proxy}`);
        args.push(firstUrl ?? 'about:blank');
        this.ourKill = false;
        this.booting = true;
        const proc = spawn(this.binary, args, { detached: true, stdio: 'ignore' });
        this.proc = proc;
        proc.unref();
        // pid+端口立刻落盘：即便宿主此刻崩溃，下一轮也能按 pid 收割这个孤儿
        if (proc.pid)
            this.writeState({ pid: proc.pid, port, startedAt: Date.now() });
        proc.on('exit', (code, signal) => this.onExit(code, signal));
        const deadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
            // 启动期内进程已退出（典型：profile 被孤儿占用 → 单例交接后即刻退出）——别干等 15s
            if (proc.exitCode !== null || proc.signalCode !== null) {
                throw new Error('chrome exited during startup (profile held by another instance?); will retry on next fetch');
            }
            const info = await this.probe(port);
            if (info) {
                this.info = info;
                this.booting = false;
                this.coldStart = true;
                this.log.info(`chrome instance ready on 127.0.0.1:${port} (profile ${this.profileDir})`);
                return this.info;
            }
            if (Date.now() > deadline) {
                try {
                    proc.kill();
                }
                catch { /* noop */ }
                throw new Error('chrome instance did not become ready in time');
            }
            await sleep(READY_POLL_MS);
        }
    }
    /** 就绪探测：/json/version 带 webSocketDebuggerUrl 即视为 CDP 就绪。 */
    async probe(port, timeoutMs = 1500) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
            const j = (await r.json());
            if (typeof j.webSocketDebuggerUrl === 'string' && j.webSocketDebuggerUrl) {
                return { port, httpBase: `http://127.0.0.1:${port}`, browserWsUrl: j.webSocketDebuggerUrl };
            }
        }
        catch { /* 未就绪继续等/不认账 */ }
        return undefined;
    }
    /** 收割上一轮宿主留下的孤儿实例：SIGTERM → 宽限 → SIGKILL，随后留出单例锁释放余量。 */
    async reapOrphan() {
        const st = this.readState();
        this.clearState();
        if (!st || !pidAlive(st.pid))
            return;
        // 端口仍在服务 CDP 才认账——防止 pid 复用/端口易主时误杀无关进程
        if (!(await this.probe(st.port))) {
            this.log.warn(`stale instance record pid ${st.pid} alive but port ${st.port} is not serving CDP; leaving it alone`);
            return;
        }
        this.log.info(`reaping orphaned chrome instance from a previous run (pid ${st.pid}, port ${st.port})`);
        try {
            process.kill(st.pid, 'SIGTERM');
        }
        catch {
            return;
        }
        const deadline = Date.now() + STOP_GRACE_MS;
        while (Date.now() < deadline && pidAlive(st.pid))
            await sleep(200);
        if (pidAlive(st.pid)) {
            try {
                process.kill(st.pid, 'SIGKILL');
            }
            catch { /* noop */ }
        }
        await sleep(500); // profile 单例锁释放余量
    }
    writeState(st) {
        try {
            writeFileSync(this.stateFile, JSON.stringify(st));
        }
        catch { /* best-effort */ }
    }
    readState() {
        try {
            const j = JSON.parse(readFileSync(this.stateFile, 'utf8'));
            if (typeof j.pid === 'number' && j.pid > 0 && typeof j.port === 'number' && j.port > 0) {
                return { pid: j.pid, port: j.port, startedAt: j.startedAt ?? 0 };
            }
        }
        catch { /* 缺失/损坏都当作没有 */ }
        return undefined;
    }
    clearState() {
        try {
            rmSync(this.stateFile, { force: true });
        }
        catch { /* noop */ }
    }
    /** 用户关了实例/窗口：自动重拉，连关 ≥3 转已暂停（不再自动拉起）。 */
    onExit(code, signal) {
        this.info = undefined;
        this.proc = undefined;
        this.clearState(); // pid 已死，记录作废
        const kind = classifyExit(code, signal, this.ourKill, this.booting);
        if (kind === 'ours')
            return;
        if (kind === 'boot-fail') {
            this.log.warn('chrome exited during startup (profile held by another instance?); will retry on next fetch');
            return;
        }
        if (kind === 'crash') {
            this.log.warn(`chrome instance crashed (code ${code}, signal ${signal}); will respawn on next fetch`);
            return;
        }
        this.closes.bump();
        if (this.closes.paused) {
            this.log.warn(`chrome instance closed ${this.closes.count}× by user → paused; call resume() to re-enable`);
            return;
        }
        this.log.warn(`chrome instance exited (user close ${this.closes.count}/${USER_CLOSE_LIMIT}); will respawn on next fetch`);
    }
    /** 手动恢复（面板「重新启用」按钮）——唯一的连关计数清零入口。 */
    resume() {
        this.closes.resume();
    }
    /** 杀实例并等待退出（SIGTERM 宽限 → SIGKILL）：不等待的话下一个实例会撞上未释放的 profile 单例锁。 */
    async stop() {
        this.ourKill = true;
        this.info = undefined;
        const p = this.proc;
        this.proc = undefined;
        if (!p || p.exitCode !== null || p.signalCode !== null) {
            this.clearState();
            return;
        }
        const exited = new Promise((resolve) => p.once('exit', () => resolve()));
        try {
            p.kill('SIGTERM');
        }
        catch { /* noop */ }
        await Promise.race([exited, sleep(STOP_GRACE_MS)]);
        if (p.exitCode === null && p.signalCode === null) {
            try {
                p.kill('SIGKILL');
            }
            catch { /* noop */ }
            await Promise.race([exited, sleep(1_000)]);
        }
        this.clearState();
    }
}
//# sourceMappingURL=instance.js.map