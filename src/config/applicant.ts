import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ApplicationData } from '../adapter/types.js';
import type { Config } from './schema.js';
import { BotError } from '../util/errors.js';

const applicantSchema = z.object({
  fields: z.record(z.string(), z.string()),
  documents: z
    .array(
      z.object({
        path: z.string().min(1),
        target: z.string().min(1),
        mimeType: z.string().optional(),
      }),
    )
    .min(1, 'at least one document is required'),
});

export type ApplicantFile = z.infer<typeof applicantSchema>;

/**
 * Load the applicant payload used to fill the form and attach documents.
 *
 * Kept in a separate file (not the YAML config) because it holds personal data
 * you may want to keep out of version control — see config/applicant.example.json.
 */
export function loadApplication(config: Config, root = process.cwd()): ApplicationData {
  const path = resolve(root, config.booking.applicantFile);
  if (!existsSync(path)) {
    throw new BotError(
      'config',
      `applicant file not found: ${path} (copy config/applicant.example.json and fill it in)`,
      { retryable: false },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new BotError('config', `applicant file is not valid JSON: ${path}`, {
      retryable: false,
      cause: err,
    });
  }

  const parsed = applicantSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new BotError('config', `invalid applicant file (${path}): ${issues}`, { retryable: false });
  }

  return { fields: parsed.data.fields, documents: parsed.data.documents };
}
