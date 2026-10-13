/** Typed errors so the runner can classify failures and react appropriately. */

export type ErrorKind =
  | 'auth'
  | 'challenge'
  | 'otp'
  | 'no-slot'
  | 'selection'
  | 'form'
  | 'network'
  | 'timeout'
  | 'config'
  | 'unknown';

export class BotError extends Error {
  readonly kind: ErrorKind;
  /** True when the whole flow should be retried from a safe checkpoint. */
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(kind: ErrorKind, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'BotError';
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.cause = opts.cause;
  }
}

export function isBotError(e: unknown): e is BotError {
  return e instanceof BotError;
}

/** Wrap an unknown thrown value so logging/classification is always safe. */
export function toBotError(e: unknown): BotError {
  if (isBotError(e)) return e;
  if (e instanceof Error) return new BotError('unknown', e.message, { cause: e });
  return new BotError('unknown', String(e));
}
