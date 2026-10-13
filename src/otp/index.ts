import { createInterface } from 'node:readline';
import type { Notifier } from '../notify/index.js';
import type { TelegramNotifier } from '../notify/telegram.js';
import { BotError } from '../util/errors.js';
import { logger } from '../util/logger.js';

export interface OtpRequestOptions {
  title: string;
  body?: string;
  timeoutMs: number;
  notifier: Notifier;
  telegram?: TelegramNotifier;
  /** Force-disable the terminal prompt (tests, non-interactive runs). */
  terminal?: boolean;
}

interface Candidate {
  name: string;
  promise: Promise<string | null>;
  cancel?: () => void;
}

/**
 * Human-in-the-loop code entry.
 *
 * Runs every available channel concurrently and takes whichever answer comes
 * first: a terminal prompt when stdin is a TTY, and/or a Telegram reply to the
 * prompt message (so you can answer from your phone while the bot runs headless
 * on a server). Times out with a typed error the runner can act on.
 */
export async function requestOtp(opts: OtpRequestOptions): Promise<string> {
  // A pre-supplied code (e.g. fetched from an SMS-forwarding integration)
  // short-circuits the interactive channels entirely.
  const provided = process.env.OTP_CODE?.trim();
  if (provided) {
    logger().info('using pre-supplied code from OTP_CODE');
    return provided;
  }

  const candidates: Candidate[] = [];

  const useTerminal = opts.terminal ?? Boolean(process.stdin.isTTY);
  if (useTerminal) candidates.push(terminalCandidate(opts.title, opts.body));

  if (opts.telegram) {
    const tg = opts.telegram;
    candidates.push({
      name: 'telegram',
      promise: (async () => {
        try {
          const messageId = await tg.sendText(
            `${opts.title}${opts.body ? `\n${opts.body}` : ''}\n\nReply to this message with the code.`,
          );
          return await tg.waitForReply(messageId, opts.timeoutMs);
        } catch (err) {
          logger().warn({ err }, 'telegram OTP channel failed');
          return null;
        }
      })(),
      cancel: () => tg.stop(),
    });
  }

  if (candidates.length === 0) {
    throw new BotError(
      'otp',
      'no OTP input channel available — run in an interactive terminal or set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID',
      { retryable: false },
    );
  }

  await opts.notifier
    .send({ level: 'alert', title: opts.title, body: opts.body ?? 'Enter the code to continue.' })
    .catch(() => undefined);

  const winner = await firstAnswer(candidates, opts.timeoutMs);
  if (!winner) {
    throw new BotError('otp', `no code received within ${Math.round(opts.timeoutMs / 1000)}s`, {
      retryable: false,
    });
  }
  return winner;
}

/** First non-empty answer wins; everyone else is cancelled; null on timeout. */
async function firstAnswer(candidates: Candidate[], timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of candidates) c.cancel?.();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    for (const c of candidates) {
      void c.promise.then((value) => {
        const v = value?.trim();
        if (v) finish(v);
      });
    }
  });
}

function terminalCandidate(title: string, body?: string): Candidate {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;

  const promise = new Promise<string | null>((resolve) => {
    const text = body ? `${title}\n${body}\n` : `${title}\n`;
    rl.question(`${text}> `, (answer) => {
      resolve(answer.trim() || null);
      safelyClose();
    });
    rl.on('close', () => {
      resolve(null);
      closed = true;
    });
  });

  function safelyClose(): void {
    if (closed) return;
    closed = true;
    try {
      rl.close();
    } catch {
      /* already closed */
    }
  }

  return { name: 'terminal', promise, cancel: safelyClose };
}
