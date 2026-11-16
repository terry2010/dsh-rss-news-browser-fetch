export interface LogSink {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

export const noopLog: LogSink = {
  info() {},
  warn() {},
  error() {},
}
