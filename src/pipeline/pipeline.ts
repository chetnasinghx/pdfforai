// PDF parsing logic + pipeline execution — Node.js adapter
// Replaces browser-specific pipeline.ts with Node.js compatible version

import { createRequire } from "node:module";
import path from "node:path";
import type { TextItemData, PageData, ParseResult } from "./models.js";
import { runTransformationPipeline } from "./transformations.js";

// pdfjs-dist must be imported via the legacy Node.js build
const require = createRequire(import.meta.url);
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs") as typeof import("pdfjs-dist");

function findStandardFontDataUrl(): string {
  try {
    const pdfjsPath = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pdfjsPath), "standard_fonts") + "/";
  } catch {
    return "";
  }
}

export interface ConversionProgress {
  stage: string;
  percent: number;
}

export interface PipelineOptions {
  /** Enable OCR for scanned pages (default: true) */
  ocr?: boolean;
  /** Specific page numbers to process (1-based) */
  pages?: number[];
  /** Progress callback */
  onProgress?: (progress: ConversionProgress) => void;
}

/**
 * Parse a PDF buffer and run the conversion pipeline.
 * Returns the markdown string.
 */
export async function parsePdfToMarkdown(
  fileBuffer: ArrayBuffer,
  options: PipelineOptions = {}
): Promise<string> {
  const { ocr: enableOcr = true, pages: selectedPages, onProgress } = options;

  onProgress?.({ stage: "Loading PDF document...", percent: 5 });

  const pdfDocument = await pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer),
    useSystemFonts: true,
    standardFontDataUrl: findStandardFontDataUrl(),
  }).promise;

  onProgress?.({ stage: "Parsing metadata...", percent: 10 });

  const numPages = pdfDocument.numPages;
  const pageNumbers = selectedPages
    ? selectedPages.filter((p) => p >= 1 && p <= numPages)
    : Array.from({ length: numPages }, (_, i) => i + 1);

  const parsedPages: PageData[] = [];
  const fontIds = new Set<string>();
  const fontMap = new Map<string, { name: string }>();

  for (let idx = 0; idx < pageNumbers.length; idx++) {
    const j = pageNumbers[idx];
    onProgress?.({
      stage: `Parsing page ${j} of ${numPages}...`,
      percent: 10 + ((idx + 1) / pageNumbers.length) * 60,
    });

    const page = await pdfDocument.getPage(j);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textItems: TextItemData[] = (textContent.items as any[])
      .filter((item) => "str" in item)
      .map((item) => {
        const fontId = item.fontName as string;

        // Resolve fonts
        if (!fontIds.has(fontId) && fontId.startsWith("g_d0")) {
          try {
            const fontObj = (pdfDocument as unknown as {
              transport?: { commonObjs: { get: (id: string) => { name: string } } };
            }).transport?.commonObjs?.get(fontId);
            if (fontObj && fontObj.name) {
              fontMap.set(fontId, fontObj);
            }
          } catch {
            // Font resolution may fail for some fonts
          }
          fontIds.add(fontId);
        }

        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
        const dividedHeight = item.height / fontHeight;

        return {
          x: Math.round(item.transform[4]),
          y: Math.round(item.transform[5]),
          width: Math.round(item.width),
          height: Math.round(dividedHeight <= 1 ? item.height : dividedHeight),
          text: item.str,
          font: item.fontName,
        };
      });

    // Check if page needs OCR
    if (enableOcr) {
      const { pageNeedsOcr } = await import("../ocr/ocr.js");
      if (pageNeedsOcr(textItems, viewport.width, viewport.height)) {
        onProgress?.({
          stage: `OCR: scanning page ${j} of ${numPages}...`,
          percent: 10 + ((idx + 1) / pageNumbers.length) * 60,
        });

        try {
          const { ocrPage } = await import("../ocr/ocr.js");
          const ocrItems = await ocrPage(page, viewport.height, (msg) => {
            onProgress?.({
              stage: `Page ${j}: ${msg}`,
              percent: 10 + ((idx + 1) / pageNumbers.length) * 60,
            });
          });
          parsedPages.push({ index: j - 1, items: ocrItems });
        } catch (ocrError) {
          // OCR failed — fall back to whatever text PDF.js extracted
          console.warn(`OCR failed for page ${j}:`, ocrError);
          parsedPages.push({ index: j - 1, items: textItems });
        }
      } else {
        parsedPages.push({ index: j - 1, items: textItems });
      }
    } else {
      parsedPages.push({ index: j - 1, items: textItems });
    }

    // Resolve fonts via operator list
    try {
      await page.getOperatorList();
      if (fontIds.size > fontMap.size) {
        for (const fid of fontIds) {
          if (!fontMap.has(fid)) {
            try {
              const fontObj = (pdfDocument as unknown as {
                transport?: { commonObjs: { get: (id: string) => { name: string } } };
              }).transport?.commonObjs?.get(fid);
              if (fontObj && fontObj.name) {
                fontMap.set(fid, fontObj);
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore operator list errors
    }
  }

  onProgress?.({ stage: "Running conversion pipeline...", percent: 75 });

  const parseResult: ParseResult = {
    pages: parsedPages,
    globals: {},
    messages: [],
  };

  const markdown = runTransformationPipeline(parseResult, fontMap);

  onProgress?.({ stage: "Done!", percent: 100 });

  return markdown;
}
