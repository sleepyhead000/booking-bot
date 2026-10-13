import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { logger } from './logger.js';

/**
 * Capture forensic evidence when something fails: a full-page screenshot and
 * the rendered HTML. Without these, debugging "the portal rejected us at 3am"
 * means reproducing the whole flow by hand.
 */
export async function captureFailure(page: Page | null, label: string, dir = 'storage/artifacts'): Promise<string | null> {
  if (!page) return null;
  const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = resolve(dir, `${stamp}_${safe}`);

  try {
    mkdirSync(resolve(dir), { recursive: true });
  } catch (err) {
    logger().warn({ err }, 'could not create artifacts dir');
    return null;
  }

  const saved: string[] = [];
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    saved.push(`${base}.png`);
  } catch (err) {
    logger().debug({ err }, 'screenshot failed');
  }
  try {
    const html = await page.content();
    writeFileSync(`${base}.html`, html, 'utf8');
    saved.push(`${base}.html`);
  } catch (err) {
    logger().debug({ err }, 'html capture failed');
  }

  if (saved.length > 0) {
    logger().info({ label, files: saved.map((f) => join(f)) }, 'failure artifacts saved');
    return saved[0] ?? null;
  }
  return null;
}
