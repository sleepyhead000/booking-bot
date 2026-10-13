import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pino, multistream, type Logger, type LoggerOptions as PinoOptions } from 'pino';

export type { Logger };

let rootLogger: Logger | undefined;
let fileStream: ReturnType<typeof createWriteStream> | undefined;

export interface InitLoggerOptions {
  level?: string;
  dir?: string;
}

const REDACT_PATHS = [
  'password',
  'username',
  'proxy',
  'proxyUrl',
  'token',
  'botToken',
  'apiKey',
  'cookies',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.proxyUrl',
];

/**
 * Create (or return) the process-wide logger. Writes JSON lines to
 * storage/logs/bot.log as well as stdout so failures can be diagnosed later.
 */
export function initLogger(opts: InitLoggerOptions = {}): Logger {
  if (rootLogger) return rootLogger;

  const pinoOpts: PinoOptions = {
    level: opts.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.dir) {
    const dir = resolve(opts.dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fileStream = createWriteStream(resolve(dir, 'bot.log'), { flags: 'a' });
    rootLogger = pino(
      pinoOpts,
      multistream([{ stream: process.stdout }, { stream: fileStream }]),
    );
  } else {
    rootLogger = pino(pinoOpts);
  }

  return rootLogger;
}

export function logger(): Logger {
  return rootLogger ?? initLogger();
}

/** Flush and close the log file stream on shutdown. */
export async function closeLogger(): Promise<void> {
  if (!fileStream) return;
  const stream = fileStream;
  fileStream = undefined;
  rootLogger = undefined;
  await new Promise<void>((res) => stream.end(() => res()));
}
