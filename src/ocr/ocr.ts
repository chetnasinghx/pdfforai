// OCR module for scanned/image-based PDF pages using tesseract.js (Node.js)
// Uses @napi-rs/canvas for rendering (same as pdfjs-dist's NodeCanvasFactory)

import type { TextItemData } from "../pipeline/models.js";

const OCR_FONT = "_ocr_default";
const MIN_CONFIDENCE = 30; // tesseract.js uses 0-100 scale

/**
 * Check if a page needs OCR (scanned/image-based with little or no text)
 */
export function pageNeedsOcr(
  textItems: TextItemData[],
  pageWidth: number,
  pageHeight: number
): boolean {
  const meaningful = textItems.filter((item) => item.text.trim().length > 0);

  if (meaningful.length === 0) return true;

  const totalChars = meaningful.reduce(
    (sum, item) => sum + item.text.trim().length,
    0
  );

  const pageArea = pageWidth * pageHeight;
  const charDensity = totalChars / (pageArea / 10000);

  return totalChars < 20 || charDensity < 1.0;
}

/**
 * Run OCR on a single PDF page using tesseract.js.
 * Renders the page to a PNG buffer via @napi-rs/canvas, then runs OCR.
 */
export async function ocrPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  pageHeight: number,
  onProgress?: (message: string) => void
): Promise<TextItemData[]> {
  const scale = 2.0;

  onProgress?.("Rendering page for OCR...");
  const imageBuffer = await renderPageToBuffer(page, scale);

  onProgress?.("Running text recognition...");
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  const { data } = await worker.recognize(imageBuffer);
  await worker.terminate();

  onProgress?.("Processing OCR results...");
  return tesseractResultsToTextItems(data.words, scale, pageHeight);
}

/**
 * Render a PDF page to a PNG buffer using @napi-rs/canvas.
 * This is the same canvas implementation pdfjs-dist uses internally via NodeCanvasFactory,
 * so page.render() can create internal canvases for image compositing without type mismatches.
 */
async function renderPageToBuffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  scale: number
): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale });
  const w = Math.ceil(viewport.width);
  const h = Math.ceil(viewport.height);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvasContext: ctx as any, viewport }).promise;

  return Buffer.from(canvas.toBuffer("image/png"));
}

interface TesseractWord {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
  text: string;
}

/**
 * Convert tesseract.js word results to TextItemData[] for the pipeline.
 * Tesseract returns rects in canvas coordinates (origin top-left, y-down).
 * We convert to PDF coordinates (origin bottom-left, y-up).
 */
function tesseractResultsToTextItems(
  words: TesseractWord[],
  scale: number,
  pageHeight: number
): TextItemData[] {
  return words
    .filter((w) => w.confidence >= MIN_CONFIDENCE && w.text.trim().length > 0)
    .map((word) => {
      const x = word.bbox.x0 / scale;
      const y = word.bbox.y0 / scale;
      const width = (word.bbox.x1 - word.bbox.x0) / scale;
      const height = (word.bbox.y1 - word.bbox.y0) / scale;
      // Convert canvas Y (top-down) to PDF Y (bottom-up)
      const pdfY = pageHeight - y - height;

      return {
        x: Math.round(x),
        y: Math.round(pdfY),
        width: Math.round(width),
        height: Math.round(height),
        text: word.text,
        font: OCR_FONT,
      } satisfies TextItemData;
    });
}
