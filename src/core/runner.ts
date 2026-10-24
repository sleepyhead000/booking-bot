import type { Page, BrowserContext } from 'playwright';
import type { Config, TargetFilter } from '../config/schema.js';
import type { PortalAdapter, Slot, ApplicationData, Credentials } from '../adapter/types.js';
import type { Notifier } from '../notify/index.js';
import { BrowserManager, type ContextOptions } from './browser.js';
import { SessionStore } from './session.js';
import { ChallengeGuard } from './challenge.js';
import { ensureAuthenticated, saveSession } from './auth.js';
import { pickBest, explainFilter } from '../monitor/filter.js';
import { Poller } from '../monitor/poller.js';
import { BotError, toBotError } from '../util/errors.js';
import { captureFailure } from '../util/artifacts.js';
import { logger } from '../util/logger.js';
import { sleep } from '../util/async.js';

export type RunMode = 'once' | 'monitor' | 'inspect';

export interface RunResult {
  status: 'booked' | 'no-slot' | 'cancelled' | 'inspect';
  slot?: Slot;
  slots?: Slot[];
  detail?: string;
  cycles: number;
}

export interface RunnerDeps {
  config: Config;
  adapter: PortalAdapter;
  notifier: Notifier;
  session: SessionStore;
  manager: BrowserManager;
  filter: TargetFilter;
  credentials: Credentials;
  application: ApplicationData;
  signal?: AbortSignal;
  /** Extra browser-context options — video recording, proxy override, headers. */
  contextOptions?: ContextOptions;
}

/**
 * Orchestrates a run: authenticate (reusing the session when possible), then
 *   - `inspect`:  report current matching availability and exit
 *   - `once`:     one poll, book immediately if something matches
 *   - `monitor`:  poll until a target slot appears, then book it
 *
 * Failures are classified through BotError.kind so recovery is deliberate
 * rather than a blanket retry: auth problems clear the session and log in
 * again, challenges go to the guard, OTP problems go back to the operator.
 */
export class BookingRunner {
  private readonly guard: ChallengeGuard;
  private page?: Page;
  private lastSlots: Slot[] = [];
  private authFailures = 0;
  private authenticated = false;

  constructor(private readonly deps: RunnerDeps) {
    this.guard = new ChallengeGuard(
      () => {
        if (!this.page) throw new Error('page not open yet');
        return this.page;
      },
      deps.config,
      deps.notifier,
    );
  }

  async run(mode: RunMode): Promise<RunResult> {
    const { adapter, session, manager, config } = this.deps;
    const statePath = session.stateToLoad(adapter.id);

    const context = await manager.newContext({
      storageStatePath: statePath,
      ...this.deps.contextOptions,
    });
    const page = await context.newPage();
    this.page = page;

    const poller = new Poller({
      minIntervalMs: config.monitor.minIntervalMs,
      maxIntervalMs: config.monitor.maxIntervalMs,
      backoffMaxMs: config.monitor.backoffMaxMs,
      maxEmptyCycles: config.monitor.maxEmptyCycles,
    });

    try {
      await adapter.prepare?.(page);
      await ensureAuthenticated(page, this.authOptions(Boolean(statePath)));
      this.authenticated = true;

      if (mode === 'inspect') {
        const slots = await this.safeSlots(page);
        return {
          status: 'inspect',
          slots,
          detail: explainFilter(slots, this.deps.filter),
          cycles: 1,
        };
      }

      if (mode === 'once') {
        const slot = await this.tryBookOnce(page);
        return {
          status: slot ? 'booked' : 'no-slot',
          slot: slot ?? undefined,
          cycles: poller.cycles + 1,
          detail: slot ? undefined : explainFilter(this.lastSlots, this.deps.filter),
        };
      }

      while (!this.deps.signal?.aborted) {
        await this.guard.ensureClear('polling');
        const best = await this.bestSlot(page);

        if (!best) {
          poller.recordEmpty();
          if (poller.exhausted) {
            return {
              status: 'no-slot',
              cycles: poller.cycles,
              detail: explainFilter(this.lastSlots, this.deps.filter),
            };
          }
          const delay = poller.nextDelay();
          logger().debug({ ...poller.stats(), delayMs: delay }, 'no matching slot');
          await this.sleepInterruptible(delay);
          continue;
        }

        const booked = await this.tryBookOnce(page, best);
        if (booked) {
          poller.recordHit();
          return { status: 'booked', slot: booked, cycles: poller.cycles + 1 };
        }

        // Slot vanished between detection and selection — back off and retry.
        poller.recordEmpty();
        await this.sleepInterruptible(poller.nextDelay());
      }

      return { status: 'cancelled', cycles: poller.cycles, detail: 'aborted by operator' };
    } catch (err) {
      const e = toBotError(err);
      logger().error({ kind: e.kind, retryable: e.retryable, err: e.message }, 'run failed');
      await captureFailure(this.page, `run_${e.kind}`).catch(() => null);
      await this.deps.notifier
        .send({ level: 'alert', title: `Run failed (${e.kind})`, body: e.message })
        .catch(() => undefined);
      throw e;
    } finally {
      if (this.authenticated) {
        await saveSession(context as BrowserContext, this.authOptsWithoutState()).catch(() => undefined);
      }
      await context.close().catch(() => undefined);
      this.page = undefined;
      this.authenticated = false;
    }
  }

  // ------------------------------------------------------------- booking ---

  /** One poll → (maybe) one booking attempt. Returns the slot or null. */
  private async tryBookOnce(page: Page, known?: Slot): Promise<Slot | null> {
    const { adapter, config, application } = this.deps;

    const slot = known ?? (await this.bestSlot(page));
    if (!slot) return null;

    logger().info({ slot: slot.label }, 'target slot found');
    await this.deps.notifier
      .send({ level: 'success', title: 'Slot available', body: `${slot.label} — attempting to book…` })
      .catch(() => undefined);

    const selected = await adapter.selectSlot(page, slot, config.booking.selectionTimeoutMs);
    if (!selected) {
      logger().warn({ slot: slot.label }, 'could not select slot (taken?)');
      await this.deps.notifier
        .send({ level: 'warn', title: 'Slot vanished', body: `${slot.label} was taken before selection` })
        .catch(() => undefined);
      return null;
    }

    await adapter.fillApplication(page, application);
    await adapter.attachDocuments(page, application.documents);
    await adapter.submitApplication(page);

    await saveSession(page.context(), this.authOptsWithoutState());
    await this.deps.notifier
      .send({
        level: 'success',
        title: 'Appointment confirmed',
        body: `${slot.label}\n${this.deps.adapter.displayName}`,
      })
      .catch(() => undefined);
    logger().info({ slot: slot.label }, 'booking complete');
    return slot;
  }

  private async bestSlot(page: Page): Promise<Slot | null> {
    const slots = await this.safeSlots(page);
    return pickBest(slots, this.deps.filter);
  }

  private async safeSlots(page: Page): Promise<Slot[]> {
    try {
      const slots = await this.deps.adapter.getSlots(page);
      this.lastSlots = slots;
      return slots;
    } catch (err) {
      const e = toBotError(err);
      if (e.kind === 'auth') await this.reauthenticate(page);
      logger().warn({ err: e.message }, 'getSlots failed');
      return [];
    }
  }

  private async reauthenticate(page: Page): Promise<void> {
    this.authFailures++;
    if (this.authFailures > 3) {
      throw new BotError('auth', 'session keeps expiring during monitoring', { retryable: false });
    }
    logger().info('session expired mid-run, re-authenticating');
    this.deps.session.clear(this.deps.adapter.id);
    await ensureAuthenticated(page, this.authOptions(false));
  }

  // ------------------------------------------------------------- helpers ---

  private authOptions(stateLoaded: boolean) {
    const d = this.deps;
    return {
      adapter: d.adapter,
      config: d.config,
      credentials: d.credentials,
      notifier: d.notifier,
      session: d.session,
      guard: this.guard,
      stateLoaded,
    };
  }

  private authOptsWithoutState() {
    return { adapter: this.deps.adapter, session: this.deps.session };
  }

  private async sleepInterruptible(ms: number): Promise<void> {
    const step = 250;
    let waited = 0;
    while (waited < ms && !this.deps.signal?.aborted) {
      await sleep(Math.min(step, ms - waited));
      waited += step;
    }
  }
}
