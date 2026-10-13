import type { Notifier, NotifyMessage } from './index.js';
import { formatMessage } from './index.js';

/** Prints to the terminal — always on when running interactively. */
export const consoleNotifier: Notifier = {
  id: 'console',
  async send(msg: NotifyMessage) {
    const text = formatMessage(msg);
    if (msg.level === 'alert' || msg.level === 'warn') {
      process.stderr.write(`\n${text}\n`);
    } else {
      process.stdout.write(`\n${text}\n`);
    }
  },
};
