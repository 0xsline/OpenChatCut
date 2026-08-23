import type { MediaAsset } from '../editor/types';

export type ProjectDocumentKind = 'text' | 'docx' | 'pdf';

const TEXT_EXTENSIONS = new Set([
  '.csv', '.css', '.html', '.js', '.json', '.jsonl', '.jsx', '.md', '.markdown',
  '.rtf', '.srt', '.ts', '.tsx', '.txt', '.vtt', '.xml', '.yaml', '.yml',
]);

export const PROJECT_DOCUMENT_MAX_BYTES = 10 * 1_024 * 1_024;
export const PROJECT_DOCUMENT_MAX_TEXT_CHARS = 100_000;
export const PROJECT_DOCUMENT_MAX_COUNT = 8;
export const PROJECT_DOCUMENT_MAX_TOTAL_PROMPT_CHARS = 200_000;
export const PROJECT_PDF_MAX_PAGES = 100;

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

export function projectDocumentKind(file: Pick<File, 'name' | 'type'>): ProjectDocumentKind | null {
  const extension = extensionOf(file.name);
  if (extension === '.docx') return 'docx';
  if (extension === '.pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(extension) || file.type.startsWith('text/')) return 'text';
  return null;
}

export function projectFileAssetKind(file: Pick<File, 'name' | 'type'>): 'document' | 'file' {
  return projectDocumentKind(file) ? 'document' : 'file';
}

export function assertProjectDocumentSize(byteLength: number): void {
  if (byteLength > PROJECT_DOCUMENT_MAX_BYTES) throw new Error('文档大小不能超过 10 MB');
}

export function assertProjectDocumentPageCount(pageCount: number): void {
  if (pageCount > PROJECT_PDF_MAX_PAGES) throw new Error('PDF 页数不能超过 100 页');
}

export function validatedProjectDocumentText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > PROJECT_DOCUMENT_MAX_TEXT_CHARS) {
    throw new Error('文档文本不能超过 100,000 个字符');
  }
  return trimmed;
}

async function parseDocxText(data: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  const text = validatedProjectDocumentText(result.value);
  if (!text) throw new Error('docx produced no readable text (images-only or malformed document)');
  return text;
}

async function parsePdfText(data: ArrayBuffer): Promise<string> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const document = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  try {
    assertProjectDocumentPageCount(document.numPages);
    for (let index = 1; index <= document.numPages; index += 1) {
      const content = await (await document.getPage(index)).getTextContent();
      const line = content.items.map((item) => ('str' in item ? item.str : '')).join(' ').trim();
      if (line) pages.push(line);
      validatedProjectDocumentText(pages.join('\n'));
    }
  } finally {
    await document.cleanup().catch(() => undefined);
  }
  if (!pages.length) throw new Error('pdf produced no readable text (scanned images or malformed document)');
  return pages.join('\n');
}

export async function readProjectDocument(file: File): Promise<string> {
  assertProjectDocumentSize(file.size);
  const kind = projectDocumentKind(file);
  if (kind === 'docx') return parseDocxText(await file.arrayBuffer());
  if (kind === 'pdf') return parsePdfText(await file.arrayBuffer());
  if (kind === 'text') return validatedProjectDocumentText(await file.text());
  throw new Error('此文件不是可读取的文档');
}

export function projectDocumentPromptBlock(name: string, text: string): string {
  const escapeMarkup = (value: string) => value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<imported_document name="${escapeMarkup(name)}">\n${escapeMarkup(text.trim())}\n</imported_document>\n`;
}

async function collectProjectDocumentBlocks<T>(
  items: readonly T[],
  read: (item: T) => Promise<string>,
) {
  const blocks: string[] = [];
  const errors: string[] = [];
  if (items.length > PROJECT_DOCUMENT_MAX_COUNT) {
    errors.push(`一次最多读取 ${PROJECT_DOCUMENT_MAX_COUNT} 个文档`);
  }
  let promptChars = 0;
  for (const item of items.slice(0, PROJECT_DOCUMENT_MAX_COUNT)) {
    try {
      const block = await read(item);
      if (promptChars + block.length > PROJECT_DOCUMENT_MAX_TOTAL_PROMPT_CHARS) {
        errors.push('文档文本总量不能超过 200,000 个字符');
        break;
      }
      promptChars += block.length;
      blocks.push(block);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { blocks, errors };
}

export function readProjectDocumentFiles(files: readonly File[]) {
  return collectProjectDocumentBlocks(files, async (file) =>
    projectDocumentPromptBlock(file.name, await readProjectDocument(file)));
}

export async function readProjectAssetDocument(
  asset: Pick<MediaAsset, 'name' | 'sourceFilename' | 'src'>,
): Promise<string> {
  const response = await fetch(asset.src);
  if (!response.ok) throw new Error(`读取文档失败 (${response.status})`);
  const blob = await response.blob();
  const name = asset.sourceFilename ?? asset.name;
  const file = new File([blob], name, { type: blob.type });
  return projectDocumentPromptBlock(asset.name, await readProjectDocument(file));
}

export async function readProjectAssetDocuments(assets: readonly MediaAsset[]) {
  const documents = assets.filter((asset) => asset.kind === 'document');
  return collectProjectDocumentBlocks(documents, readProjectAssetDocument);
}
