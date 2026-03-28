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
