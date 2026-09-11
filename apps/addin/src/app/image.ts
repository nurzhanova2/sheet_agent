// Helpers for turning a canvas image into the form Office.js `Shape.addImage`
// expects: raw base64 with NO `data:` URL prefix and no surrounding whitespace.

const DATA_URL_PREFIX = /^data:image\/(png|jpeg|jpg);base64,/i;

// Base64 of the 8-byte PNG signature (\x89PNG\r\n\x1a\n).
const PNG_BASE64_MAGIC = "iVBORw0KGgo";

/**
 * Strips a `data:image/...;base64,` prefix (if present) and all whitespace,
 * returning the bare base64 payload. Throws when the result is empty.
 */
export function dataUrlToBase64(input: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error("no image data provided");
  const raw = input.replace(DATA_URL_PREFIX, "").replace(/\s+/g, "");
  if (raw.length === 0) throw new Error("image data was empty after stripping the data-URL prefix");
  return raw;
}

/** Throws unless `base64` is the base64 encoding of a PNG. */
export function assertPngBase64(base64: string): void {
  if (!base64.startsWith(PNG_BASE64_MAGIC)) {
    throw new Error("the image is not a PNG (expected the PNG signature)");
  }
}
