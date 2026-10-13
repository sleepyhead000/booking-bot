import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A tiny but structurally valid single-page PDF — enough for upload testing
 * without shipping a binary fixture or pulling in a PDF library.
 */
export function buildMinimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 72 760 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

export const DEFAULT_SAMPLE_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'sample.pdf');

/** Create demo/sample.pdf if it does not exist yet. Returns the path. */
export function ensureSamplePdf(path = DEFAULT_SAMPLE_PATH): string {
  if (!existsSync(path) || statSync(path).size === 0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buildMinimalPdf('Demo application form'), 'utf8');
  }
  return path;
}
