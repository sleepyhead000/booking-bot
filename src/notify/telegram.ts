import type { Notifier, NotifyMessage } from './index.js';
import { formatMessage } from './index.js';
import { logger } from '../util/logger.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}

type Listener = (msg: { messageId: number; text: string; replyTo?: number }) => void;

/**
 * Telegram transport.
 *
 * Besides plain notifications it supports the human-in-the-loop round trip:
 * we send a message, then wait for the operator to *reply to it*. That is what
 * makes remote OTP entry possible while the bot runs headless on a server.
 */
export class TelegramNotifier implements Notifier {
  readonly id = 'telegram';
  private readonly token: string;
  private readonly chatId: string;
  private readonly base: string;
  private offset = 0;
  private polling = false;
  private readonly listeners = new Set<Listener>();

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  static fromEnv(): TelegramNotifier | null {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!token || !chatId) return null;
    return new TelegramNotifier(token, chatId);
  }

  async send(msg: NotifyMessage): Promise<void> {
    await this.sendText(formatMessage(msg));
  }

  async sendText(text: string): Promise<number> {
    const res = await fetch(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { result: { message_id: number } };
    return data.result.message_id;
  }

  /**
   * Wait for the operator to reply to `messageId` (or send a bare code).
   * Resolves with their text, or null on timeout.
   */
  async waitForReply(messageId: number, timeoutMs: number): Promise<string | null> {
    this.startPolling();
    return new Promise<string | null>((resolve) => {
      const done = (value: string | null) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(value);
      };
      const listener: Listener = (m) => {
        const isDirectReply = m.replyTo === messageId;
        const looksLikeCode = /^\d{4,8}$/.test(m.text);
        if (isDirectReply || looksLikeCode) done(m.text);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.listeners.add(listener);
    });
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop();
  }

  /** Long-poll getUpdates; drops webhook conflicts; fans out to listeners. */
  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const res = await fetch(
          `${this.base}/getUpdates?offset=${this.offset}&timeout=25&allowed_updates=${encodeURIComponent(
            '["message"]',
          )}`,
          { signal: AbortSignal.timeout(40_000) },
        );
        if (!res.ok) {
          logger().warn({ status: res.status }, 'telegram getUpdates failed, backing off');
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        const data = (await res.json()) as { result: TelegramUpdate[] };
        for (const update of data.result) {
          this.offset = update.update_id + 1;
          const m = update.message;
          if (!m?.text || String(m.chat.id) !== this.chatId) continue;
          for (const l of [...this.listeners]) {
            l({ messageId: m.message_id, text: m.text, replyTo: m.reply_to_message?.message_id });
          }
        }
      } catch (err) {
        logger().debug({ err }, 'telegram poll error');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  stop(): void {
    this.polling = false;
    this.listeners.clear();
  }
}
