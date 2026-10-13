import type { ChallengeTask, SolverProvider, SolverResult } from './types.js';
import { BotError } from '../util/errors.js';

/**
 * The default provider: no paid service, no automation.
 *
 * The challenge guard sees `manual` and, instead of calling `solve()`, notifies
 * you and waits for the challenge to clear by itself (or for you to solve it in
 * a headed browser). `solve()` still exists so the interface is complete and
 * so callers that don't special-case manual behave predictably — it simply
 * refuses, because a human cannot be "called" as an API.
 */
export const manualSolver: SolverProvider = {
  id: 'manual',
  isConfigured: () => true,
  async solve(task: ChallengeTask): Promise<SolverResult> {
    throw new BotError(
      'challenge',
      `manual solver cannot auto-solve a ${task.kind} challenge on ${task.url} — ` +
        'run with --headed to solve it yourself, or configure a solver provider',
      { retryable: false },
    );
  },
};
