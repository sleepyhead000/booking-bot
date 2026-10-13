import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import dotenv from 'dotenv';
import { applyOverrides, type Config, type Overrides } from './schema.js';

let envLoaded = false;

/** Load .env into process.env exactly once (no-op if the file is absent). */
export function loadEnv(root = process.cwd()): void {
  if (envLoaded) return;
  dotenv.config({ path: resolve(root, '.env'), quiet: true });
  envLoaded = true;
}

export interface LoadOptions {
  /** Path to the YAML config; defaults to config/default.yaml under root. */
  configPath?: string;
  /** Dot-path CLI overrides, e.g. { 'browser.headless': false }. */
  overrides?: Overrides;
  root?: string;
}

/**
 * Read config/default.yaml (if present), apply env + CLI overrides, validate.
 * A missing config file is fine — schema defaults take over.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const root = opts.root ?? process.cwd();
  loadEnv(root);

  const configPath = resolve(root, opts.configPath ?? 'config/default.yaml');
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = parseYaml(readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  }

  return applyOverrides(raw, process.env, opts.overrides ?? {});
}

/** Secrets are read straight from the environment (never from YAML/logs). */
export const secrets = {
  get username(): string | undefined {
    return process.env.BOT_USERNAME || undefined;
  },
  get password(): string | undefined {
    return process.env.BOT_PASSWORD || undefined;
  },
  get proxyUrl(): string | undefined {
    return process.env.BOT_PROXY_URL || undefined;
  },
  get telegramToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN || undefined;
  },
  get telegramChatId(): string | undefined {
    return process.env.TELEGRAM_CHAT_ID || undefined;
  },
  get solverApiKey(): string | undefined {
    return process.env.SOLVER_API_KEY || undefined;
  },
};
