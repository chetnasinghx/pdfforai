<p align="center">
  <h1 align="center">pdfforai</h1>
  <p align="center">Convert any PDF into AI-ready text, Markdown, or plain text -from the terminal.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pdfforai"><img src="https://img.shields.io/npm/v/pdfforai.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pdfforai"><img src="https://img.shields.io/npm/dt/pdfforai.svg" alt="npm downloads"></a>
  <a href="https://github.com/chetnasinghx/pdfforai/blob/main/LICENSE"><img src="https://img.shields.io/github/license/chetnasinghx/pdfforai.svg" alt="license"></a>
  <a href="https://github.com/chetnasinghx/pdfforai"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="node version"></a>
</p>

<p align="center">
  <a href="https://star-history.com/#chetnasinghx/pdfforai&Date">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=chetnasinghx/pdfforai&type=Date" width="600" />
  </a>
</p>

---

## Why pdfforai?

LLMs like ChatGPT, Claude, and Gemini work best with clean, structured text -not raw PDF bytes. Most PDF-to-text tools lose headings, tables, and structure. **pdfforai** preserves all of it through a 13-stage transformation pipeline, and wraps the output in an XML format purpose-built for AI consumption.

- Works on **scanned PDFs** too (built-in OCR via tesseract.js)
- Outputs **AI Context**, **Markdown**, or **plain text**
- Runs locally -your documents never leave your machine
- CLI version of [pdfforai.com](https://pdfforai.com)

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Output Formats](#output-formats)
- [Programmatic API](#programmatic-api)
- [How It Works](#how-it-works)
- [Requirements](#requirements)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install -g pdfforai
```

Or run without installing:

```bash
npx pdfforai document.pdf
```

## Quick Start

```bash
# Convert a PDF to AI-ready context (default) and copy to clipboard
pdfforai report.pdf | pbcopy

# Convert to Markdown and save to file
pdfforai report.pdf -f markdown -o report.md

# Convert to plain text
pdfforai report.pdf -f text -o report.txt
```

## CLI Reference

```
pdfforai [input] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `input` | PDF file path, directory path, or `-` for stdin |

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-f, --format <type>` | Output format: `ai`, `markdown`, `text` | `ai` |
| `-o, --output <path>` | Output file or directory | stdout |
| `--no-ocr` | Skip OCR for scanned pages | OCR enabled |
| `--no-watermark` | Omit pdfforai.com watermark | watermark on |
| `--pages <range>` | Page range: `"1-5"`, `"1,3,7"` | all pages |
| `--batch` | Process all PDFs in a directory | -|
| `--zip` | Bundle batch output as ZIP | -|
| `-q, --quiet` | Suppress progress output | -|
| `--verbose` | Show pipeline debug info | -|
| `-V, --version` | Show version | -|
| `-h, --help` | Show help | -|

### Examples

```bash
# Pipe into AI tools
pdfforai paper.pdf | pbcopy                    # macOS clipboard
pdfforai paper.pdf | xclip -selection c        # Linux clipboard

# Stdin support
cat document.pdf | pdfforai -
curl -sL https://example.com/doc.pdf | pdfforai - -f markdown

# Page ranges
pdfforai textbook.pdf --pages 1-10 -o chapter1.txt
pdfforai textbook.pdf --pages 1,5,10 -f markdown

# Batch processing
pdfforai ./contracts/ -o ./converted/          # Directory of files
pdfforai ./contracts/ --zip -o contracts.zip   # As ZIP archive

# Skip OCR for faster processing on text-based PDFs
pdfforai invoice.pdf --no-ocr -f text
```

## Output Formats

### AI Context (default)

XML-wrapped format designed for ChatGPT, Claude, Gemini, and other LLMs. Strips inline formatting to save tokens, preserves structural markers (headings, lists, code fences), and adds metadata + framing instructions.

```xml
<document>
<metadata>
Title: Quarterly Report
Words: ~2,500
Converted: 2026-03-28 via pdfforai.com
</metadata>

<instructions>
This is the extracted text content of a PDF document. Reference it to
answer questions accurately. When citing specific data, numbers, or
quotes, indicate the section they come from.
</instructions>

<content>
# Executive Summary
Revenue grew 23% year-over-year...

## Financial Highlights
| Metric | Q1 2026 | Q1 2025 |
| --- | --- | --- |
| Revenue | $42M | $34M |
...
</content>
</document>
```

### Markdown

Full Markdown output preserving:
- Headings (H1-H6, detected by font size, TOC, and ALL CAPS)
- Tables (auto-detected from column layout)
- Code blocks (indented blocks with code syntax)
- Bold, italic, bold-italic formatting
- Bullet and numbered lists with nesting
- Links and footnotes
- Table of contents

### Plain Text

Clean, readable text with all Markdown syntax stripped. Structure (paragraphs, list markers, spacing) is preserved.

## Programmatic API

```typescript
import { convertPdf } from "pdfforai";
```

### `convertPdf(input, options?)`

Converts a PDF to the specified format.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | `string \| Buffer \| Readable` | File path, Buffer, or readable stream |
| `options.format` | `"ai" \| "markdown" \| "text"` | Output format (default: `"ai"`) |
| `options.ocr` | `boolean` | Enable OCR for scanned pages (default: `true`) |
| `options.watermark` | `boolean` | Include watermark (default: `true`) |
| `options.pages` | `number[]` | Specific pages to process (1-based) |
| `options.onProgress` | `(p: ConversionProgress) => void` | Progress callback |
| `options.fileName` | `string` | File name for AI context metadata |

**Returns:** `Promise<string>`

**Examples:**

```typescript
// From file path
const aiContext = await convertPdf("report.pdf");

// From file path with options
const markdown = await convertPdf("report.pdf", {
  format: "markdown",
  ocr: false,
  watermark: false,
  pages: [1, 2, 3],
  onProgress: (p) => console.log(`${p.percent}% -${p.stage}`),
});

// From Buffer
import fs from "node:fs";
const buffer = fs.readFileSync("report.pdf");
const text = await convertPdf(buffer, { format: "text" });

// From readable stream
const stream = fs.createReadStream("report.pdf");
const result = await convertPdf(stream, { format: "ai" });
```

### Types

```typescript
import type { ConvertOptions, OutputFormat, ConversionProgress } from "pdfforai";
```

## How It Works

pdfforai uses a **13-stage transformation pipeline** ported from [pdfforai.com](https://pdfforai.com):

1. **CalculateGlobalStats** -font size/weight analysis, line spacing, dominant format detection
2. **DetectTableRows** -group text items into markdown table cells by column alignment
3. **CompactLines** -group text items by Y-coordinate into logical lines
4. **RemoveRepetitiveElements** -strip repeated headers/footers/watermarks across pages
5. **VerticalToHorizontal** -rotate single-char vertical text into horizontal
6. **DetectTOC** -find table of contents and link entries to actual headings
7. **DetectHeaders** - identify H1-H6 by font size, weight, ALL CAPS, and TOC data
8. **DetectListItems** -bullet lists, numbered lists, and indentation-based lists
9. **GatherBlocks** -group consecutive lines into semantic blocks
10. **DetectCodeQuoteBlocks** -indented blocks with code syntax → code fences
11. **DetectListLevels** -nested list indentation
12. **ToTextBlocks** -convert blocks to markdown strings
13. **ToMarkdown** -final string assembly

For scanned/image PDFs, pages are rendered to images via `@napi-rs/canvas` and run through `tesseract.js` OCR before entering the pipeline.

## Requirements

- **Node.js** >= 20.0.0
- No system dependencies required -OCR engine and canvas are bundled

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/chetnasinghx/pdfforai.git
cd pdfforai
npm install
npm run build
node bin/pdfforai.js test.pdf
```

## License

[MIT](LICENSE) -Chetna Singh
