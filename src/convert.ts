// Main conversion orchestrator

import fs from "node:fs";
import { Readable } from "node:stream";
import { parsePdfToMarkdown } from "./pipeline/pipeline.js";
import type { ConversionProgress } from "./pipeline/pipeline.js";
import { markdownToPlainText } from "./formats/to-text.js";
import { markdownToAiContext } from "./formats/to-ai-context.js";
import type { OutputFormat } from "./utils/output.js";
import { withWatermark } from "./utils/output.js";

export interface ConvertOptions {
  /** Output format: "ai" | "markdown" | "text" (default: "ai") */
  format?: OutputFormat;
  /** Enable OCR for scanned pages (default: true) */
  ocr?: boolean;
  /** Include pdfforai.com watermark (default: true) */
  watermark?: boolean;
  /** Specific pages to process (1-based) */
  pages?: number[];
  /** Progress callback */
  onProgress?: (progress: ConversionProgress) => void;
  /** File name for AI context metadata */
  fileName?: string;
}

/**
 * Convert a PDF to the specified output format.
 *
 * @param input - File path (string), Buffer, or Readable stream
 * @param options - Conversion options
 * @returns Converted text string
 */
export async function convertPdf(
  input: string | Buffer | Readable,
  options: ConvertOptions = {}
): Promise<string> {
  const {
    format = "ai",
    ocr = true,
    watermark = true,
    pages,
    onProgress,
    fileName,
  } = options;

  // Read input to ArrayBuffer
  let buffer: ArrayBuffer;
  let name = fileName || "document.pdf";

  if (typeof input === "string") {
    // File path
    name = fileName || input.split("/").pop() || "document.pdf";
    const fileBuffer = fs.readFileSync(input);
    buffer = new Uint8Array(fileBuffer).buffer as ArrayBuffer;
  } else if (Buffer.isBuffer(input)) {
    buffer = new Uint8Array(input).buffer as ArrayBuffer;
  } else {
    // Readable stream
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const combined = Buffer.concat(chunks);
    buffer = new Uint8Array(combined).buffer as ArrayBuffer;
  }

  // Run the pipeline
  const markdown = await parsePdfToMarkdown(buffer, {
    ocr,
    pages,
    onProgress,
  });

  // Apply format conversion
  let output: string;
  switch (format) {
    case "markdown":
      output = markdown;
      break;
    case "text":
      output = markdownToPlainText(markdown);
      break;
    case "ai":
    default:
      output = markdownToAiContext(markdown, { fileName: name });
      break;
  }

  // Add watermark
  output = withWatermark(output, format, watermark);

  return output;
}
