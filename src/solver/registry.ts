import type { SolverProvider } from './types.js';
import { manualSolver } from './manual.js';
import { BotError } from '../util/errors.js';

/**
 * Solver registry.
 *
 * Register providers here as you add them, e.g.:
 *   capsolver: () => import('./capsolver.js').then((m) => m.capSolverSolver),
 */
const providers: Record<string, () => Promise<SolverProvider>> = {
  manual: async () => manualSolver,
};

export function availableSolvers(): string[] {
  return Object.keys(providers);
}

export async function getSolver(id: string): Promise<SolverProvider> {
  const loader = providers[id];
  if (!loader) {
    throw new BotError(
      'config',
      `unknown solver provider "${id}" (available: ${availableSolvers().join(', ')})`,
    );
  }
  const provider = await loader();
  if (!provider.isConfigured()) {
    throw new BotError('config', `solver provider "${id}" is not configured (missing credentials)`);
  }
  return provider;
}
