// Document text extraction for chat attachments (issue #84). docx goes
// through mammoth (the de-facto Word-extraction library, browser-friendly,
// handles runs/tables/lists); pdf text goes through pdfjs-dist.
// Both parsers are loaded with dynamic import on purpose: keeping the
// ~2MB mammoth and ~1MB pdfjs chunks out of the main bundle until a
// document is actually dropped (bundle-size exception to static imports).
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  assertChatDocumentPageCount,
  assertChatDocumentSize,
  assertChatDocumentTextLength,
  validatedChatDocumentText,
} from './chatDocumentLimits';

export async function parseDocxText(data: ArrayBuffer): Promise<string> {
  assertChatDocumentSize(data.byteLength);
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  const text = validatedChatDocumentText(result.value);
  if (!text) {
    throw new Error('docx produced no readable text (images-only or malformed document)');
  }
  return text;
}

export async function parsePdfText(data: ArrayBuffer): Promise<string> {
  assertChatDocumentSize(data.byteLength);
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const document = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  let characterCount = 0;
  try {
    assertChatDocumentPageCount(document.numPages);
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim();
      if (line) {
        characterCount += line.length + (pages.length ? 1 : 0);
        assertChatDocumentTextLength(characterCount);
        pages.push(line);
      }
    }
  } finally {
    await document.cleanup().catch(() => undefined);
  }
  if (!pages.length) {
    throw new Error('pdf produced no readable text (scanned images or malformed document)');
  }
  return validatedChatDocumentText(pages.join('\n'));
}
