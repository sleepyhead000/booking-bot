import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApplication } from '../src/config/applicant.js';
import { applyOverrides } from '../src/config/schema.js';
import { BotError } from '../src/util/errors.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bot-applicant-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeApplicant(content: string): void {
  writeFileSync(join(dir, 'applicant.json'), content, 'utf8');
}

describe('loadApplication', () => {
  it('loads fields and documents', () => {
    writeApplicant(
      JSON.stringify({
        fields: { surname: 'NOWAK' },
        documents: [{ path: 'demo/sample.pdf', target: '#file' }],
      }),
    );
    const config = applyOverrides({ booking: { applicantFile: 'applicant.json' } }, {});
    const app = loadApplication(config, dir);
    expect(app.fields.surname).toBe('NOWAK');
    expect(app.documents[0]?.target).toBe('#file');
  });

  it('fails clearly when the file is missing', () => {
    const config = applyOverrides({ booking: { applicantFile: 'nope.json' } }, {});
    expect(() => loadApplication(config, dir)).toThrow(BotError);
  });

  it('fails clearly on malformed JSON', () => {
    writeApplicant('{ not json');
    const config = applyOverrides({ booking: { applicantFile: 'applicant.json' } }, {});
    expect(() => loadApplication(config, dir)).toThrow(/not valid JSON/);
  });

  it('requires at least one document', () => {
    writeApplicant(JSON.stringify({ fields: { surname: 'X' }, documents: [] }));
    const config = applyOverrides({ booking: { applicantFile: 'applicant.json' } }, {});
    expect(() => loadApplication(config, dir)).toThrow(/document/);
  });

  it('rejects unknown shapes with a readable message', () => {
    writeApplicant(JSON.stringify({ fields: 'nope' }));
    const config = applyOverrides({ booking: { applicantFile: 'applicant.json' } }, {});
    expect(() => loadApplication(config, dir)).toThrow(/invalid applicant file/);
  });
});
