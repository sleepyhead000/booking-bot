import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolveDocument, resolveDocuments } from '../src/documents/pdf.js';
import { BotError } from '../src/util/errors.js';
import { buildMinimalPdf, ensureSamplePdf } from '../demo/pdf.js';

// The sample fixture is generated, not committed — make sure it exists before
// the first assertion that reads it.
ensureSamplePdf();

describe('document resolution', () => {
  it('accepts a real PDF and reports its metadata', () => {
    const file = resolveDocument({ path: 'demo/sample.pdf', target: '#passport-pdf' });
    expect(existsSync(file.absPath)).toBe(true);
    expect(file.mimeType).toBe('application/pdf');
    expect(file.size).toBeGreaterThan(0);
    expect(file.name).toBe('sample.pdf');
  });

  it('rejects a missing file before the flow starts', () => {
    expect(() => resolveDocument({ path: 'nope/missing.pdf', target: '#x' })).toThrow(BotError);
    try {
      resolveDocument({ path: 'nope/missing.pdf', target: '#x' });
    } catch (e) {
      expect((e as BotError).kind).toBe('form');
      expect((e as BotError).retryable).toBe(false);
    }
  });

  it('rejects an empty document set', () => {
    expect(() => resolveDocuments([])).toThrow(/no documents/);
  });

  it('builds a structurally valid minimal PDF', () => {
    const pdf = buildMinimalPdf('Hello (world)');
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('startxref');
    // xref offsets must actually point at the object headers.
    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('round-trips the generated sample file', () => {
    const sample = ensureSamplePdf();
    expect(existsSync(sample)).toBe(true);
    const bytes = readFileSync(sample);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
