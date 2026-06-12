// Tiny prefix-based logger. No external deps by design.

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const prefix = (): string => `[${new Date().toISOString().slice(11, 23)}] [${scope}]`;
  return {
    info: (...args: unknown[]) => console.log(prefix(), ...args),
    warn: (...args: unknown[]) => console.warn(prefix(), ...args),
    error: (...args: unknown[]) => console.error(prefix(), ...args),
  };
}
