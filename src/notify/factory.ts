import type { Notifier } from './index.js';
import { consoleNotifier } from './console.js';
import { TelegramNotifier } from './telegram.js';
import type { Config } from '../config/schema.js';
import { logger } from '../util/logger.js';

export type NotifierWithTelegram = Notifier & { telegram?: TelegramNotifier };

/**
 * Build the notification fan-out from config + available credentials.
 * Telegram is only added when both token and chat id are present.
 */
export function createNotifier(config: Config): NotifierWithTelegram {
  const targets: Notifier[] = [];
  let telegram: TelegramNotifier | undefined;

  if (config.notify.telegram) {
    const t = TelegramNotifier.fromEnv();
    if (t) {
      telegram = t;
      targets.push(t);
    } else {
      logger().debug('telegram notifications requested but TELEGRAM_BOT_TOKEN/CHAT_ID missing');
    }
  }
  if (config.notify.console) targets.push(consoleNotifier);

  return {
    id: 'hub',
    telegram,
    async send(msg) {
      await Promise.allSettled(targets.map((t) => t.send(msg)));
    },
  };
}
