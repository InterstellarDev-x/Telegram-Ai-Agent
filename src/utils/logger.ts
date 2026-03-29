export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  scope: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

class BaseLogger implements Logger {
  constructor(
    protected readonly scope: string,
    private readonly sink: (entry: LogEntry) => void,
  ) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write("error", message, data);
  }

  child(scope: string): Logger {
    return new BaseLogger(`${this.scope}:${scope}`, this.sink);
  }

  private write(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.sink({
      timestamp: new Date().toISOString(),
      scope: this.scope,
      level,
      message,
      data,
    });
  }
}

export class CallbackLogger extends BaseLogger {
  constructor(
    scope = "app",
    sink: (entry: LogEntry) => void,
  ) {
    super(scope, sink);
  }
}

export class ConsoleLogger extends BaseLogger {
  constructor(scope = "app") {
    super(scope, (entry) => {
      console.log(JSON.stringify(entry));
    });
  }
}

export class MemoryLogger extends BaseLogger {
  public readonly entries: LogEntry[] = [];

  constructor(scope = "app") {
    super(scope, (entry) => {
      this.entries.push(entry);
    });
  }
}
