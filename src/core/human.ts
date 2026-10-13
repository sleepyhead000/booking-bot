import type { Page, Locator } from 'playwright';
import { randomInt, sleep, randomPause } from '../util/async.js';

/**
 * Human-behavior layer.
 *
 * Bots give themselves away with teleporting cursors, perfectly uniform
 * keystrokes and zero hesitation. These helpers reproduce the messy parts:
 * curved mouse paths, variable inter-key delays, a beat of hesitation before
 * a click, and small aim corrections on the target itself.
 */

/** Cubic bezier point at t, given four control points. */
function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Move the cursor from its current position to (x, y) along a curved path
 * with uneven speed — fast in the middle, slow at the ends, like a real hand.
 */
export async function humanMove(page: Page, x: number, y: number): Promise<void> {
  const start = page.mouse;
  // Playwright doesn't expose cursor position, so approximate the origin as
  // the viewport centre — good enough to make the path non-linear.
  const vp = page.viewportSize() ?? { width: 1366, height: 768 };
  const x0 = vp.width / 2;
  const y0 = vp.height / 2;

  const cx1 = x0 + (x - x0) * 0.3 + randomInt(-80, 80);
  const cy1 = y0 + (y - y0) * 0.7 + randomInt(-60, 60);
  const cx2 = x0 + (x - x0) * 0.8 + randomInt(-40, 40);
  const cy2 = y0 + (y - y0) * 0.2 + randomInt(-40, 40);

  const segments = randomInt(14, 26);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const px = bezier(t, x0, cx1, cx2, x);
    const py = bezier(t, y0, cy1, cy2, y);
    await start.move(px, py, { steps: 1 });
    // Non-uniform pacing: slower at start/finish.
    const ease = Math.sin(t * Math.PI);
    await sleep(Math.round(4 + (1 - ease) * 10 + Math.random() * 6));
  }
  await start.move(x, y, { steps: 2 });
}

/** Click an element the way a person would: hover, hesitate, press, release. */
export async function humanClick(page: Page, target: Locator | string): Promise<void> {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error('element has no bounding box (not visible?)');

  // Aim slightly off-centre and drift onto it — humans rarely hit dead centre.
  const jx = box.x + box.width * (0.3 + Math.random() * 0.4);
  const jy = box.y + box.height * (0.3 + Math.random() * 0.4);
  await humanMove(page, jx, jy);
  await randomPause(60, 240);
  await page.mouse.down();
  await randomPause(30, 110);
  await page.mouse.up();
  await randomPause(40, 160);
}

/**
 * Type text with human keystroke timing: variable inter-key delay, the
 * occasional longer pause between words, and no burst-perfect rhythm.
 */
export async function humanType(page: Page, target: Locator | string, text: string): Promise<void> {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  await loc.click({ trial: false });
  await loc.fill('');
  await randomPause(80, 260);

  for (const ch of text) {
    await loc.press(ch === ' ' ? 'Space' : ch, { delay: 0 });
    const base = /[0-9]/.test(ch) ? 70 : 55;
    await sleep(randomInt(Math.round(base * 0.4), Math.round(base * 2.2)));
    if (ch === ' ' && Math.random() < 0.18) await randomPause(180, 420);
  }
  await randomPause(120, 380);
}

/** Scroll a little, the way a person looks around a page. */
export async function humanScroll(page: Page, distance: number): Promise<void> {
  const steps = randomInt(3, 7);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, Math.round(distance / steps));
    await sleep(randomInt(60, 160));
  }
}

/** Random thinking pause — use between flow stages, never on a fixed rhythm. */
export async function think(minMs = 300, maxMs = 1200): Promise<void> {
  await randomPause(minMs, maxMs);
}
