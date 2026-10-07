// A1-reference helpers and formula rewriting shared by the XLSX package patcher.
// The export workbook only uses plain A1 references, so this deliberately does not try
// to be a general Excel parser: it understands string literals, sheet prefixes
// ('quoted' or bare), $-anchors and ranges, which is everything the reference book needs.

export const colToNumber = (letters: string) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);

export const numberToCol = (column: number) => {
  let letters = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  return letters;
};

export const cellName = (column: number, row: number) => `${numberToCol(column)}${row}`;

export function parseCell(ref: string) {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref);
  if (!match) throw new Error(`Некорректная ссылка на ячейку: ${ref}`);
  return { col: colToNumber(match[1]), row: Number(match[2]) };
}

export type RangeBounds = { left: number; top: number; right: number; bottom: number };

export function parseRange(range: string): RangeBounds {
  const [from, to = from] = range.split(":");
  const a = parseCell(from), b = parseCell(to);
  return { left: Math.min(a.col, b.col), top: Math.min(a.row, b.row), right: Math.max(a.col, b.col), bottom: Math.max(a.row, b.row) };
}

export const rangeName = (bounds: RangeBounds) => bounds.left === bounds.right && bounds.top === bounds.bottom
  ? cellName(bounds.left, bounds.top)
  : `${cellName(bounds.left, bounds.top)}:${cellName(bounds.right, bounds.bottom)}`;

export type FormulaReference = {
  sheet: string | null;
  startColAbs: boolean; startCol: number; startRowAbs: boolean; startRow: number;
  end: { colAbs: boolean; col: number; rowAbs: boolean; row: number } | null;
};

const REFERENCE = /^(?:(?:'((?:[^']|'')+)'|([^\s'!,;:()+\-*/^&=<>"]+))!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_.Ѐ-ӿ]/;

export function formatReference(reference: FormulaReference) {
  const prefix = reference.sheet === null ? "" : /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(reference.sheet) ? `${reference.sheet}!` : `'${reference.sheet.replace(/'/g, "''")}'!`;
  const start = `${reference.startColAbs ? "$" : ""}${numberToCol(reference.startCol)}${reference.startRowAbs ? "$" : ""}${reference.startRow}`;
  const end = reference.end ? `:${reference.end.colAbs ? "$" : ""}${numberToCol(reference.end.col)}${reference.end.rowAbs ? "$" : ""}${reference.end.row}` : "";
  return `${prefix}${start}${end}`;
}

// Calls `rewrite` for every reference in the formula (outside string literals) and splices the result.
export function mapFormulaReferences(formula: string, rewrite: (reference: FormulaReference) => FormulaReference) {
  let out = "";
  let index = 0;
  while (index < formula.length) {
    const char = formula[index];
    if (char === '"') {
      let end = index + 1;
      while (end < formula.length && !(formula[end] === '"' && formula[end + 1] !== '"')) end += formula[end] === '"' ? 2 : 1;
      out += formula.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const previous = index === 0 ? "" : formula[index - 1];
    if (!IDENTIFIER_CHAR.test(previous) && previous !== "!" && previous !== "'") {
      const match = REFERENCE.exec(formula.slice(index));
      if (match) {
        const next = formula[index + match[0].length] ?? "";
        const sheet = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2] ?? null;
        if (next !== "(" && !IDENTIFIER_CHAR.test(next)) {
          const reference: FormulaReference = {
            sheet,
            startColAbs: match[3] === "$", startCol: colToNumber(match[4]), startRowAbs: match[5] === "$", startRow: Number(match[6]),
            end: match[8] ? { colAbs: match[7] === "$", col: colToNumber(match[8]), rowAbs: match[9] === "$", row: Number(match[10]) } : null,
          };
          out += formatReference(rewrite(reference));
          index += match[0].length;
          continue;
        }
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

// Rows `at..` move by `delta` (insertion: delta > 0, deletion of rows [at, at - delta): delta < 0).
export function shiftFormulaRows(formula: string, ownerSheet: string, targetSheet: string, at: number, delta: number) {
  // Deleted rows are [at, at - delta). A single reference into them collapses to `at`; a range
  // loses only the deleted part: its start moves to `at`, its end to the last surviving row.
  const move = (row: number, isRangeEnd: boolean) => {
    if (delta > 0) return row >= at ? row + delta : row;
    if (row >= at - delta) return row + delta;
    if (row >= at) return isRangeEnd ? Math.max(at - 1, 1) : at;
    return row;
  };
  return mapFormulaReferences(formula, reference => {
    if ((reference.sheet ?? ownerSheet) !== targetSheet) return reference;
    return {
      ...reference,
      startRow: move(reference.startRow, false),
      end: reference.end ? { ...reference.end, row: move(reference.end.row, true) } : null,
    };
  });
}

// Moves relative references the way Excel does when a formula is copied by (dRow, dCol): used to
// expand shared formulas and to clone a template row.
export function translateFormula(formula: string, dRow: number, dCol: number) {
  return mapFormulaReferences(formula, reference => ({
    ...reference,
    startCol: reference.startColAbs ? reference.startCol : reference.startCol + dCol,
    startRow: reference.startRowAbs ? reference.startRow : reference.startRow + dRow,
    end: reference.end ? {
      ...reference.end,
      col: reference.end.colAbs ? reference.end.col : reference.end.col + dCol,
      row: reference.end.rowAbs ? reference.end.row : reference.end.row + dRow,
    } : null,
  }));
}
