/** A detected anti-bot challenge, reduced to what a solver needs. */
export interface ChallengeTask {
  /** The page URL the challenge is served from. */
  url: string;
  /** Turnstile sitekey, when the widget exposes one (`data-sitekey`). */
  sitekey?: string;
  /** `data-action` on the widget, if present. */
  action?: string;
  /** `data-cdata` on the widget, if present. */
  cdata?: string;
  /** Which kind of challenge the detector believes this is. */
  kind: 'turnstile' | 'cloudflare-challenge' | 'unknown';
}

export interface SolverResult {
  /** Token to inject into the challenge response field. */
  token: string;
  provider: string;
  elapsedMs: number;
}

/**
 * Pluggable CAPTCHA/turnstile solver.
 *
 * The core ships only the `manual` provider: adding CapSolver, 2Captcha or
 * anything else means implementing this interface and registering it in
 * solver/registry.ts — no other file changes. That keeps paid services out of
 * the codebase until you actually want them (see README "Adding a solver").
 */
export interface SolverProvider {
  readonly id: string;
  /** False when required env (API key etc.) is missing. */
  isConfigured(): boolean;
  solve(task: ChallengeTask, timeoutMs: number): Promise<SolverResult>;
}
