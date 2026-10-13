import { z } from 'zod';

/**
 * Full runtime configuration. Built from config/default.yaml, then overridden
 * by environment variables (see loadConfig), then by CLI flags.
 * Secrets are NOT part of this schema — they live in process.env and are read
 * by the modules that need them (credentials, telegram, solver, proxy).
 */
export const configSchema = z.object({
  adapter: z.string().min(1).default('reference'),

  browser: z
    .object({
      headless: z.boolean().default(true),
      slowMo: z.number().int().min(0).default(0),
      viewport: z.tuple([z.number().int(), z.number().int()]).default([1366, 768]),
      locale: z.string().default('en-US'),
      timezoneId: z.string().default('UTC'),
      stealth: z.enum(['standard', 'rebrowser']).default('standard'),
    })
    .default({}),

  session: z
    .object({
      dir: z.string().default('storage/sessions'),
      maxAgeMinutes: z.number().int().min(1).default(720),
    })
    .default({}),

  monitor: z
    .object({
      minIntervalMs: z.number().int().min(250).default(4000),
      maxIntervalMs: z.number().int().min(500).default(12000),
      backoffMaxMs: z.number().int().min(1000).default(60000),
      maxEmptyCycles: z.number().int().min(0).default(0),
      preferApiSniffing: z.boolean().default(true),
    })
    .default({})
    .refine((m) => m.maxIntervalMs >= m.minIntervalMs, {
      message: 'monitor.maxIntervalMs must be >= monitor.minIntervalMs',
    }),

  booking: z
    .object({
      dateFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
        .nullable()
        .default(null),
      dateTo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
        .nullable()
        .default(null),
      weekdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
      selectionTimeoutMs: z.number().int().min(1000).default(15000),
      /** JSON file with the applicant's form fields and documents. */
      applicantFile: z.string().default('config/applicant.json'),
    })
    .default({}),

  otp: z
    .object({
      timeoutSec: z.number().int().min(10).default(180),
      maxAttempts: z.number().int().min(1).max(10).default(3),
    })
    .default({}),

  notify: z
    .object({
      console: z.boolean().default(true),
      telegram: z.boolean().default(false),
    })
    .default({}),

  solver: z
    .object({
      provider: z.string().min(1).default('manual'),
      timeoutSec: z.number().int().min(10).default(120),
    })
    .default({}),

  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      dir: z.string().default('storage/logs'),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;

/** Targeting filters for slot selection (from config + env + CLI). */
export interface TargetFilter {
  dateFrom: string | null;
  dateTo: string | null;
  weekdays: number[];
}

/** Dot-path overrides coming from the CLI (--set monitor.minIntervalMs=3000). */
export type Overrides = Record<string, unknown>;

function isDateString(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * Merge raw config with env + CLI overrides, then validate.
 * Throws a readable ZodError on invalid input.
 */
export function applyOverrides(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  overrides: Overrides = {},
): Config {
  const merged: Record<string, unknown> = structuredClone(raw);

  if (env.TARGET_ADAPTER) merged.adapter = env.TARGET_ADAPTER;
  if (env.HEADLESS !== undefined && env.HEADLESS !== '')
    setPath(merged, 'browser.headless', env.HEADLESS === 'true' || env.HEADLESS === '1');
  if (env.LOG_LEVEL) setPath(merged, 'logging.level', env.LOG_LEVEL);
  if (isDateString(env.TARGET_DATE_FROM)) setPath(merged, 'booking.dateFrom', env.TARGET_DATE_FROM);
  if (isDateString(env.TARGET_DATE_TO)) setPath(merged, 'booking.dateTo', env.TARGET_DATE_TO);
  if (env.TARGET_WEEKDAYS) {
    const days = env.TARGET_WEEKDAYS.split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    setPath(merged, 'booking.weekdays', days);
  }

  for (const [path, value] of Object.entries(overrides)) {
    setPath(merged, path, value);
  }

  return configSchema.parse(merged);
}
