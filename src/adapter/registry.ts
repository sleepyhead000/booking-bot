import type { PortalAdapter } from './types.js';
import { BotError } from '../util/errors.js';

/**
 * Adapter registry.
 *
 * Known adapters are listed statically so `tsc`/bundlers see them; anything
 * else is resolved dynamically from src/adapter/<id>/index.js so adding a new
 * portal is just dropping in a folder (no core changes, no registry edit).
 */
const builtIn: Record<string, () => Promise<Module>> = {
  reference: () => import('./reference/index.js'),
};

interface Module {
  adapter?: PortalAdapter;
  default?: PortalAdapter;
}

export async function loadAdapter(id: string): Promise<PortalAdapter> {
  const loader = builtIn[id];
  let mod: Module;

  if (loader) {
    mod = await loader();
  } else {
    try {
      mod = (await import(`./${id}/index.js`)) as Module;
    } catch (err) {
      throw new BotError(
        'config',
        `unknown adapter "${id}" — expected src/adapter/${id}/index.js to export \`adapter\``,
        { cause: err },
      );
    }
  }

  const adapter = mod.adapter ?? mod.default;
  if (!adapter || typeof adapter.id !== 'string') {
    throw new BotError('config', `adapter "${id}" does not export an \`adapter\` object`);
  }
  if (adapter.id !== id) {
    // Not fatal, but a mismatched id corrupts session file naming.
    throw new BotError('config', `adapter id mismatch: folder "${id}" exports id "${adapter.id}"`);
  }
  return adapter;
}

export function listAdapters(): string[] {
  return Object.keys(builtIn);
}
