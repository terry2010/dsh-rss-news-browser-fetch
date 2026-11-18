/**
 * 专用 Chrome 实例生命周期：懒拉起、专用持久 profile、就绪探测、
 * 孤儿实例收割（instance.json 记 pid+端口）、用户连关三次转「已暂停」。
 *
 * 硬约束（Chrome 136+）：--remote-debugging-port 只在非默认 --user-data-dir 下生效。
 * 插件自有 profile → 与用户主浏览器完全隔离（cookie jar 独立，登录一次长期有效）。
 */
import type { LogSink } from './types.js';
export interface InstanceInfo {
    port: number;
    httpBase: string;
    browserWsUrl: string;
}
/**
 * 出口分类（纯函数，导出供测试）：
 *  - ours      自己 kill 的（stop/dispose/超时回收）
 *  - boot-fail 启动期内退出——典型是 profile 被上一轮孤儿实例占用（单例交接后即刻退出），不算用户关闭
 *  - crash     非零退出码或崩溃信号——不计用户关闭
 *  - user      干净退出 / 终止信号（TERM/HUP/INT/KILL）——计一次用户关闭
 */
export declare function classifyExit(code: number | null, signal: NodeJS.Signals | null, ourKill: boolean, booting: boolean): 'ours' | 'boot-fail' | 'crash' | 'user';
/**
 * 连关计数状态机（导出供测试）。只有显式 resume() 才清零——自动重拉不清零：
 * 否则高频消费下每次自动重拉都清零，「连关 3 次转暂停」永远达不到。
 */
export declare class CloseCounter {
    private readonly limit;
    private n;
    paused: boolean;
    constructor(limit: number);
    get count(): number;
    bump(): void;
    resume(): void;
}
export declare class ChromeInstance {
    private proc?;
    private info?;
    private starting?;
    private booting;
    private ourKill;
    private coldStart;
    private readonly closes;
    /** 取值函数：每次冷启动重读——改代理后下次拉起即生效（进程级参数，运行中不改） */
    private readonly proxyUrl?;
    private readonly binary?;
    private readonly profileDir;
    private readonly stateFile;
    private readonly log;
    constructor(opts: {
        dataDir: string;
        log: LogSink;
        proxyUrl?: () => string | undefined;
    });
    get available(): boolean;
    get running(): boolean;
    get paused(): boolean;
    get binaryPath(): string | undefined;
    get profile(): string;
    /** 本次 ensure 是否触发了冷启动（消费一次——工位路径据此最小化窗口，用户路径据此恢复窗口）。 */
    consumeColdStart(): boolean;
    /** 懒拉起：未启动则拉起并等待就绪；已暂停/无浏览器则抛错。 */
    ensure(firstUrl?: string): Promise<InstanceInfo>;
    private spawn;
    /** 就绪探测：/json/version 带 webSocketDebuggerUrl 即视为 CDP 就绪。 */
    private probe;
    /** 收割上一轮宿主留下的孤儿实例：SIGTERM → 宽限 → SIGKILL，随后留出单例锁释放余量。 */
    private reapOrphan;
    private writeState;
    private readState;
    private clearState;
    /** 用户关了实例/窗口：自动重拉，连关 ≥3 转已暂停（不再自动拉起）。 */
    private onExit;
    /** 手动恢复（面板「重新启用」按钮）——唯一的连关计数清零入口。 */
    resume(): void;
    /** 杀实例并等待退出（SIGTERM 宽限 → SIGKILL）：不等待的话下一个实例会撞上未释放的 profile 单例锁。 */
    stop(): Promise<void>;
}
//# sourceMappingURL=instance.d.ts.map