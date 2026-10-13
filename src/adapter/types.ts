import type { Page, Locator } from 'playwright';

/** An open appointment slot as normalised by an adapter. */
export interface Slot {
  /** Portal-specific identifier used to select the slot again later. */
  id: string;
  /** ISO date, YYYY-MM-DD, in the portal's local time. */
  date: string;
  /** Optional time of day, HH:mm (24h). */
  time?: string;
  /** Human label for notifications, e.g. "Tue 2026-11-03 09:20". */
  label: string;
  /** Anything the adapter needs to find this slot again (selector, index, payload). */
  meta?: Record<string, unknown>;
}

/** One file to attach during application submission. */
export interface DocumentAttachment {
  /** Path on disk (absolute or relative to cwd). */
  path: string;
  /**
   * How the adapter should find the upload input:
   * either a CSS selector, or a field name the adapter maps to a selector.
   */
  target: string;
  mimeType?: string;
}

/** Everything the form-filling step needs. `fields` keys are adapter-defined. */
export interface ApplicationData {
  fields: Record<string, string>;
  documents: DocumentAttachment[];
}

/** Credentials handed to `login`. Always read from .env, never from YAML. */
export interface Credentials {
  username?: string;
  password?: string;
}

/**
 * The multi-portal seam.
 *
 * Everything portal-specific (selectors, page order, API shapes, OTP quirks)
 * lives behind this interface. The core (session, polling, OTP, notifications,
 * challenge handling) is written against it and never changes when you add a
 * portal — you implement one folder under src/adapter/<id>/.
 *
 * Contract notes:
 *  - Methods must throw a BotError with a meaningful `kind` on failure so the
 *    runner can classify it (auth vs challenge vs form vs unknown).
 *  - `getSlots` is called on every poll cycle against an already-authenticated
 *    page; it must NOT navigate away from a logged-in state unexpectedly.
 *  - `isChallenged` should return true for Cloudflare/Turnstile/interstitial
 *    challenge pages so the core can hand off to the solver.
 */
export interface PortalAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;

  /** Perform credential entry. Must leave the session authenticated (OTP may follow). */
  login(page: Page, creds: Credentials): Promise<void>;

  /** Cheap check used to decide whether a persisted session is still valid. */
  isLoggedIn(page: Page): Promise<boolean>;

  /** True when the page is currently asking for a one-time code. */
  isOtpPromptVisible(page: Page): Promise<boolean>;

  /** Enter the code the operator supplied. Throws BotError('otp') when rejected. */
  submitOtp(page: Page, code: string): Promise<void>;

  /** Request a fresh code (resend button). Optional — no-op when unsupported. */
  requestNewOtp?(page: Page): Promise<void>;

  /** Fetch currently available slots. Called every poll cycle. */
  getSlots(page: Page): Promise<Slot[]>;

  /** Navigate to / choose the given slot. Returns false if it vanished. */
  selectSlot(page: Page, slot: Slot, timeoutMs: number): Promise<boolean>;

  /** Fill the application form (not the documents). */
  fillApplication(page: Page, app: ApplicationData): Promise<void>;

  /** Attach all documents. Implementations should verify each attachment. */
  attachDocuments(page: Page, docs: DocumentAttachment[]): Promise<void>;

  /** Submit the application and confirm success. Throw BotError('form') otherwise. */
  submitApplication(page: Page): Promise<void>;

  /** Detect an anti-bot challenge page (Cloudflare, Turnstile widget, ...). */
  isChallenged(page: Page): Promise<boolean>;

  /**
   * Optional: called once after a page is opened, before any other step.
   * Use it to dismiss cookie banners, close popups, etc.
   */
  prepare?(page: Page): Promise<void>;

  /**
   * Optional: the selector of the page region that proves we are logged in.
   * Used by `isLoggedIn` defaults and by the runner to verify session restore.
   */
  authenticatedMarker?: string;
}

/** Small helper adapters can use to implement `isLoggedIn` from a marker. */
export async function markerPresent(page: Page, selector: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const loc: Locator = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
