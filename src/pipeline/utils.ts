// String utility functions + page item functions for PDF text processing

const MIN_DIGIT_CHAR_CODE = 48;
const MAX_DIGIT_CHAR_CODE = 57;
const WHITESPACE_CHAR_CODE = 32;
const TAB_CHAR_CODE = 9;
const DOT_CHAR_CODE = 46;

export function isDigit(charCode: number): boolean {
  return charCode >= MIN_DIGIT_CHAR_CODE && charCode <= MAX_DIGIT_CHAR_CODE;
}

export function isNumber(string: string): boolean {
  for (let i = 0; i < string.length; i++) {
    const charCode = string.charCodeAt(i);
    if (!isDigit(charCode)) {
      return false;
    }
  }
  return true;
}

export function hasOnly(string: string, char: string): boolean {
  const charCode = char.charCodeAt(0);
  for (let i = 0; i < string.length; i++) {
    const aCharCode = string.charCodeAt(i);
    if (aCharCode !== charCode) {
      return false;
    }
  }
  return true;
}

export function normalizedCharCodeArray(string: string): number[] {
  const upper = string.toUpperCase();
  const result: number[] = [];
  for (let i = 0; i < upper.length; i++) {
    const charCode = upper.charCodeAt(i);
    if (charCode !== WHITESPACE_CHAR_CODE && charCode !== TAB_CHAR_CODE && charCode !== DOT_CHAR_CODE) {
      result.push(charCode);
    }
  }
  return result;
}

export function isListItemCharacter(string: string): boolean {
  if (string.length > 1) {
    return false;
  }
  const char = string.charAt(0);
  return char === "-" || char === "\u2022" || char === "\u2013";
}

export function isListItem(string: string): boolean {
  return /^[\s]*[-\u2022\u2013][\s].*$/g.test(string);
}

export function isNumberedListItem(string: string): boolean {
  return /^[\s]*[\d]*[.][\s].*$/g.test(string);
}

export function wordMatch(string1: string, string2: string): number {
  const words1 = new Set(string1.toUpperCase().split(" "));
  const words2 = new Set(string2.toUpperCase().split(" "));
  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  return intersection.size / Math.max(words1.size, words2.size);
}

// Page item functions

interface HasX {
  x: number;
}

export function minXFromBlocks(blocks: { items: HasX[] }[]): number | null {
  return minXFromPageItems(blocks.flatMap((b) => b.items));
}

export function minXFromPageItems(items: HasX[]): number | null {
  let minX = 999;
  items.forEach((item) => {
    minX = Math.min(minX, item.x);
  });
  return minX === 999 ? null : minX;
}

export function sortByX<T extends HasX>(items: T[]): void {
  items.sort((a, b) => a.x - b.x);
}

// Returns true if text contains Unicode math symbols
const MATH_UNICODE_RE =
  /[∫∬∭∮∞πθΩ√∛∜±×÷∂∇∑∏∆δεζηλμξρστυφχψωΓΔΘΛΞΠΣΦΨ≤≥≠≈≡∝∈∉⊂⊃∪∩∀∃∄∴∵]/;

export function hasMathUnicode(text: string): boolean {
  return MATH_UNICODE_RE.test(text);
}
