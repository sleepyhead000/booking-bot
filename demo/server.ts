/**
 * Minimal, dependency-free demo booking portal.
 *
 * Purpose: give the bot a real, complete flow to drive (login → OTP →
 * calendar → form + PDF upload → submit) without touching a live site, so
 * every part of the pipeline is testable end-to-end and deterministic.
 *
 * Simulated behaviours:
 *   - login with credentials from .env (any username/password is accepted,
 *     wrong ones are rejected so the auth error path is real)
 *   - OTP printed to this console (like an SMS gateway would) — set
 *     DEMO_FIXED_OTP to make it deterministic for tests
 *   - a calendar whose availability *grows over time* (a new, nearer slot is
 *     released every DEMO_SLOT_RELEASE_MS) so the monitor loop has something
 *     to actually find
 *   - an application form with a PDF upload and a final submit
 *   - an optional fake challenge overlay (DEMO_CHALLENGE=1) to exercise the
 *     challenge-detection/solver path
 *
 * Run: npm run demo   (http://127.0.0.1:4173)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSamplePdf as ensureSamplePdfFile } from './pdf.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const SAMPLE_PDF = join(__dirname, 'sample.pdf');

const PORT = Number(process.env.DEMO_PORT ?? 4173);
const HOST = process.env.DEMO_HOST ?? '127.0.0.1';
const FIXED_OTP = process.env.DEMO_FIXED_OTP ?? '';
const RELEASE_MS = Number(process.env.DEMO_SLOT_RELEASE_MS ?? 8000);
const INITIAL_RELEASES = Number(process.env.DEMO_INITIAL_RELEASES ?? 6);
const CHALLENGE = process.env.DEMO_CHALLENGE === '1';
const CHALLENGE_AUTOCLEAR_MS = Number(process.env.DEMO_CHALLENGE_AUTOCLEAR_MS ?? 6000);

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

interface Session {
  user: string;
  authed: boolean;
  otp?: string;
  otpExpiresAt?: number;
  booked?: { slotId: string; reference: string } | null;
}

interface SlotRecord {
  id: string;
  date: string;
  time: string;
  taken: boolean;
}

const sessions = new Map<string, Session>();
const slots: SlotRecord[] = [];

/** Every slot the portal will ever offer: next 60 days, three sittings a day. */
function buildSlots(): SlotRecord[] {
  const out: SlotRecord[] = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const times = ['09:20', '11:40', '14:00'];
  for (let d = 1; d <= 60; d++) {
    const day = new Date(base.getTime() + d * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    for (const time of times) {
      out.push({ id: `${date}T${time}`, date, time, taken: false });
    }
  }
  // Ascending by date; the first batch released is the far-off tail, so the
  // desirable near-term slots only appear as the monitor keeps watching.
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

slots.push(...buildSlots());

/**
 * Availability grows over time, the way a portal trickles out newly opened
 * appointment batches: a few far-off slots exist immediately, then more are
 * released at random until every candidate is open. Randomised release means
 * a *nearer* (more desirable) slot can appear at any moment — which is exactly
 * the event the monitor loop exists to catch.
 */
const released = new Set<string>();
{
  const start = Math.max(0, slots.length - INITIAL_RELEASES);
  for (const s of slots.slice(start)) released.add(s.id);
}

function availableSlots(): SlotRecord[] {
  return slots.filter((s) => released.has(s.id) && !s.taken);
}

function releaseMore(n = 1 + Math.floor(Math.random() * 2)): void {
  const candidates = slots.filter((s) => !released.has(s.id));
  if (candidates.length === 0) return;
  for (let i = 0; i < n && candidates.length > 0; i++) {
    const idx = Math.floor(Math.random() * candidates.length);
    const [picked] = candidates.splice(idx, 1);
    if (picked) released.add(picked.id);
  }
}

setInterval(() => releaseMore(), RELEASE_MS).unref();

// --------------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Shape of the booking submission the demo accepts. */
interface BookBody {
  slotId?: string;
  fields?: Record<string, unknown>;
  documents?: unknown[];
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sidOf(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
  return m ? m[1]! : null;
}

function sessionOf(req: IncomingMessage): Session | null {
  const sid = sidOf(req);
  if (!sid) return null;
  return sessions.get(sid) ?? null;
}

function ensureSession(res: ServerResponse): Session {
  const sid = `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const s: Session = { user: '', authed: false };
  sessions.set(sid, s);
  res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return s;
}

function serveStatic(res: ServerResponse, rel: string): void {
  const path = resolve(PUBLIC_DIR, rel);
  if (!path.startsWith(resolve(PUBLIC_DIR)) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  let body: Buffer | string = readFileSync(path);
  // Flag must be visible to scripts before `load`, so it is inlined server-side.
  if (extname(path) === '.html') {
    const inline = `<script>window.__DEMO_CHALLENGE__=${JSON.stringify({
      enabled: CHALLENGE,
      autoclearMs: CHALLENGE_AUTOCLEAR_MS,
    })};</script>`;
    body = body.toString('utf8').replace('<head>', `<head>${inline}`);
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(body);
}

// --------------------------------------------------------------------------
// Fake challenge overlay (opt-in) — markup lives in public/challenge.js and
// is injected by that script when /api/me reports `challenge: true`.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // --- static ------------------------------------------------------------
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    // Keep an existing session: a restored bot must not be logged out just
    // because it reloaded the entry page.
    if (!sessionOf(req)) ensureSession(res);
    return serveStatic(res, 'login.html');
  }
  if (method === 'GET' && path === '/otp') return serveStatic(res, 'otp.html');
  if (method === 'GET' && path === '/book') return serveStatic(res, 'book.html');
  if (method === 'GET' && path.startsWith('/public/')) return serveStatic(res, path.slice('/public/'.length));

  // --- API ---------------------------------------------------------------
  if (method === 'POST' && path === '/api/login') {
    const body = await readBody(req);
    const user = String(body.username ?? '').trim();
    const pass = String(body.password ?? '');
    if (!user || !pass) return json(res, 400, { error: 'username and password required' });
    if (user === 'locked' || pass === 'wrong') {
      return json(res, 401, { error: 'Invalid username or password' });
    }
    let s = sessionOf(req);
    if (!s) s = ensureSession(res);
    s.user = user;
    s.authed = false;
    s.otp = FIXED_OTP || String(Math.floor(100000 + Math.random() * 900000));
    s.otpExpiresAt = Date.now() + 5 * 60_000;
    // Simulated SMS gateway.
    console.log(`[demo] OTP for ${user}: ${s.otp}`);
    return json(res, 200, { status: 'otp_required', challenge: CHALLENGE });
  }

  if (method === 'POST' && path === '/api/otp') {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'no session' });
    const body = await readBody(req);
    const code = String(body.code ?? '').trim();
    if (!s.otp || Date.now() > (s.otpExpiresAt ?? 0)) {
      return json(res, 410, { error: 'OTP expired, request a new one' });
    }
    if (code !== s.otp) return json(res, 401, { error: 'Incorrect code' });
    s.authed = true;
    s.otp = undefined;
    return json(res, 200, { status: 'authenticated' });
  }

  if (method === 'POST' && path === '/api/otp/resend') {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'no session' });
    s.otp = FIXED_OTP || String(Math.floor(100000 + Math.random() * 900000));
    s.otpExpiresAt = Date.now() + 5 * 60_000;
    console.log(`[demo] OTP (resent) for ${s.user}: ${s.otp}`);
    return json(res, 200, { status: 'resent' });
  }

  if (method === 'GET' && path === '/api/me') {
    const s = sessionOf(req);
    return json(res, 200, { authed: Boolean(s?.authed), user: s?.user ?? null, challenge: CHALLENGE, challengeAutoclearMs: CHALLENGE_AUTOCLEAR_MS });
  }

  if (method === 'GET' && path === '/api/slots') {
    const s = sessionOf(req);
    if (!s?.authed) return json(res, 401, { error: 'not authenticated' });
    const list = availableSlots().map((x) => ({
      id: x.id,
      date: x.date,
      time: x.time,
      label: `${x.date} ${x.time}`,
    }));
    return json(res, 200, { slots: list, released: released.size, total: slots.length });
  }

  if (method === 'POST' && path === '/api/book') {
    const s = sessionOf(req);
    if (!s?.authed) return json(res, 401, { error: 'not authenticated' });
    const body = (await readBody(req)) as BookBody;
    const slot = slots.find((x) => x.id === body.slotId);
    if (!slot || slot.taken || !availableSlots().some((x) => x.id === slot.id)) {
      return json(res, 409, { error: 'That slot is no longer available' });
    }
    const missing = ['surname', 'givenName', 'passport', 'email'].filter(
      (k) => !String(body.fields?.[k] ?? '').trim(),
    );
    if (missing.length) return json(res, 422, { error: `Missing fields: ${missing.join(', ')}` });
    if (!Array.isArray(body.documents) || body.documents.length === 0) {
      return json(res, 422, { error: 'At least one document must be attached' });
    }
    slot.taken = true;
    const reference = `REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    s.booked = { slotId: slot.id, reference };
    console.log(`[demo] booked ${slot.id} → ${reference} (${s.user})`);
    return json(res, 200, { status: 'confirmed', reference, slot: { id: slot.id, date: slot.date, time: slot.time } });
  }

  if (method === 'GET' && path === '/api/booking') {
    const s = sessionOf(req);
    return json(res, 200, { booked: s?.booked ?? null });
  }

  // Test/dev helpers — make E2E runs deterministic.
  if (method === 'POST' && path === '/api/dev/release') {
    const body = await readBody(req);
    releaseMore(Number(body.n ?? 5));
    return json(res, 200, { released: released.size, available: availableSlots().length });
  }
  if (method === 'GET' && path === '/api/dev/state') {
    return json(res, 200, {
      released: released.size,
      total: slots.length,
      available: availableSlots().length,
      challenge: CHALLENGE,
    });
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

ensureSamplePdfFile(SAMPLE_PDF);

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[demo] error', err);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[demo] booking portal listening on http://${HOST}:${PORT}`);
  console.log(`[demo] slots released: ${released.size}/${slots.length}, next release in ${RELEASE_MS}ms`);
  if (CHALLENGE) console.log(`[demo] challenge overlay ENABLED (auto-clears in ${CHALLENGE_AUTOCLEAR_MS}ms)`);
  if (FIXED_OTP) console.log(`[demo] fixed OTP: ${FIXED_OTP}`);
});

// Expose the challenge overlay to the pages via a small include endpoint.
export { PORT, HOST };

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

export { server };
