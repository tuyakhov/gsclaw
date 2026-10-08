export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export type LogWriter = (line: string, level: Exclude<LogLevel, 'silent'>) => void;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Anything whose key looks like a credential is replaced before it reaches the log line.
const SECRET_KEY =
  /token|secret|password|authorization|cookie|private_?key|assertion|credential|api_?key/i;

export const defaultWriter: LogWriter = (line, level) => {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

/** For stdio transports: stdout carries the MCP protocol, so every log line goes to stderr. */
export const stderrWriter: LogWriter = (line) => console.error(line);

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Fields = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(
  options: { level?: LogLevel; write?: LogWriter; base?: Fields } = {},
): Logger {
  const threshold = RANK[options.level ?? 'info'];
  const write = options.write ?? defaultWriter;
  const base = options.base ?? {};

  const emit = (level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Fields) => {
    if (RANK[level] < threshold) return;
    const entry = { time: new Date().toISOString(), level, msg, ...base, ...(fields ?? {}) };
    write(JSON.stringify(redact(entry)), level);
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ level: options.level, write, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
