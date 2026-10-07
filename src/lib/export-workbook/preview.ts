// Renders a worksheet of the export workbook as static HTML (column widths, row heights, merged
// cells, borders, fonts, fills and number formats). It is a review aid for the visual checks, not a
// print engine: it lets us look at a generated sheet next to the reference PDF without Excel.

import { DOMParser } from "@xmldom/xmldom";
import { numberToCol, parseRange } from "./refs.ts";
import type { XlsxSheet, XlsxWorkbook } from "./xlsx-package.ts";

type Side = { style: string; color: string } | null;
type Xf = { numFmtId: number; fontId: number; fillId: number; borderId: number; horizontal: string; vertical: string; wrap: boolean };
type Font = { size: number; bold: boolean; italic: boolean; underline: boolean; color: string; name: string };
type Border = { left: Side; right: Side; top: Side; bottom: Side };

const parse = (text: string) => new DOMParser().parseFromString(text, "text/xml") as unknown as Document;
const kids = (node: Node | null | undefined, name?: string) => node ? (Array.from(node.childNodes as unknown as ArrayLike<Node>).filter(item => item.nodeType === 1 && (!name || (item as Element).localName === name)) as Element[]) : [];
const first = (node: Node | null | undefined, name: string) => kids(node, name)[0] ?? null;

const BUILTIN_FORMATS: Record<number, string> = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 14: "dd.mm.yyyy", 15: "d-mmm-yy", 22: "dd.mm.yyyy hh:mm", 49: "@" };
const MONTHS_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function applyTint(hex: string, tint: number) {
  const channels = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const adjusted = channels.map(channel => Math.round(tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint));
  return adjusted.map(channel => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0")).join("");
}

class Styles {
  readonly formats = new Map<number, string>();
  readonly fonts: Font[] = [];
  readonly fills: string[] = [];
  readonly borders: Border[] = [];
  readonly xfs: Xf[] = [];
  private theme: string[] = [];

  constructor(workbook: XlsxWorkbook) {
    const themeXml = workbook.part("xl/theme/theme1.xml");
    if (themeXml) {
      const scheme = first(first(parse(themeXml).documentElement, "themeElements"), "clrScheme");
      const colors = new Map<string, string>();
      for (const entry of kids(scheme)) {
        const value = kids(entry)[0];
        colors.set(entry.localName, (value?.getAttribute("val") === "window" ? "FFFFFF" : value?.getAttribute("val") === "windowText" ? "000000" : value?.getAttribute("lastClr") ?? value?.getAttribute("val") ?? "000000").toUpperCase());
      }
      this.theme = THEME_ORDER.map(name => colors.get(name) ?? "000000");
    }
    const stylesXml = workbook.part("xl/styles.xml");
    if (!stylesXml) return;
    const root = parse(stylesXml).documentElement;
    for (const format of kids(first(root, "numFmts"), "numFmt")) this.formats.set(Number(format.getAttribute("numFmtId")), format.getAttribute("formatCode") ?? "General");
    for (const font of kids(first(root, "fonts"), "font")) {
      this.fonts.push({
        size: Number(first(font, "sz")?.getAttribute("val") ?? 11), bold: !!first(font, "b"), italic: !!first(font, "i"), underline: !!first(font, "u"),
        color: this.color(first(font, "color")) ?? "000000", name: first(font, "name")?.getAttribute("val") ?? "Arial",
      });
    }
    for (const fill of kids(first(root, "fills"), "fill")) {
      const pattern = first(fill, "patternFill");
      this.fills.push(pattern?.getAttribute("patternType") === "solid" ? this.color(first(pattern, "fgColor")) ?? "" : "");
    }
    for (const border of kids(first(root, "borders"), "border")) {
      const side = (name: string): Side => { const element = first(border, name); const style = element?.getAttribute("style"); return style ? { style, color: this.color(first(element, "color")) ?? "000000" } : null; };
      this.borders.push({ left: side("left"), right: side("right"), top: side("top"), bottom: side("bottom") });
    }
    for (const xf of kids(first(root, "cellXfs"), "xf")) {
      const alignment = first(xf, "alignment");
      this.xfs.push({
        numFmtId: Number(xf.getAttribute("numFmtId") ?? 0), fontId: Number(xf.getAttribute("fontId") ?? 0), fillId: Number(xf.getAttribute("fillId") ?? 0), borderId: Number(xf.getAttribute("borderId") ?? 0),
        horizontal: alignment?.getAttribute("horizontal") ?? "", vertical: alignment?.getAttribute("vertical") ?? "bottom", wrap: alignment?.getAttribute("wrapText") === "1",
      });
    }
  }

  private color(element: Element | null): string | null {
    if (!element) return null;
    const rgb = element.getAttribute("rgb");
    if (rgb) return rgb.slice(-6).toUpperCase();
    const theme = element.getAttribute("theme");
    if (theme !== null && this.theme[Number(theme)]) {
      const tint = Number(element.getAttribute("tint") ?? 0);
      return tint ? applyTint(this.theme[Number(theme)], tint).toUpperCase() : this.theme[Number(theme)];
    }
    return null;
  }

  hasBorder(index: number) {
    const border = this.borders[this.xfs[index]?.borderId ?? 0];
    return !!border && !!(border.left || border.right || border.top || border.bottom);
  }
}

function formatSerialDate(serial: number, format: string) {
  const date = new Date(Math.round((serial - 25_569) * 86_400_000));
  const [d, m, y, wd] = [date.getUTCDate(), date.getUTCMonth(), date.getUTCFullYear(), date.getUTCDay()];
  const cleaned = format.replace(/\[\$-[^\]]*\]/g, "").replace(/\\(.)/g, "$1");
  return cleaned.replace(/"([^"]*)"|yyyy|yy|mmmm|mmm|mm|m|dddd|dd|d/g, (token, literal) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "yyyy": return String(y);
      case "yy": return String(y).slice(-2);
      case "mmmm": return MONTHS_FULL[m];
      case "mmm": return MONTHS_SHORT[m];
      case "mm": return String(m + 1).padStart(2, "0");
      case "m": return String(m + 1);
      case "dddd": return WEEKDAYS[wd];
      case "dd": return String(d).padStart(2, "0");
      default: return String(d);
    }
  });
}

function formatNumberCell(value: number, format: string) {
  const code = format.split(";")[0];
  if (/[dmy]/i.test(code.replace(/"[^"]*"|\\./g, "").replace(/\[[^\]]*\]/g, "").replace(/[#0,.\s%]/g, ""))) return formatSerialDate(value, code);
  const decimals = /\.(0+)/.exec(code)?.[1].length ?? 0;
  const grouped = /#,##/.test(code);
  if (code === "General" || code === "@") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
  const fixed = Math.abs(value).toFixed(decimals);
  const [integer, fraction] = fixed.split(".");
  const body = grouped ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : integer;
  return `${value < 0 ? "-" : ""}${body}${fraction ? `,${fraction}` : ""}`;
}

function cellText(sheet: XlsxSheet, ref: string, styles: Styles, styleIndex: number) {
  const raw = sheet.raw(ref);
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "boolean") return raw ? "TRUE" : "FALSE";
  const formatId = styles.xfs[styleIndex]?.numFmtId ?? 0;
  return formatNumberCell(raw, styles.formats.get(formatId) ?? BUILTIN_FORMATS[formatId] ?? "General");
}

const BORDER_WIDTH: Record<string, string> = { thin: "1px", hair: "1px", dotted: "1px", dashed: "1px", medium: "2px", mediumDashed: "2px", thick: "3px", double: "3px" };
const borderCss = (side: Side) => side ? `${BORDER_WIDTH[side.style] ?? "1px"} ${side.style.includes("dash") || side.style === "dotted" ? "dashed" : "solid"} #${side.color}` : "none";

export type PreviewOptions = { title?: string; maxColumns?: number };

/** Used range: cells with content or visible borders (forms such as CMR are mostly empty bordered boxes). */
export function usedRange(sheet: XlsxSheet, styles: Styles) {
  let bottom = 1, right = 1;
  for (const { row, col, element, style } of sheet.cells()) {
    if (element.childNodes.length || styles.hasBorder(style)) { bottom = Math.max(bottom, row); right = Math.max(right, col); }
  }
  for (const range of sheet.mergeRanges) { const bounds = parseRange(range); bottom = Math.max(bottom, bounds.bottom); right = Math.max(right, bounds.right); }
  return { bottom, right };
}

export function renderSheetHtml(workbook: XlsxWorkbook, sheetName: string, options: PreviewOptions = {}) {
  const sheet = workbook.sheet(sheetName);
  const styles = new Styles(workbook);
  const { bottom, right: rawRight } = usedRange(sheet, styles);
  const right = Math.min(rawRight, options.maxColumns ?? 60);
  const widths = sheet.columnWidths(), defaults = sheet.defaults();
  const px = (width: number) => Math.round(width * 7 + 5);
  const merged = new Map<string, { rowspan: number; colspan: number }>();
  const covered = new Set<string>();
  for (const range of sheet.mergeRanges) {
    const bounds = parseRange(range);
    merged.set(`${bounds.top}:${bounds.left}`, { rowspan: bounds.bottom - bounds.top + 1, colspan: bounds.right - bounds.left + 1 });
    for (let row = bounds.top; row <= bounds.bottom; row++) for (let col = bounds.left; col <= bounds.right; col++) if (row !== bounds.top || col !== bounds.left) covered.add(`${row}:${col}`);
  }
  const cellMap = new Map<string, { element: Element; style: number }>();
  for (const { row, col, element, style } of sheet.cells()) cellMap.set(`${row}:${col}`, { element, style });
  const borderOf = (row: number, col: number) => styles.borders[styles.xfs[cellMap.get(`${row}:${col}`)?.style ?? 0]?.borderId ?? 0];
  const columnPixels = Array.from({ length: right }, (_, index) => px(widths.get(index + 1) ?? defaults.columnWidth));
  const columns = columnPixels.map(width => `<col style="width:${width}px">`).join("");
  let body = "";
  for (let row = 1; row <= bottom; row++) {
    const height = Math.round((sheet.rowHeight(row) ?? defaults.rowHeight) * 1.333);
    let cells = "";
    for (let col = 1; col <= right; col++) {
      if (covered.has(`${row}:${col}`)) continue;
      const entry = cellMap.get(`${row}:${col}`);
      const span = merged.get(`${row}:${col}`);
      const xf = styles.xfs[entry?.style ?? 0];
      const font = styles.fonts[xf?.fontId ?? 0];
      const border = borderOf(row, col) ?? { left: null, right: null, top: null, bottom: null };
      const rightCell = span ? borderOf(row, col + span.colspan - 1) : border;
      const bottomCell = span ? borderOf(row + span.rowspan - 1, col) : border;
      const fill = styles.fills[xf?.fillId ?? 0];
      const text = entry ? cellText(sheet, `${numberToCol(col)}${row}`, styles, entry.style) : "";
      const isNumber = typeof sheet.raw(`${numberToCol(col)}${row}`) === "number";
      const align = xf?.horizontal === "general" || !xf?.horizontal ? (isNumber ? "right" : "left") : xf.horizontal === "centerContinuous" ? "center" : xf.horizontal;
      const style = [
        `border-left:${borderCss(border.left)}`, `border-top:${borderCss(border.top)}`, `border-right:${borderCss(rightCell?.right ?? null)}`, `border-bottom:${borderCss(bottomCell?.bottom ?? null)}`,
        font ? `font:${font.italic ? "italic " : ""}${font.bold ? "bold " : ""}${font.size}pt '${font.name.replace(/'/g, "")}',Arial,sans-serif;color:#${font.color}` : "",
        fill ? `background:#${fill}` : "", `text-align:${align}`, `vertical-align:${xf?.vertical === "center" ? "middle" : xf?.vertical === "top" ? "top" : "bottom"}`,
        xf?.wrap ? "white-space:pre-wrap;overflow-wrap:anywhere" : "white-space:pre;overflow:hidden",
      ].filter(Boolean).join(";");
      cells += `<td${span && span.colspan > 1 ? ` colspan="${span.colspan}"` : ""}${span && span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : ""} style="${style}">${escapeHtml(text)}</td>`;
    }
    body += `<tr style="height:${height}px">${cells}</tr>`;
  }
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escapeHtml(options.title ?? sheetName)}</title><style>
body{margin:12px;background:#fff}table{border-collapse:collapse;table-layout:fixed;width:${columnPixels.reduce((sum, width) => sum + width, 0)}px}td{padding:0 2px;line-height:1.15;box-sizing:border-box}
</style><body><table>${columns ? `<colgroup>${columns}</colgroup>` : ""}${body}</table></body></html>`;
}

/** Natural size of the rendered table in CSS pixels (for sizing a screenshot window). */
export function sheetPixelSize(workbook: XlsxWorkbook, sheetName: string) {
  const sheet = workbook.sheet(sheetName);
  const { bottom, right } = usedRange(sheet, new Styles(workbook));
  const widths = sheet.columnWidths(), defaults = sheet.defaults();
  let width = 24, height = 24;
  for (let col = 1; col <= Math.min(right, 60); col++) width += Math.round((widths.get(col) ?? defaults.columnWidth) * 7 + 5);
  for (let row = 1; row <= bottom; row++) height += Math.round((sheet.rowHeight(row) ?? defaults.rowHeight) * 1.333);
  return { width, height };
}
