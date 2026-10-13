import type { Page, BrowserContext } from 'playwright';
import type { Config } from '../config/schema.js';
import type { PortalAdapter, Credentials } from '../adapter/types.js';
import type { Notifier } from '../notify/index.js';
import type { ChallengeGuard } from './challenge.js';
import type { SessionStore } from './session.js';
import { requestOtp } from '../otp/index.js';
import { BotError } from '../util/errors.js';
import { logger } from '../util/logger.js';

export interface AuthOptions {
  adapter: PortalAdapter;
  config: Config;
  credentials: Credentials;
  notifier: Notifier;
  session: SessionStore;
  guard: ChallengeGuard;
  /** True when a persisted storageState was handed to the context. */
  stateLoaded: boolean;
}

/**
 * Get `page` to an authenticated state, reusing a saved session when possible.
 *
 * Shared by the booking runner and the `login` command so there is exactly one
 * implementation of the login/OTP/session-restore choreography.
 */
export async function ensureAuthenticated(page: Page, opts: AuthOptions): Promise<void> {
  const { adapter, credentials, notifier, guard, stateLoaded } = opts;

  await page.goto(adapter.baseUrl, { waitUntil: 'domcontentloaded' });
  await guard.ensureClear('startup');

  if (stateLoaded && (await adapter.isLoggedIn(page))) {
    logger().info('restored persisted session — skipping login');
    await notifier
      .send({ level: 'info', title: 'Session restored', body: adapter.displayName })
      .catch(() => undefined);
    return;
  }

  logger().info({ adapter: adapter.id }, 'no usable session, logging in');
  await adapter.login(page, credentials);
  await guard.ensureClear('post-login');

  if (await adapter.isOtpPromptVisible(page)) {
    await handleOtp(page, adapter, opts);
  }

  if (!(await adapter.isLoggedIn(page))) {
    throw new BotError('auth', 'login did not result in an authenticated session', {
      retryable: true,
    });
  }

  await saveSession(page.context(), opts);
  logger().info('authenticated');
}

/** Human-in-the-loop OTP: notify on every channel, take the first answer. */
export async function handleOtp(page: Page, adapter: PortalAdapter, opts: AuthOptions): Promise<void> {
  const { config, notifier } = opts;
  const telegram = (notifier as { telegram?: unknown }).telegram as
    | import('../notify/telegram.js').TelegramNotifier
    | undefined;

  for (let attempt = 1; attempt <= config.otp.maxAttempts; attempt++) {
    const code = await requestOtp({
      title: `OTP required — ${adapter.displayName}`,
      body: `Attempt ${attempt}/${config.otp.maxAttempts}. Enter the 6-digit code.`,
      timeoutMs: config.otp.timeoutSec * 1000,
      notifier,
      telegram,
    });

    try {
      await adapter.submitOtp(page, code);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger().warn({ attempt, err: message }, 'OTP rejected');
      await notifier
        .send({
          level: 'warn',
          title: 'Code rejected',
          body: `${message} — attempt ${attempt}/${config.otp.maxAttempts}`,
        })
        .catch(() => undefined);
      if (attempt === config.otp.maxAttempts) {
        throw new BotError('otp', `code rejected ${config.otp.maxAttempts} times: ${message}`, {
          retryable: false,
        });
      }
      await adapter.requestNewOtp?.(page).catch(() => undefined);
    }
  }
}

export async function saveSession(context: BrowserContext, opts: Pick<AuthOptions, 'adapter' | 'session'>): Promise<void> {
  try {
    await opts.session.save(context, opts.adapter.id, true);
  } catch (err) {
    logger().debug({ err }, 'session persist failed');
  }
}
