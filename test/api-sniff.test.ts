import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { ApiSniffer } from '../src/monitor/api-sniff.js';

/** Minimal stand-in for Playwright's Page: just the response event bus. */
class FakePage extends EventEmitter {
  url(): string {
    return 'http://localhost/book';
  }
}

function fakeResponse(url: string, body: unknown, ok = true) {
  return {
    url: () => url,
    ok: () => ok,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

function fakeHtmlResponse(url: string) {
  return {
    url: () => url,
    ok: () => true,
    headers: () => ({ 'content-type': 'text/html' }),
    json: async () => {
      throw new Error('not json');
    },
  };
}

function makeSniffer(page: FakePage) {
  return new ApiSniffer<{ ids: string[] }>(page as unknown as Page, /\/api\/slots/, (body) => ({
    ids: (body as { slots: Array<{ id: string }> }).slots.map((s) => s.id),
  }));
}

describe('ApiSniffer', () => {
  it('captures a matching JSON response', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();

    page.emit('response', fakeResponse('http://localhost/api/slots?x=1', { slots: [{ id: 'a' }] }));
    await vi.waitFor(() => expect(sniffer.latest()).toEqual({ ids: ['a'] }));
    sniffer.stop();
  });

  it('ignores non-matching URLs', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();

    page.emit('response', fakeResponse('http://localhost/api/book', { slots: [{ id: 'x' }] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sniffer.latest()).toBeNull();
    sniffer.stop();
  });

  it('ignores non-JSON responses', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();

    page.emit('response', fakeHtmlResponse('http://localhost/api/slots'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sniffer.latest()).toBeNull();
    sniffer.stop();
  });

  it('ignores payloads the parser rejects', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();

    page.emit('response', fakeResponse('http://localhost/api/slots', { unexpected: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sniffer.latest()).toBeNull();
    sniffer.stop();
  });

  it('awaitNext resolves when the next payload arrives', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();

    const pending = sniffer.awaitNext(1000);
    setTimeout(
      () => page.emit('response', fakeResponse('http://localhost/api/slots', { slots: [{ id: 'b' }] })),
      30,
    );
    await expect(pending).resolves.toEqual({ ids: ['b'] });
    sniffer.stop();
  });

  it('awaitNext resolves null on timeout', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();
    await expect(sniffer.awaitNext(40)).resolves.toBeNull();
    sniffer.stop();
  });

  it('does not resolve on a payload that arrived before the wait started', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();
    page.emit('response', fakeResponse('http://localhost/api/slots', { slots: [{ id: 'c' }] }));
    await vi.waitFor(() => expect(sniffer.latest()).not.toBeNull());
    await expect(sniffer.awaitNext(40)).resolves.toBeNull();
    expect(sniffer.latest()).toEqual({ ids: ['c'] });
    sniffer.stop();
  });

  it('stops delivering after stop()', async () => {
    const page = new FakePage();
    const sniffer = makeSniffer(page);
    sniffer.start();
    sniffer.stop();
    page.emit('response', fakeResponse('http://localhost/api/slots', { slots: [{ id: 'd' }] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sniffer.latest()).toBeNull();
  });
});
