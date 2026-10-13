import { logger } from '../util/logger.js';

export type NotifyLevel = 'info' | 'success' | 'warn' | 'alert';

export interface NotifyMessage {
  level: NotifyLevel;
  title: string;
  body?: string;
}

export interface Notifier {
  readonly id: string;
  send(msg: NotifyMessage): Promise<void>;
}

/**
 * Fan-out hub. Every notifier gets the message; one failing channel never
 * breaks the others (losing a Telegram message must not abort a booking).
 */
export class NotifierHub implements Notifier {
  readonly id = 'hub';
  private readonly targets: Notifier[];

  constructor(targets: Notifier[]) {
    this.targets = targets;
  }

  async send(msg: NotifyMessage): Promise<void> {
    const results = await Promise.allSettled(this.targets.map((t) => t.send(msg)));
    for (const [i, r] of results.entries()) {
      if (r.status === 'rejected') {
        logger().warn({ channel: this.targets[i]?.id, err: r.reason }, 'notification failed');
      }
    }
  }
}

/** Discards everything — used in tests and when notifications are disabled. */
export const nullNotifier: Notifier = {
  id: 'null',
  async send() {
    /* no-op */
  },
};

const ICONS: Record<NotifyLevel, string> = {
  info: 'ℹ',
  success: '✔',
  warn: '⚠',
  alert: '❗',
};

export function formatMessage(msg: NotifyMessage): string {
  const lines = [`${ICONS[msg.level]} ${msg.title}`];
  if (msg.body) lines.push(msg.body);
  return lines.join('\n');
}
