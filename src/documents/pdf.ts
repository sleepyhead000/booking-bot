import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { Page, Locator } from 'playwright';
import type { DocumentAttachment } from '../adapter/types.js';
import { BotError } from '../util/errors.js';
import { logger } from '../util/logger.js';

export interface ResolvedDocument {
  absPath: string;
  name: string;
  size: number;
  mimeType: string;
  target: string;
}

const MAX_BYTES = 20 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Validate a document before the flow starts. Finding out a file is missing
 * *after* the slot is selected is the worst possible moment, so we check first.
 */
export function resolveDocument(doc: DocumentAttachment, cwd = process.cwd()): ResolvedDocument {
  const absPath = resolve(cwd, doc.path);
  if (!existsSync(absPath)) {
    throw new BotError('form', `document not found: ${absPath}`, { retryable: false });
  }
  const st = statSync(absPath);
  if (!st.isFile() || st.size === 0) {
    throw new BotError('form', `document is empty or not a file: ${absPath}`, { retryable: false });
  }
  if (st.size > MAX_BYTES) {
    throw new BotError('form', `document exceeds ${MAX_BYTES / 1024 / 1024}MB: ${absPath}`, {
      retryable: false,
    });
  }
  const ext = extname(absPath).toLowerCase();
  return {
    absPath,
    name: basename(absPath),
    size: st.size,
    mimeType: doc.mimeType ?? MIME[ext] ?? 'application/octet-stream',
    target: doc.target,
  };
}

export function resolveDocuments(docs: DocumentAttachment[]): ResolvedDocument[] {
  if (docs.length === 0) {
    throw new BotError('form', 'no documents configured for submission', { retryable: false });
  }
  return docs.map((d) => resolveDocument(d));
}

/**
 * Attach one file.
 *
 * Primary path: a real `<input type="file">` via `setInputFiles` — Playwright
 * handles the byte transfer natively and reliably.
 *
 * Fallback: portals that only expose a drag-and-drop dropzone. We rebuild the
 * File inside the page from base64 and dispatch a synthetic `drop`, which is
 * what those widgets actually listen for.
 */
export async function attachFile(page: Page, target: Locator | string, file: ResolvedDocument): Promise<void> {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;

  const inputCount = await loc.count();
  if (inputCount === 0) {
    await attachByDrop(page, file);
    return;
  }

  try {
    await loc.setInputFiles(file.absPath);
    logger().debug({ file: file.name, target: String(target) }, 'file attached via input');
  } catch (err) {
    logger().debug({ err, file: file.name }, 'setInputFiles failed, trying dropzone fallback');
    await attachByDrop(page, file);
  }
}

async function attachByDrop(page: Page, file: ResolvedDocument): Promise<void> {
  const zone = page
    .locator('[data-testid="document-upload"], .dropzone, [data-dropzone], body')
    .first();

  const b64 = readFileSync(file.absPath).toString('base64');
  const ok = await page.evaluate(
    async ({ b64, name, type, selector }) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      return true;
    },
    {
      b64,
      name: file.name,
      type: file.mimeType,
      selector: '[data-testid="document-upload"], .dropzone, [data-dropzone]',
    },
  );

  if (!ok) {
    const visible = await zone.isVisible().catch(() => false);
    if (!visible) {
      throw new BotError('form', `no upload control found for ${file.name}`, { retryable: false });
    }
    throw new BotError('form', `dropzone did not accept ${file.name}`, { retryable: false });
  }
  logger().debug({ file: file.name }, 'file attached via drop event');
}

/**
 * Attach every document and verify each one actually registered with the form.
 * Verification matters: a silently-ignored upload is a rejected application.
 */
export async function attachAll(
  page: Page,
  docs: ResolvedDocument[],
  verify?: (file: ResolvedDocument) => Promise<boolean>,
): Promise<void> {
  for (const file of docs) {
    const target =
      file.target && (await page.locator(file.target).count()) > 0
        ? file.target
        : 'input[type="file"]';
    await attachFile(page, target, file);

    if (verify) {
      const ok = await verify(file);
      if (!ok) {
        throw new BotError('form', `attachment not confirmed for ${file.name}`, { retryable: true });
      }
    }
    // Documents are heavier than a click — give the page a beat between them.
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
  }
}
