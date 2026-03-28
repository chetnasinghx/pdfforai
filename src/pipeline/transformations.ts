// 13-stage transformation pipeline for PDF to Markdown conversion

import {
  type TextItemData,
  type LineItemData,
  type LineItemBlockData,
  type PageData,
  type ParseResult,
  type WordData,
  REMOVED_ANNOTATION,
  ADDED_ANNOTATION,
  DETECTED_ANNOTATION,
  MODIFIED_ANNOTATION,
  UNCHANGED_ANNOTATION,
  createLineItemBlock,
  addItemToBlock,
  lineItemText,
  StashingStream,
  TextItemLineGrouper,
  LineConverter,
  HeadlineFinder,
} from "./models.js";
import {
  BlockType,
  type BlockTypeDef,
  WordFormat,
  blockToText,
  headlineByLevel,
} from "./markdown.js";
import {
  isDigit,
  isNumber,
  isListItemCharacter,
  isNumberedListItem,
  isListItem,
  wordMatch,
  hasOnly,
  minXFromBlocks,
  minXFromPageItems,
  hasMathUnicode,
} from "./utils.js";

// Helper: get the most frequently used key from occurrence map
function getMostUsedKey(keyToOccurrence: Record<string, number>): string {
  let maxOccurrence = 0;
  let maxKey = "";
  Object.keys(keyToOccurrence).forEach((element) => {
    if (!maxKey || keyToOccurrence[element] > maxOccurrence) {
      maxOccurrence = keyToOccurrence[element];
      maxKey = element;
    }
  });
  return maxKey;
}

// Helper: cleanup between transformations - remove REMOVED items and clear annotations
function completeTransform(parseResult: ParseResult): ParseResult {
  parseResult.messages = [];
  parseResult.pages.forEach((page) => {
    page.items = page.items.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item: any) => !item.annotation || item.annotation !== REMOVED_ANNOTATION
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.items.forEach((item: any) => (item.annotation = null));
  });
  return parseResult;
}

// Stage 1: CalculateGlobalStats
export function calculateGlobalStats(
  parseResult: ParseResult,
  fontMap: Map<string, { name: string }>
): ParseResult {
  const heightToOccurrence: Record<string, number> = {};
  const fontToOccurrence: Record<string, number> = {};
  let maxHeight = 0;
  let maxHeightFont = "";

  parseResult.pages.forEach((page) => {
    (page.items as TextItemData[]).forEach((item) => {
      heightToOccurrence[item.height] = (heightToOccurrence[item.height] || 0) + 1;
      fontToOccurrence[item.font] = (fontToOccurrence[item.font] || 0) + 1;
      if (item.height > maxHeight) {
        maxHeight = item.height;
        maxHeightFont = item.font;
      }
    });
  });

  const mostUsedHeight = parseFloat(getMostUsedKey(heightToOccurrence));
  const mostUsedFont = getMostUsedKey(fontToOccurrence);

  const distanceToOccurrence: Record<string, number> = {};
  parseResult.pages.forEach((page) => {
    let lastItemOfMostUsedHeight: TextItemData | null = null;
    (page.items as TextItemData[]).forEach((item) => {
      if (item.height === mostUsedHeight && item.text.trim().length > 0) {
        if (lastItemOfMostUsedHeight && item.y !== lastItemOfMostUsedHeight.y) {
          const distance = lastItemOfMostUsedHeight.y - item.y;
          if (distance > 0) {
            distanceToOccurrence[distance] = (distanceToOccurrence[distance] || 0) + 1;
          }
        }
        lastItemOfMostUsedHeight = item;
      } else {
        lastItemOfMostUsedHeight = null;
      }
    });
  });

  const mostUsedDistance = parseFloat(getMostUsedKey(distanceToOccurrence));

  const fontToFormats = new Map<string, string>();
  fontMap.forEach((value, key) => {
    const fontName = value.name.toLowerCase();
    let format: string | null = null;
    if (key === mostUsedFont) {
      format = null;
    } else if (
      fontName.includes("bold") &&
      (fontName.includes("oblique") || fontName.includes("italic"))
    ) {
      format = WordFormat.BOLD_OBLIQUE.name;
    } else if (fontName.includes("bold")) {
      format = WordFormat.BOLD.name;
    } else if (fontName.includes("oblique") || fontName.includes("italic")) {
      format = WordFormat.OBLIQUE.name;
    } else if (key === maxHeightFont) {
      format = WordFormat.BOLD.name;
    }
    if (format) {
      fontToFormats.set(key, format);
    }
  });

  const newPages = parseResult.pages.map((page) => ({
    ...page,
    items: (page.items as TextItemData[]).map((textItem) => ({ ...textItem })),
  }));

  return {
    pages: newPages,
    globals: {
      mostUsedHeight,
      mostUsedFont,
      mostUsedDistance,
      maxHeight,
      maxHeightFont,
      fontToFormats,
    },
    messages: [],
  };
}

// Stage 1.5: DetectTableRows
export function detectTableRows(parseResult: ParseResult): ParseResult {
  const { mostUsedDistance = 12 } = parseResult.globals;

  parseResult.pages.forEach((page) => {
    const textItems = page.items as TextItemData[];
    if (textItems.length === 0) return;

    const sorted = [...textItems].sort((a, b) => b.y - a.y || a.x - b.x);

    const rows: TextItemData[][] = [];
    let currentRow: TextItemData[] = [];
    for (const item of sorted) {
      if (
        currentRow.length === 0 ||
        Math.abs(currentRow[0].y - item.y) < mostUsedDistance / 2
      ) {
        currentRow.push(item);
      } else {
        rows.push(currentRow);
        currentRow = [item];
      }
    }
    if (currentRow.length > 0) rows.push(currentRow);

    type RowInfo = { cells: string[]; rowY: number; items: TextItemData[] };
    const rowInfos: RowInfo[] = rows.map((row) => {
      if (row.length < 2) {
        return { cells: [row[0]?.text || ""], rowY: row[0]?.y || 0, items: row };
      }

      const nonWs = row.filter((item) => item.text.trim().length > 0);
      if (nonWs.length < 2) {
        const text = row.map((i) => i.text).join("");
        return { cells: [text.trim()], rowY: row[0].y, items: row };
      }

      const xDists: number[] = [];
      for (let i = 1; i < nonWs.length; i++) {
        xDists.push(nonWs[i].x - nonWs[i - 1].x);
      }
      const sortedDists = [...xDists].sort((a, b) => a - b);
      const medianDist = sortedDists[Math.floor(sortedDists.length / 2)] || 0;
      const avgH = nonWs.reduce((s, i) => s + i.height, 0) / nonWs.length || 12;
      const colThreshold = Math.max(medianDist * 4, avgH * 4);

      const boundaries: number[] = [];
      for (let i = 1; i < nonWs.length; i++) {
        if (xDists[i - 1] >= colThreshold) {
          boundaries.push((nonWs[i - 1].x + nonWs[i].x) / 2);
        }
      }

      if (boundaries.length === 0) {
        const text = row.map((i) => i.text).join("");
        return { cells: [text.trim()], rowY: row[0].y, items: row };
      }

      const cellItems: TextItemData[][] = Array.from(
        { length: boundaries.length + 1 },
        () => []
      );
      for (const item of row) {
        let col = 0;
        for (const bx of boundaries) {
          if (item.x >= bx) col++;
          else break;
        }
        cellItems[col].push(item);
      }

      const cells = cellItems.map((items) => {
        if (items.length === 0) return "";
        items.sort((a, b) => a.x - b.x);
        let text = "";
        let lastItem: TextItemData | undefined;
        for (const item of items) {
          if (!text.endsWith(" ") && !item.text.startsWith(" ") && lastItem) {
            const gap = item.x - lastItem.x - lastItem.width;
            if (gap > 5) text += " ";
          }
          text += item.text;
          if (item.text.trim().length > 0) lastItem = item;
        }
        return text.trim();
      });

      const nonEmptyCells = cells.filter((c) => c.length > 0);
      if (nonEmptyCells.length >= 2) {
        return { cells, rowY: row[0].y, items: row };
      }
      return { cells: [cells.join(" ").trim()], rowY: row[0].y, items: row };
    });

    const toRemove = new Set<TextItemData>();
    const toAdd: TextItemData[] = [];

    let i = 0;
    while (i < rowInfos.length) {
      const ri = rowInfos[i];
      if (ri.cells.length < 2) {
        i++;
        continue;
      }
      const firstCell = ri.cells[0].trim();
      if (isListItemCharacter(firstCell) || /^\[.?\]$/.test(firstCell)) {
        i++;
        continue;
      }
      let j = i + 1;
      const colCount = ri.cells.length;
      while (
        j < rowInfos.length &&
        rowInfos[j].cells.length >= 2 &&
        Math.abs(rowInfos[j].cells.length - colCount) <= 1
      )
        j++;

      if (j - i < 2) {
        i++;
        continue;
      }

      const tableRows = rowInfos.slice(i, j);
      const refItem = tableRows[0].items[0];
      const headerY = tableRows[0].rowY;

      tableRows.forEach((r) => r.items.forEach((it) => toRemove.add(it)));

      const mdLines: string[] = [
        "| " + tableRows[0].cells.join(" | ") + " |",
        "| " + tableRows[0].cells.map(() => "---").join(" | ") + " |",
        ...tableRows.slice(1).map((r) => {
          const cells = [...r.cells];
          while (cells.length < colCount) cells.push("");
          return "| " + cells.slice(0, colCount).join(" | ") + " |";
        }),
      ];

      mdLines.forEach((line, li) => {
        toAdd.push({
          ...refItem,
          text: line,
          y: headerY - li * mostUsedDistance,
          x: refItem.x,
          width: line.length * 6,
          annotation: null,
        });
      });

      i = j;
    }

    if (toRemove.size === 0) return;

    page.items = [
      ...textItems.filter((it) => !toRemove.has(it)),
      ...toAdd,
    ];
  });

  return parseResult;
}

// Stage 2: CompactLines
export function compactLines(parseResult: ParseResult): ParseResult {
  const { mostUsedDistance, fontToFormats } = parseResult.globals;
  const lineGrouper = new TextItemLineGrouper(mostUsedDistance || 12);
  const lineCompactor = new LineConverter(fontToFormats || new Map());

  parseResult.pages.forEach((page) => {
    if (page.items.length > 0) {
      const lineItems: LineItemData[] = [];
      const textItemsGroupedByLine = lineGrouper.group(page.items as TextItemData[]);
      textItemsGroupedByLine.forEach((lineTextItems) => {
        const lineItem = lineCompactor.compact(lineTextItems);
        if (lineTextItems.length > 1) {
          lineItem.annotation = ADDED_ANNOTATION;
          lineTextItems.forEach((item) => {
            const li: LineItemData = {
              x: item.x,
              y: item.y,
              width: item.width,
              height: item.height,
              words: item.text.split(" ").filter((s) => s.trim().length > 0).map((s) => ({ string: s })),
              annotation: REMOVED_ANNOTATION,
            };
            lineItems.push(li);
          });
        }
        if (lineItem.words.length === 0) {
          lineItem.annotation = REMOVED_ANNOTATION;
        }
        if (lineItem.parsedElements?.footnotes && lineItem.parsedElements.footnotes.length > 0) {
          lineItem.type = BlockType.FOOTNOTES;
        }
        lineItems.push(lineItem);
      });
      page.items = lineItems;
    }
  });

  return { ...parseResult, messages: [] };
}

// Stage 3: RemoveRepetitiveElements
function hashCodeIgnoringSpacesAndNumbers(string: string): number {
  let hash = 0;
  if (string.trim().length === 0) return hash;
  for (let i = 0; i < string.length; i++) {
    const charCode = string.charCodeAt(i);
    if (charCode !== 32 && charCode !== 160) {
      hash = ((hash << 5) - hash) + charCode;
      hash |= 0;
    }
  }
  return hash;
}

export function removeRepetitiveElements(parseResult: ParseResult): ParseResult {
  const pageStore: {
    minElements: LineItemData[];
    maxElements: LineItemData[];
    minLineHash: number;
    maxLineHash: number;
  }[] = [];
  const minLineHashRepetitions: Record<number, number> = {};
  const maxLineHashRepetitions: Record<number, number> = {};

  parseResult.pages.forEach((page) => {
    const items = page.items as LineItemData[];
    const minMaxItems = items.reduce(
      (store, item) => {
        if (item.y < store.minY) {
          store.minElements = [item];
          store.minY = item.y;
        } else if (item.y === store.minY) {
          store.minElements.push(item);
        }
        if (item.y > store.maxY) {
          store.maxElements = [item];
          store.maxY = item.y;
        } else if (item.y === store.maxY) {
          store.maxElements.push(item);
        }
        return store;
      },
      { minY: 999, maxY: 0, minElements: [] as LineItemData[], maxElements: [] as LineItemData[] }
    );

    const minLineHash = hashCodeIgnoringSpacesAndNumbers(
      minMaxItems.minElements.reduce((s, item) => s + lineItemText(item).toUpperCase(), "")
    );
    const maxLineHash = hashCodeIgnoringSpacesAndNumbers(
      minMaxItems.maxElements.reduce((s, item) => s + lineItemText(item).toUpperCase(), "")
    );
    pageStore.push({
      minElements: minMaxItems.minElements,
      maxElements: minMaxItems.maxElements,
      minLineHash,
      maxLineHash,
    });
    minLineHashRepetitions[minLineHash] = (minLineHashRepetitions[minLineHash] || 0) + 1;
    maxLineHashRepetitions[maxLineHash] = (maxLineHashRepetitions[maxLineHash] || 0) + 1;
  });

  parseResult.pages.forEach((page, i) => {
    const items = page.items as LineItemData[];
    if (
      minLineHashRepetitions[pageStore[i].minLineHash] >=
      Math.max(3, parseResult.pages.length * 2 / 3)
    ) {
      pageStore[i].minElements.forEach((item) => {
        item.annotation = REMOVED_ANNOTATION;
      });
    }
    if (
      maxLineHashRepetitions[pageStore[i].maxLineHash] >=
      Math.max(3, parseResult.pages.length * 2 / 3)
    ) {
      pageStore[i].maxElements.forEach((item) => {
        item.annotation = REMOVED_ANNOTATION;
      });
    }
    page.items = items;
  });

  return { ...parseResult, messages: [] };
}

// Stage 4: VerticalToHorizontal
class VerticalsStream extends StashingStream<LineItemData, LineItemData> {
  foundVerticals = 0;

  shouldStash(item: LineItemData): boolean {
    return item.words.length === 1 && item.words[0].string.length === 1;
  }

  doMatchesStash(lastItem: LineItemData, item: LineItemData): boolean {
    return lastItem.y - item.y > 5 && lastItem.words[0].type === item.words[0].type;
  }

  doFlushStash(stash: LineItemData[], results: LineItemData[]): void {
    if (stash.length > 5) {
      const combinedWords: WordData[] = [];
      let minX = 999;
      let maxY = 0;
      let sumWidth = 0;
      let maxHeight = 0;
      stash.forEach((oneCharLine) => {
        oneCharLine.annotation = REMOVED_ANNOTATION;
        results.push(oneCharLine);
        combinedWords.push(oneCharLine.words[0]);
        minX = Math.min(minX, oneCharLine.x);
        maxY = Math.max(maxY, oneCharLine.y);
        sumWidth += oneCharLine.width;
        maxHeight = Math.max(maxHeight, oneCharLine.height);
      });
      results.push({
        ...stash[0],
        x: minX,
        y: maxY,
        width: sumWidth,
        height: maxHeight,
        words: combinedWords,
        annotation: ADDED_ANNOTATION,
      });
      this.foundVerticals++;
    } else {
      results.push(...stash);
    }
  }
}

export function verticalToHorizontal(parseResult: ParseResult): ParseResult {
  parseResult.pages.forEach((page) => {
    const stream = new VerticalsStream();
    stream.consumeAll(page.items as LineItemData[]);
    page.items = stream.complete();
  });
  return { ...parseResult, messages: [] };
}

// Stage 5: DetectTOC
interface TocLink {
  lineItem: LineItemData;
  pageNumber: number;
  level: number;
}

class LinkLeveler {
  private levelByMethod:
    | ((tocLinks: TocLink[]) => void)
    | null = null;
  private uniqueFonts: string[] = [];

  levelPageItems(tocLinks: TocLink[]): void {
    if (!this.levelByMethod) {
      const uniqueX = this.calculateUniqueX(tocLinks);
      if (uniqueX.length > 1) {
        this.levelByMethod = (links) => this.levelByXDiff(links);
      } else {
        const uniqueFonts = this.calculateUniqueFonts(tocLinks);
        if (uniqueFonts.length > 1) {
          this.uniqueFonts = uniqueFonts;
          this.levelByMethod = (links) => this.levelByFont(links);
        } else {
          this.levelByMethod = (links) => this.levelToZero(links);
        }
      }
    }
    this.levelByMethod(tocLinks);
  }

  private levelByXDiff(tocLinks: TocLink[]): void {
    const uniqueX = this.calculateUniqueX(tocLinks);
    tocLinks.forEach((link) => {
      link.level = uniqueX.indexOf(link.lineItem.x);
    });
  }

  private levelByFont(tocLinks: TocLink[]): void {
    tocLinks.forEach((link) => {
      link.level = this.uniqueFonts.indexOf(link.lineItem.font || "");
    });
  }

  private levelToZero(tocLinks: TocLink[]): void {
    tocLinks.forEach((link) => {
      link.level = 0;
    });
  }

  private calculateUniqueX(tocLinks: TocLink[]): number[] {
    const uniqueX = tocLinks.reduce((arr: number[], link) => {
      if (arr.indexOf(link.lineItem.x) < 0) arr.push(link.lineItem.x);
      return arr;
    }, []);
    uniqueX.sort((a, b) => a - b);
    return uniqueX;
  }

  private calculateUniqueFonts(tocLinks: TocLink[]): string[] {
    return tocLinks.reduce((arr: string[], link) => {
      const font = link.lineItem.font || "";
      if (arr.indexOf(font) < 0) arr.push(font);
      return arr;
    }, []);
  }
}

function findHeadlineItems(
  page: PageData,
  headline: string
): { lineIndex: number; headlineItems: LineItemData[] } | null {
  const headlineFinder = new HeadlineFinder(headline);
  let lineIndex = 0;
  for (const line of page.items as LineItemData[]) {
    const headlineItems = headlineFinder.consume(line);
    if (headlineItems) {
      return { lineIndex, headlineItems };
    }
    lineIndex++;
  }
  return null;
}

function findPageWithHeadline(pages: PageData[], headline: string): PageData | null {
  for (const page of pages) {
    if (findHeadlineItems(page, headline)) {
      return page;
    }
  }
  return null;
}

function detectPageMappingNumber(pages: PageData[], tocLinks: TocLink[]): number | null {
  for (const tocLink of tocLinks) {
    const page = findPageWithHeadline(pages, lineItemText(tocLink.lineItem));
    if (page) {
      return page.index - tocLink.pageNumber;
    }
  }
  return null;
}

function addHeadlineItems(
  page: PageData,
  tocLink: TocLink,
  foundItems: { lineIndex: number; headlineItems: LineItemData[] },
  headlineTypeToHeightRange: Record<string, { min: number; max: number }>
): void {
  foundItems.headlineItems.forEach((item) => (item.annotation = REMOVED_ANNOTATION));
  const headlineType = headlineByLevel(Math.min(Math.max(tocLink.level + 2, 1), 6));
  const headlineHeight = foundItems.headlineItems.reduce(
    (max, item) => Math.max(max, item.height),
    0
  );
  (page.items as LineItemData[]).splice(foundItems.lineIndex + 1, 0, {
    ...foundItems.headlineItems[0],
    words: tocLink.lineItem.words,
    height: headlineHeight,
    type: headlineType,
    annotation: ADDED_ANNOTATION,
  });
  let range = headlineTypeToHeightRange[headlineType.name];
  if (range) {
    range.min = Math.min(range.min, headlineHeight);
    range.max = Math.max(range.max, headlineHeight);
  } else {
    range = { min: headlineHeight, max: headlineHeight };
    headlineTypeToHeightRange[headlineType.name] = range;
  }
}

function findPageAndLineFromHeadline(
  pages: PageData[],
  tocLink: TocLink,
  heightRange: { min: number; max: number },
  fromPage: number,
  toPage: number
): [number, number] {
  const linkText = lineItemText(tocLink.lineItem).toUpperCase();
  for (let i = fromPage; i <= toPage; i++) {
    const page = pages[i - 1];
    if (!page) continue;
    const lineIndex = (page.items as LineItemData[]).findIndex((line) => {
      if (
        !line.type &&
        !line.annotation &&
        line.height >= heightRange.min &&
        line.height <= heightRange.max
      ) {
        const match = wordMatch(linkText, lineItemText(line));
        return match >= 0.5;
      }
      return false;
    });
    if (lineIndex > -1) return [i - 1, lineIndex];
  }
  return [-1, -1];
}

export function detectTOC(parseResult: ParseResult): ParseResult {
  const tocPages: number[] = [];
  const maxPagesToEvaluate = Math.min(20, parseResult.pages.length);
  const linkLeveler = new LinkLeveler();

  const tocLinks: TocLink[] = [];
  let lastTocPage: PageData | null = null;
  let headlineItem: LineItemData | null = null;

  parseResult.pages.slice(0, maxPagesToEvaluate).forEach((page) => {
    const items = page.items as LineItemData[];
    let lineItemsWithDigits = 0;
    const unknownLines = new Set<LineItemData>();
    const pageTocLinks: TocLink[] = [];
    let lastWordsWithoutNumber: WordData[] | null = null;
    let lastLine: LineItemData | null = null;

    items.forEach((line) => {
      const words = line.words.filter((word) => !hasOnly(word.string, "."));
      const digits: string[] = [];
      while (words.length > 0 && isNumber(words[words.length - 1].string)) {
        const lastWord = words.pop()!;
        digits.unshift(lastWord.string);
      }

      if (digits.length === 0 && words.length > 0) {
        const lastWord = words[words.length - 1];
        while (isDigit(lastWord.string.charCodeAt(lastWord.string.length - 1))) {
          digits.unshift(lastWord.string.charAt(lastWord.string.length - 1));
          lastWord.string = lastWord.string.substring(0, lastWord.string.length - 1);
        }
      }

      const endsWithDigit = digits.length > 0;
      if (endsWithDigit) {
        if (lastWordsWithoutNumber) {
          words.push(...lastWordsWithoutNumber);
          lastWordsWithoutNumber = null;
        }
        pageTocLinks.push({
          pageNumber: parseInt(digits.join("")),
          lineItem: { ...line, words: words },
          level: 0,
        });
        lineItemsWithDigits++;
      } else {
        if (!headlineItem) {
          headlineItem = line;
        } else {
          if (lastWordsWithoutNumber) {
            unknownLines.add(lastLine!);
          }
          lastWordsWithoutNumber = words;
          lastLine = line;
        }
      }
    });

    if (items.length > 0 && (lineItemsWithDigits * 100) / items.length > 75) {
      tocPages.push(page.index + 1);
      lastTocPage = page;
      linkLeveler.levelPageItems(pageTocLinks);
      tocLinks.push(...pageTocLinks);

      const newBlocks: LineItemData[] = [];
      items.forEach((line) => {
        if (!unknownLines.has(line)) {
          line.annotation = REMOVED_ANNOTATION;
        }
        newBlocks.push(line);
        if (line === headlineItem) {
          newBlocks.push({
            ...line,
            type: BlockType.H2,
            annotation: ADDED_ANNOTATION,
          });
        }
      });
      page.items = newBlocks;
    } else {
      headlineItem = null;
    }
  });

  const headlineTypeToHeightRange: Record<string, { min: number; max: number }> = {};

  if (tocPages.length > 0 && lastTocPage) {
    const lastTocPageRef = lastTocPage as PageData;
    tocLinks.forEach((tocLink) => {
      (lastTocPageRef.items as LineItemData[]).push({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        words: [{ string: " ".repeat(tocLink.level * 3) + "-" }].concat(
          tocLink.lineItem.words
        ),
        type: BlockType.TOC,
        annotation: ADDED_ANNOTATION,
      });
    });

    const pageMapping = detectPageMappingNumber(
      parseResult.pages.filter((page) => page.index > lastTocPageRef.index),
      tocLinks
    );

    if (pageMapping !== null) {
      const notFoundHeadlines: TocLink[] = [];
      const foundBySize: TocLink[] = [];

      tocLinks.forEach((tocLink) => {
        let linkedPage = parseResult.pages[tocLink.pageNumber + pageMapping];
        let foundItems = null;
        if (linkedPage) {
          foundItems = findHeadlineItems(linkedPage, lineItemText(tocLink.lineItem));
          if (!foundItems) {
            linkedPage = parseResult.pages[tocLink.pageNumber + pageMapping + 1];
            if (linkedPage) {
              foundItems = findHeadlineItems(linkedPage, lineItemText(tocLink.lineItem));
            }
          }
        }
        if (foundItems && linkedPage) {
          addHeadlineItems(linkedPage, tocLink, foundItems, headlineTypeToHeightRange);
        } else {
          notFoundHeadlines.push(tocLink);
        }
      });

      if (notFoundHeadlines.length > 0) {
        let fromPage = lastTocPageRef.index + 2;
        let lastNotFound: TocLink[] = [];
        const rollupLastNotFound = (currentPageNumber: number) => {
          if (lastNotFound.length > 0) {
            lastNotFound.forEach((notFoundTocLink) => {
              const headlineType = headlineByLevel(
                Math.min(notFoundTocLink.level + 2, 6)
              );
              const heightRange = headlineTypeToHeightRange[headlineType.name];
              if (heightRange) {
                const [pageIndex, lineIndex] = findPageAndLineFromHeadline(
                  parseResult.pages,
                  notFoundTocLink,
                  heightRange,
                  fromPage,
                  currentPageNumber
                );
                if (lineIndex > -1) {
                  const thePage = parseResult.pages[pageIndex];
                  const items = thePage.items as LineItemData[];
                  items[lineIndex].annotation = REMOVED_ANNOTATION;
                  items.splice(lineIndex + 1, 0, {
                    ...notFoundTocLink.lineItem,
                    type: headlineType,
                    annotation: ADDED_ANNOTATION,
                  });
                  foundBySize.push(notFoundTocLink);
                }
              }
            });
            lastNotFound = [];
          }
        };

        tocLinks.forEach((tocLink) => {
          if (notFoundHeadlines.includes(tocLink)) {
            lastNotFound.push(tocLink);
          } else {
            rollupLastNotFound(tocLink.pageNumber);
            fromPage = tocLink.pageNumber;
          }
        });
        if (lastNotFound.length > 0) {
          rollupLastNotFound(parseResult.pages.length);
        }
      }
    }
  }

  return {
    ...parseResult,
    globals: {
      ...parseResult.globals,
      tocPages,
      headlineTypeToHeightRange,
    },
    messages: [],
  };
}

// Stage 6: DetectHeaders
function findPagesWithMaxHeight(pages: PageData[], maxHeight: number): Set<PageData> {
  const maxHeaderPagesSet = new Set<PageData>();
  pages.forEach((page) => {
    (page.items as LineItemData[]).forEach((item) => {
      if (!item.type && item.height === maxHeight) {
        maxHeaderPagesSet.add(page);
      }
    });
  });
  return maxHeaderPagesSet;
}

export function detectHeaders(parseResult: ParseResult): ParseResult {
  const {
    tocPages = [],
    headlineTypeToHeightRange = {},
    mostUsedHeight = 0,
    mostUsedDistance = 0,
    mostUsedFont = "",
    maxHeight = 0,
  } = parseResult.globals;
  const hasToc = tocPages.length > 0;

  const pagesWithMaxHeight = findPagesWithMaxHeight(parseResult.pages, maxHeight);
  pagesWithMaxHeight.forEach((titlePage) => {
    (titlePage.items as LineItemData[]).forEach((item) => {
      if (!item.type && item.height === maxHeight) {
        item.type = BlockType.H1;
        item.annotation = DETECTED_ANNOTATION;
      }
    });
  });

  if (hasToc) {
    const headlineTypes = Object.keys(headlineTypeToHeightRange);
    headlineTypes.forEach((headlineType) => {
      const range = headlineTypeToHeightRange[headlineType];
      if (range.max > mostUsedHeight) {
        parseResult.pages.forEach((page) => {
          (page.items as LineItemData[]).forEach((item) => {
            if (!item.type && item.height === range.max) {
              item.annotation = DETECTED_ANNOTATION;
              item.type = BlockType[headlineType];
            }
          });
        });
      }
    });
  } else {
    const headingMinHeight = mostUsedHeight * 1.15;
    const heights: number[] = [];
    parseResult.pages.forEach((page) => {
      (page.items as LineItemData[]).forEach((item) => {
        if (
          !item.type &&
          item.height > headingMinHeight &&
          !isListItem(lineItemText(item))
        ) {
          if (!heights.includes(item.height)) {
            heights.push(item.height);
          }
        }
      });
    });
    heights.sort((a, b) => b - a);

    heights.forEach((height, i) => {
      const headlineLevel = i + 2;
      if (headlineLevel <= 6) {
        const headlineType = headlineByLevel(2 + i);
        parseResult.pages.forEach((page) => {
          (page.items as LineItemData[]).forEach((item) => {
            const text = lineItemText(item);
            if (
              !item.type &&
              item.height === height &&
              !isListItem(text) &&
              !hasMathUnicode(text)
            ) {
              item.annotation = DETECTED_ANNOTATION;
              item.type = headlineType;
            }
          });
        });
      }
    });
  }

  let smallestHeadlineLevel = 1;
  parseResult.pages.forEach((page) => {
    (page.items as LineItemData[]).forEach((item) => {
      if (item.type && (item.type as BlockTypeDef).headline) {
        smallestHeadlineLevel = Math.max(
          smallestHeadlineLevel,
          (item.type as BlockTypeDef).headlineLevel || 1
        );
      }
    });
  });

  if (smallestHeadlineLevel < 6) {
    const nextHeadlineType = headlineByLevel(smallestHeadlineLevel + 1);
    parseResult.pages.forEach((page) => {
      let lastItem: LineItemData | null = null;
      (page.items as LineItemData[]).forEach((item) => {
        const text = lineItemText(item);
        if (
          !item.type &&
          item.height === mostUsedHeight &&
          item.font !== mostUsedFont &&
          (!lastItem ||
            lastItem.y < item.y ||
            (lastItem.type && (lastItem.type as BlockTypeDef).headline) ||
            lastItem.y - item.y > mostUsedDistance * 2) &&
          text === text.toUpperCase() &&
          !hasMathUnicode(text)
        ) {
          item.annotation = DETECTED_ANNOTATION;
          item.type = nextHeadlineType;
        }
        lastItem = item;
      });
    });
  }

  parseResult.pages.forEach((page) => {
    (page.items as LineItemData[]).forEach((item) => {
      if (item.words.length > 1) {
        const firstWord = item.words[0].string;
        if (/^#{1,6}$/.test(firstWord)) {
          item.type = headlineByLevel(firstWord.length);
          item.words = item.words.slice(1);
          item.annotation = DETECTED_ANNOTATION;
        }
      }
    });
  });

  return { ...parseResult, messages: [] };
}

// Stage 7: DetectListItems
export function detectListItems(parseResult: ParseResult): ParseResult {
  parseResult.pages.forEach((page) => {
    const newItems: LineItemData[] = [];
    (page.items as LineItemData[]).forEach((item) => {
      newItems.push(item);
      if (!item.type) {
        const text = lineItemText(item);
        if (item.words.length > 0 && isListItemCharacter(item.words[0].string)) {
          if (item.words[0].string === "-") {
            item.annotation = DETECTED_ANNOTATION;
            item.type = BlockType.LIST;
          } else {
            item.annotation = REMOVED_ANNOTATION;
            const newWords = item.words.map((word) => ({ ...word }));
            newWords[0].string = "-";
            newItems.push({
              ...item,
              words: newWords,
              annotation: ADDED_ANNOTATION,
              type: BlockType.LIST,
            });
          }
        } else if (isNumberedListItem(text)) {
          item.annotation = DETECTED_ANNOTATION;
          item.type = BlockType.LIST;
        }
      }
    });
    page.items = newItems;
  });

  const { mostUsedDistance = 12 } = parseResult.globals;
  parseResult.pages.forEach((page) => {
    const items = page.items as LineItemData[];
    const minX = minXFromPageItems(items) ?? 0;
    const indentThreshold = Math.max(mostUsedDistance * 0.8, 5);

    let i = 0;
    while (i < items.length) {
      const item = items[i];
      const itemText = lineItemText(item);
      if (item.type || item.x <= minX + indentThreshold || itemText.startsWith("|")) {
        i++;
        continue;
      }

      const groupX = item.x;
      let j = i + 1;
      while (
        j < items.length &&
        !items[j].type &&
        Math.abs(items[j].x - groupX) <= 3
      ) {
        j++;
      }

      if (j - i >= 2) {
        const prev = i > 0 ? items[i - 1] : null;
        const isAfterHeading = prev?.type && (prev.type as BlockTypeDef).headline;
        const hasBigGap = prev ? prev.y - item.y > mostUsedDistance * 1.8 : true;

        if (isAfterHeading || hasBigGap) {
          for (let k = i; k < j; k++) {
            items[k].words = [{ string: "-" } as WordData, ...items[k].words];
            items[k].type = BlockType.LIST;
            items[k].annotation = DETECTED_ANNOTATION;
          }
        }
      }
      i = Math.max(j, i + 1);
    }
  });

  return { ...parseResult, messages: [] };
}

// Stage 8: GatherBlocks
function bigDistance(
  lastItem: LineItemData,
  item: LineItemData,
  minX: number,
  mostUsedDistance: number
): boolean {
  const distance = lastItem.y - item.y;
  if (distance < 0 - mostUsedDistance / 2) {
    return true;
  }
  let allowedDistance = mostUsedDistance + 1;
  if (lastItem.x > minX && item.x > minX) {
    allowedDistance = mostUsedDistance + mostUsedDistance / 2;
  }
  return distance > allowedDistance;
}

function shouldFlushBlock(
  stashedBlock: LineItemBlockData,
  item: LineItemData,
  minX: number,
  mostUsedDistance: number
): boolean {
  if (
    stashedBlock.type &&
    (stashedBlock.type as BlockTypeDef).mergeFollowingNonTypedItems &&
    !item.type
  ) {
    return false;
  }
  const lastItem = stashedBlock.items[stashedBlock.items.length - 1];
  const hasBigDist = bigDistance(lastItem, item, minX, mostUsedDistance);
  if (
    stashedBlock.type &&
    (stashedBlock.type as BlockTypeDef).mergeFollowingNonTypedItemsWithSmallDistance &&
    !item.type &&
    !hasBigDist
  ) {
    return false;
  }
  if (item.type !== stashedBlock.type) {
    return true;
  }
  if (item.type) {
    return !(item.type as BlockTypeDef).mergeToBlock;
  } else {
    return hasBigDist;
  }
}

export function gatherBlocks(parseResult: ParseResult): ParseResult {
  const { mostUsedDistance = 12 } = parseResult.globals;

  parseResult.pages.forEach((page) => {
    const items = page.items as LineItemData[];
    const blocks: LineItemBlockData[] = [];
    let stashedBlock = createLineItemBlock();

    const flushStashedItems = () => {
      if (stashedBlock.items.length > 1) {
        stashedBlock.annotation = DETECTED_ANNOTATION;
      }
      blocks.push(stashedBlock);
      stashedBlock = createLineItemBlock();
    };

    const minX = minXFromPageItems(items) || 0;
    items.forEach((item) => {
      if (
        stashedBlock.items.length > 0 &&
        shouldFlushBlock(stashedBlock, item, minX, mostUsedDistance)
      ) {
        flushStashedItems();
      }
      addItemToBlock(stashedBlock, item);
    });
    if (stashedBlock.items.length > 0) {
      flushStashedItems();
    }
    page.items = blocks;
  });

  return { ...parseResult, messages: [] };
}

// Stage 9: DetectCodeQuoteBlocks
function lineIsNaturalLanguage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 10) return true;
  if (wordCount >= 4 && /[.!?]$/.test(trimmed)) return true;
  if (
    wordCount >= 6 &&
    /^[A-Z][a-z]/.test(trimmed) &&
    !/[{};=()\[\]<>|]/.test(trimmed)
  )
    return true;
  return false;
}

const CODE_SYNTAX_RE =
  /[{};=\(\)\[\]]|\b(function|const|let|var|return|import|export|class|if|for|while|def|print)\b/;

function looksLikeCodeBlock(
  minX: number,
  items: LineItemData[],
  mostUsedHeight: number
): boolean {
  if (items.length === 0) return false;

  for (const item of items) {
    const text = item.words.map((w) => w.string).join(" ");
    if (lineIsNaturalLanguage(text)) return false;
    const firstWord = item.words[0]?.string ?? "";
    if (firstWord === "|" || isListItemCharacter(firstWord)) return false;
  }

  if (items.length === 1) {
    if (!(items[0].x > minX && items[0].height <= mostUsedHeight + 1))
      return false;
    const text = items[0].words.map((w) => w.string).join(" ");
    if (!CODE_SYNTAX_RE.test(text)) return false;
  } else {
    for (const item of items) {
      if (item.x === minX) return false;
    }
  }

  return true;
}

export function detectCodeQuoteBlocks(parseResult: ParseResult): ParseResult {
  const { mostUsedHeight = 12 } = parseResult.globals;

  parseResult.pages.forEach((page) => {
    const blocks = page.items as LineItemBlockData[];
    const minX = minXFromBlocks(blocks) || 0;
    blocks.forEach((block) => {
      if (!block.type && looksLikeCodeBlock(minX, block.items, mostUsedHeight)) {
        block.annotation = DETECTED_ANNOTATION;
        block.type = BlockType.CODE;
      }
    });

    let i = 0;
    while (i < blocks.length - 1) {
      if (blocks[i].type === BlockType.CODE && blocks[i + 1].type === BlockType.CODE) {
        blocks[i].items.push(...blocks[i + 1].items);
        blocks.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  });

  return { ...parseResult, messages: [] };
}

// Stage 10: DetectListLevels
export function detectListLevels(parseResult: ParseResult): ParseResult {
  parseResult.pages.forEach((page) => {
    (page.items as LineItemBlockData[])
      .filter((block) => block.type === BlockType.LIST)
      .forEach((listBlock) => {
        let lastItemX: number | undefined;
        let currentLevel = 0;
        const xByLevel: Record<number, number> = {};
        let modifiedBlock = false;

        listBlock.items.forEach((item) => {
          if (lastItemX !== undefined) {
            if (item.x > lastItemX) {
              currentLevel++;
              xByLevel[item.x] = currentLevel;
            } else if (item.x < lastItemX) {
              currentLevel = xByLevel[item.x] || 0;
            }
          } else {
            xByLevel[item.x] = 0;
          }
          if (currentLevel > 0) {
            item.words = [{ string: " ".repeat(currentLevel * 3) }].concat(item.words);
            modifiedBlock = true;
          }
          lastItemX = item.x;
        });

        if (modifiedBlock) {
          listBlock.annotation = MODIFIED_ANNOTATION;
        } else {
          listBlock.annotation = UNCHANGED_ANNOTATION;
        }
      });
  });

  return { ...parseResult, messages: [] };
}

// Stage 11: ToTextBlocks
export function toTextBlocks(parseResult: ParseResult): ParseResult {
  parseResult.pages.forEach((page) => {
    const textItems: { category: string; text: string }[] = [];
    (page.items as LineItemBlockData[]).forEach((block) => {
      const category = block.type ? block.type.name : "Unknown";
      textItems.push({
        category,
        text: blockToText(block),
      });
    });
    page.items = textItems;
  });

  return { ...parseResult, messages: [] };
}

// Stage 12: ToMarkdown
export function toMarkdown(parseResult: ParseResult): ParseResult {
  parseResult.pages.forEach((page) => {
    let text = "";
    (page.items as { text: string }[]).forEach((block) => {
      text += block.text + "\n";
    });
    page.items = [text];
  });

  return { ...parseResult, messages: [] };
}

// Run the complete transformation pipeline
export function runTransformationPipeline(
  parseResult: ParseResult,
  fontMap: Map<string, { name: string }>
): string {
  const stages: ((pr: ParseResult) => ParseResult)[] = [
    (pr) => calculateGlobalStats(pr, fontMap),
    detectTableRows,
    compactLines,
    removeRepetitiveElements,
    verticalToHorizontal,
    detectTOC,
    detectHeaders,
    detectListItems,
    gatherBlocks,
    detectCodeQuoteBlocks,
    detectListLevels,
    toTextBlocks,
    toMarkdown,
  ];

  let result = parseResult;

  stages.forEach((stage, i) => {
    if (i > 0) {
      result = completeTransform(result);
    }
    result = stage(result);
  });

  let markdown = "";
  result.pages.forEach((page) => {
    if (page.items.length > 0) {
      markdown += page.items[0];
    }
  });

  return markdown;
}
