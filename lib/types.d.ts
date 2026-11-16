export interface LogSink {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}
export declare const noopLog: LogSink;
//# sourceMappingURL=types.d.ts.map