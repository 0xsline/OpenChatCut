export const CHAT_DOCUMENT_MAX_BYTES = 10 * 1_024 * 1_024;
export const CHAT_DOCUMENT_MAX_TEXT_CHARS = 100_000;
export const CHAT_PDF_MAX_PAGES = 100;

export function assertChatDocumentSize(byteLength: number): void {
  if (byteLength > CHAT_DOCUMENT_MAX_BYTES) throw new Error('文档大小不能超过 10 MB');
}

export function assertChatDocumentPageCount(pageCount: number): void {
  if (pageCount > CHAT_PDF_MAX_PAGES) throw new Error('PDF 页数不能超过 100 页');
}

export function assertChatDocumentTextLength(characterCount: number): void {
  if (characterCount > CHAT_DOCUMENT_MAX_TEXT_CHARS) {
    throw new Error('文档文本不能超过 100,000 个字符');
  }
}

export function validatedChatDocumentText(text: string): string {
  const trimmed = text.trim();
  assertChatDocumentTextLength(trimmed.length);
  return trimmed;
}
