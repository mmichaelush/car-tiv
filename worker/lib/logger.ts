/**
 * Structured logging.
 *
 * One JSON object per line, so Cloudflare's log stream can be filtered and
 * queried instead of grepped. There is no `console.log` anywhere else in the
 * Worker — a lint rule enforces it.
 *
 * Nothing that could identify a visitor is logged: no IP address, no email, no
 * request body. The rate limiter's fingerprint is a hash and is logged only as
 * its first eight characters.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that repeats `fields` on every entry. */
  child(fields: LogFields): Logger;
}

/**
 * @param minimumLevel  Entries below this level are dropped. Production runs at
 *                      `info` so a debug line cannot become a cost centre.
 */
export function createLogger(baseFields: LogFields = {}, minimumLevel: LogLevel = 'info'): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[minimumLevel];

  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (order[level] < threshold) return;
    const entry = { level, message, time: new Date().toISOString(), ...baseFields, ...fields };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else console.warn(line);
  };

  return {
    debug: (message, fields) => {
      write('debug', message, fields);
    },
    info: (message, fields) => {
      write('info', message, fields);
    },
    warn: (message, fields) => {
      write('warn', message, fields);
    },
    error: (message, fields) => {
      write('error', message, fields);
    },
    child: (fields) => createLogger({ ...baseFields, ...fields }, minimumLevel),
  };
}

/** A logger that discards everything. Used by tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
