/**
 * 专用 Chrome 实例生命周期：懒拉起、专用持久 profile、就绪探测、
 * 用户连关三次转「已暂停」（尊重用户意愿，给重新启用手动出口）。
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
export declare class ChromeInstance {
    private proc?;
    private info?;
    private starting?;
    private userCloses;
    private ourKill;
    paused: boolean;
    private readonly binary?;
    private readonly profileDir;
    private readonly log;
    constructor(opts: {
        dataDir: string;
        log: LogSink;
    });
    get available(): boolean;
    get running(): boolean;
    /** 懒拉起：未启动则拉起并等待就绪；已暂停/无浏览器则抛错。 */
    ensure(firstUrl?: string): Promise<InstanceInfo>;
    private spawn;
    /** 用户关了实例/窗口：自动重拉，连关 ≥3 转已暂停（不再自动拉起）。 */
    private onExit;
    /** 手动恢复（面板「重新启用」按钮）。 */
    resume(): void;
    stop(): Promise<void>;
}
//# sourceMappingURL=instance.d.ts.map