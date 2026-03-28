// CLI entry point

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { convertPdf } from "./convert.js";
import type { OutputFormat } from "./utils/output.js";
import { validatePdfPath } from "./utils/validation.js";
import { getOutputExtension, writeOutputFile, writeZip, formatFileSize } from "./utils/output.js";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);

const program = new Command();

program
  .name("pdfforai")
  .description("Convert any PDF to AI-ready text, Markdown, or plain text")
  .version(pkg.version)
  .argument("[input]", "PDF file path, directory, or - for stdin")
  .option("-f, --format <type>", "Output format: ai | markdown | text", "ai")
  .option("-o, --output <path>", "Output file or directory (default: stdout)")
  .option("--no-ocr", "Skip OCR for scanned pages")
  .option("--no-watermark", "Omit pdfforai.com watermark")
  .option("--pages <range>", "Process specific pages: \"1-5\", \"1,3,7\"")
  .option("--batch", "Process all PDFs in a directory")
  .option("--zip", "Bundle output as ZIP (batch mode)")
  .option("-q, --quiet", "Suppress progress output")
  .option("--verbose", "Show pipeline debug info")
  .action(async (input: string | undefined, opts) => {
    try {
      await run(input, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${msg}\n`);
      process.exit(1);
    }
  });

function parsePageRange(range: string): number[] {
  const pages: number[] = [];
  for (const part of range.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map(Number);
      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
    } else {
      pages.push(Number(trimmed));
    }
  }
  return pages.filter((p) => !isNaN(p) && p > 0);
}

interface CliOptions {
  format: string;
  output?: string;
  ocr: boolean;
  watermark: boolean;
  pages?: string;
  batch?: boolean;
  zip?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

async function run(input: string | undefined, opts: CliOptions): Promise<void> {
  const format = opts.format as OutputFormat;
  if (!["ai", "markdown", "text"].includes(format)) {
    throw new Error(`Invalid format: ${format}. Use: ai, markdown, text`);
  }

  const isStdin = !input || input === "-";
  const isTTY = process.stdout.isTTY;
  const quiet = opts.quiet || !isTTY;

  // Dynamic import for ora (ESM-only)
  let spinner: { start: () => void; text: string; succeed: (t: string) => void; fail: (t: string) => void; stop: () => void } | null = null;
  if (!quiet) {
    try {
      const ora = (await import("ora")).default;
      spinner = ora({ text: "Starting...", stream: process.stderr });
    } catch {
      // ora not available, continue without spinner
    }
  }

  const pages = opts.pages ? parsePageRange(opts.pages) : undefined;

  // Stdin mode
  if (isStdin) {
    if (process.stdin.isTTY) {
      throw new Error("No input provided. Usage: pdfforai <file.pdf> or cat file.pdf | pdfforai -");
    }
    spinner?.start();
    const result = await convertPdf(process.stdin, {
      format,
      ocr: opts.ocr,
      watermark: opts.watermark,
      pages,
      fileName: "stdin.pdf",
      onProgress: spinner ? (p) => { spinner!.text = p.stage; } : undefined,
    });
    spinner?.stop();

    if (opts.output) {
      writeOutputFile(result, opts.output);
      if (!quiet) process.stderr.write(`Written to ${opts.output}\n`);
    } else {
      process.stdout.write(result);
    }
    return;
  }

  // Batch mode
  if (opts.batch || (fs.existsSync(input) && fs.statSync(input).isDirectory())) {
    const dirPath = path.resolve(input);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      throw new Error(`Not a directory: ${dirPath}`);
    }

    const pdfFiles = fs.readdirSync(dirPath)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => path.join(dirPath, f));

    if (pdfFiles.length === 0) {
      throw new Error(`No PDF files found in ${dirPath}`);
    }

    spinner?.start();
    const results: { name: string; content: string }[] = [];

    for (let i = 0; i < pdfFiles.length; i++) {
      const file = pdfFiles[i];
      const name = path.basename(file);
      if (spinner) spinner.text = `[${i + 1}/${pdfFiles.length}] Converting ${name}...`;

      const content = await convertPdf(file, {
        format,
        ocr: opts.ocr,
        watermark: opts.watermark,
        pages,
        onProgress: opts.verbose && spinner
          ? (p) => { spinner!.text = `[${i + 1}/${pdfFiles.length}] ${name}: ${p.stage}`; }
          : undefined,
      });
      results.push({ name, content });
    }

    if (opts.zip && opts.output) {
      await writeZip(results, opts.output, format);
      spinner?.succeed(`${results.length} files converted → ${opts.output}`);
    } else if (opts.output) {
      const outDir = path.resolve(opts.output);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      const ext = getOutputExtension(format);
      for (const result of results) {
        const outPath = path.join(outDir, result.name.replace(/\.pdf$/i, ext));
        writeOutputFile(result.content, outPath);
      }
      spinner?.succeed(`${results.length} files converted → ${outDir}/`);
    } else {
      spinner?.stop();
      for (const result of results) {
        process.stdout.write(result.content);
        process.stdout.write("\n---\n\n");
      }
    }
    return;
  }

  // Single file mode
  const filePath = path.resolve(input);
  const validation = validatePdfPath(filePath);
  if (!validation.success) {
    throw new Error(validation.error);
  }

  const fileSize = fs.statSync(filePath).size;
  spinner?.start();
  if (spinner) spinner.text = `Converting ${path.basename(filePath)} (${formatFileSize(fileSize)})...`;

  const result = await convertPdf(filePath, {
    format,
    ocr: opts.ocr,
    watermark: opts.watermark,
    pages,
    onProgress: spinner ? (p) => { spinner!.text = p.stage; } : undefined,
  });

  if (opts.output) {
    writeOutputFile(result, opts.output);
    spinner?.succeed(`Converted → ${opts.output}`);
  } else {
    spinner?.stop();
    process.stdout.write(result);
  }
}

program.parse();
