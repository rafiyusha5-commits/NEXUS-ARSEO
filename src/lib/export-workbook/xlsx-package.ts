// Patches an XLSX package in place at the XML level. ExcelJS round-trips drop drawings (the CMR
// stamp circle), x14 data validations and other parts of the reference workbook, which would break
// "the printed look of the reference". Here every part we do not touch is copied byte for byte.

import PizZip from "pizzip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { cellName, parseCell, parseRange, rangeName, shiftFormulaRows, translateFormula } from "./refs.ts";
import { evaluateFormula, FormulaError, formatNumber, type Scalar } from "./formula-eval.ts";

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type CellInput = string | number | Date | null;

const parseXml = (text: string) => new DOMParser().parseFromString(text, "text/xml") as unknown as Document;
const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc as never);
const children = (parent: Node, name?: string) => Array.from(parent.childNodes as unknown as ArrayLike<Node>).filter((node): node is Element => node.nodeType === 1 && (!name || (node as Element).localName === name));
const firstChild = (parent: Node, name: string) => children(parent, name)[0] ?? null;
const textOf = (element: Element) => element.textContent ?? "";

export const excelSerial = (date: Date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000 + 25_569;

function stringFromEntry(entry: Element) {
  // <si>/<is> hold either one <t> or rich-text runs <r><t>…</t></r>; phonetic runs (<rPh>) are not text.
  return children(entry).filter(node => node.localName === "t" || node.localName === "r").map(node => node.localName === "t" ? textOf(node) : children(node, "t").map(textOf).join("")).join("");
}

export class XlsxSheet {
  readonly workbook: XlsxWorkbook;
  name: string;
  readonly path: string;
  readonly doc: Document;
  readonly sheetData: Element;
  private rows = new Map<number, Element>();

  constructor(workbook: XlsxWorkbook, name: string, path: string, doc: Document) {
    this.workbook = workbook;
    this.name = name;
    this.path = path;
    this.doc = doc;
    const sheetData = firstChild(doc.documentElement, "sheetData");
    if (!sheetData) throw new Error(`В листе «${name}» нет данных`);
    this.sheetData = sheetData;
    this.reindex();
  }

  private reindex() {
    this.rows.clear();
    for (const row of children(this.sheetData, "row")) {
      row.removeAttribute("spans");
      this.rows.set(Number(row.getAttribute("r")), row);
    }
  }

  private el(name: string) { return this.doc.createElementNS(MAIN_NS, name); }

  row(index: number, create = false) {
    const existing = this.rows.get(index);
    if (existing || !create) return existing ?? null;
    const row = this.el("row");
    row.setAttribute("r", String(index));
    const next = [...this.rows.keys()].filter(key => key > index).sort((a, b) => a - b)[0];
    this.sheetData.insertBefore(row, next === undefined ? null : this.rows.get(next)!);
    this.rows.set(index, row);
    return row;
  }

  cellElement(ref: string, create = false) {
    const { col, row: rowIndex } = parseCell(ref);
    const row = this.row(rowIndex, create);
    if (!row) return null;
    for (const cell of children(row, "c")) {
      const existing = parseCell(cell.getAttribute("r")!).col;
      if (existing === col) return cell;
      if (existing > col) {
        if (!create) return null;
        const created = this.el("c");
        created.setAttribute("r", cellName(col, rowIndex));
        row.insertBefore(created, cell);
        return created;
      }
    }
    if (!create) return null;
    const created = this.el("c");
    created.setAttribute("r", cellName(col, rowIndex));
    row.appendChild(created);
    return created;
  }

  private clearContent(cell: Element) {
    for (const child of children(cell)) cell.removeChild(child);
    cell.removeAttribute("t");
  }

  /** Writes a literal; the cell keeps its style (`s`). Empty strings are kept as empty text so linked cells show blank, not 0. */
  set(ref: string, value: CellInput, options: { keepEmptyText?: boolean } = {}) {
    const cell = this.cellElement(ref, true)!;
    this.clearContent(cell);
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (value === "" && !options.keepEmptyText) return;
      cell.setAttribute("t", "inlineStr");
      const inline = this.el("is");
      const text = this.el("t");
      text.setAttribute("xml:space", "preserve");
      text.appendChild(this.doc.createTextNode(value));
      inline.appendChild(text);
      cell.appendChild(inline);
      return;
    }
    const v = this.el("v");
    v.appendChild(this.doc.createTextNode(formatNumber(value instanceof Date ? excelSerial(value) : value)));
    cell.appendChild(v);
  }

  setFormula(ref: string, formula: string) {
    const cell = this.cellElement(ref, true)!;
    this.clearContent(cell);
    const f = this.el("f");
    f.appendChild(this.doc.createTextNode(formula.replace(/^=/, "")));
    cell.appendChild(f);
  }

  clear(ref: string) {
    const cell = this.cellElement(ref);
    if (cell) this.clearContent(cell);
  }

  formula(ref: string) {
    const cell = this.cellElement(ref);
    const f = cell && firstChild(cell, "f");
    return f ? textOf(f) : null;
  }

  /** Literal value of a cell, or the cached result of a formula. `undefined` = no such cell. */
  raw(ref: string): Scalar | undefined {
    const cell = this.cellElement(ref);
    if (!cell) return undefined;
    const type = cell.getAttribute("t");
    if (type === "inlineStr") { const inline = firstChild(cell, "is"); return inline ? stringFromEntry(inline) : ""; }
    const v = firstChild(cell, "v");
    if (!v) return firstChild(cell, "f") ? undefined : null;
    if (type === "str" || type === "e") return textOf(v);
    if (type === "b") return textOf(v) === "1";
    const number = Number(textOf(v));
    return Number.isFinite(number) ? number : textOf(v);
  }

  *formulaCells() {
    for (const row of this.rows.values()) for (const cell of children(row, "c")) {
      const f = firstChild(cell, "f");
      if (f) yield { cell, f, ref: cell.getAttribute("r")! };
    }
  }

  /** Cells with content (literal or formula) in reading order. */
  *contentCells() {
    for (const row of [...this.rows.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1])) {
      for (const cell of children(row, "c")) if (children(cell).length) yield cell.getAttribute("r")!;
    }
  }

  get mergeRanges() {
    const merges = firstChild(this.doc.documentElement, "mergeCells");
    return merges ? children(merges, "mergeCell").map(item => item.getAttribute("ref")!) : [];
  }

  private writeMerges(ranges: string[]) {
    const root = this.doc.documentElement;
    let merges = firstChild(root, "mergeCells");
    if (!ranges.length) { if (merges) root.removeChild(merges); return; }
    if (!merges) {
      merges = this.el("mergeCells");
      // schema order: sheetData, sheetCalcPr, sheetProtection, protectedRanges, scenarios, autoFilter, sortState, dataConsolidate, customSheetViews, mergeCells
      const anchor = ["customSheetViews", "dataConsolidate", "sortState", "autoFilter", "scenarios", "protectedRanges", "sheetProtection", "sheetCalcPr", "sheetData"].map(name => firstChild(root, name)).find(Boolean)!;
      root.insertBefore(merges, anchor.nextSibling);
    }
    for (const item of children(merges)) merges.removeChild(item);
    for (const range of ranges) { const item = this.el("mergeCell"); item.setAttribute("ref", range); merges.appendChild(item); }
    merges.setAttribute("count", String(ranges.length));
  }

  merge(range: string) { this.writeMerges([...this.mergeRanges, range]); }
  unmerge(range: string) { this.writeMerges(this.mergeRanges.filter(existing => existing !== range)); }

  /** Moves rows at/after `at` by `delta` (cells, merges and dimension). Formula references are shifted by the workbook. */
  moveRows(at: number, delta: number) {
    const moving = [...this.rows.entries()].filter(([index]) => index >= at).sort((a, b) => delta > 0 ? b[0] - a[0] : a[0] - b[0]);
    for (const [index, row] of moving) {
      const next = index + delta;
      row.setAttribute("r", String(next));
      for (const cell of children(row, "c")) cell.setAttribute("r", cellName(parseCell(cell.getAttribute("r")!).col, next));
    }
    this.reindex();
    const merged = this.mergeRanges.map(range => {
      const bounds = parseRange(range);
      const move = (value: number) => value >= at ? value + delta : value;
      return rangeName({ ...bounds, top: move(bounds.top), bottom: move(bounds.bottom) });
    });
    this.writeMerges(merged);
    this.refreshDimension();
  }

  refreshDimension() {
    const dimension = firstChild(this.doc.documentElement, "dimension");
    if (!dimension) return;
    const reference = dimension.getAttribute("ref");
    if (!reference) return;
    const bounds = parseRange(reference);
    const lastRow = Math.max(...this.rows.keys(), 1);
    dimension.setAttribute("ref", rangeName({ ...bounds, bottom: Math.max(lastRow, bounds.top) }));
  }

  /** Inserts `count` rows before `at`, copying style and height of `styleRow` (formulas and values are not copied). */
  insertRows(at: number, count: number, styleRow: number) {
    if (count <= 0) return;
    const source = this.row(styleRow);
    this.workbook.shiftReferences(this.name, at, count);
    this.moveRows(at, count);
    const template = source ?? this.row(styleRow >= at ? styleRow + count : styleRow);
    for (let index = at; index < at + count; index++) {
      const row = this.row(index, true)!;
      if (template) {
        for (const attribute of ["ht", "customHeight", "s", "customFormat", "hidden"]) { const value = template.getAttribute(attribute); if (value !== null) row.setAttribute(attribute, value); }
        for (const cell of children(template, "c")) {
          const copy = this.el("c");
          copy.setAttribute("r", cellName(parseCell(cell.getAttribute("r")!).col, index));
          const style = cell.getAttribute("s");
          if (style !== null) copy.setAttribute("s", style);
          row.appendChild(copy);
        }
      }
    }
  }

  /** Removes `count` rows starting at `at` and pulls the rest up. */
  deleteRows(at: number, count: number) {
    if (count <= 0) return;
    const removed = new Set<number>();
    for (let index = at; index < at + count; index++) {
      const row = this.rows.get(index);
      if (row) { this.sheetData.removeChild(row); removed.add(index); }
    }
    this.reindex();
    this.writeMerges(this.mergeRanges.filter(range => { const bounds = parseRange(range); return bounds.bottom < at || bounds.top >= at + count; }));
    this.workbook.shiftReferences(this.name, at, -count);
    this.moveRows(at + count, -count);
  }

  setRowHeight(index: number, height: number) {
    const row = this.row(index, true)!;
    row.setAttribute("ht", String(height));
    row.setAttribute("customHeight", "1");
  }

  /** Column widths in Excel character units, keyed by 1-based column index. */
  columnWidths() {
    const widths = new Map<number, number>();
    const cols = firstChild(this.doc.documentElement, "cols");
    if (cols) for (const col of children(cols, "col")) {
      const width = Number(col.getAttribute("width"));
      if (!Number.isFinite(width)) continue;
      for (let index = Number(col.getAttribute("min")); index <= Math.min(Number(col.getAttribute("max")), 200); index++) widths.set(index, width);
    }
    return widths;
  }

  defaults() {
    const format = firstChild(this.doc.documentElement, "sheetFormatPr");
    return { columnWidth: Number(format?.getAttribute("defaultColWidth")) || 8.43, rowHeight: Number(format?.getAttribute("defaultRowHeight")) || 15 };
  }

  rowHeight(index: number) {
    const height = Number(this.row(index)?.getAttribute("ht"));
    return Number.isFinite(height) && height > 0 ? height : null;
  }

  /** Every `<c>` element with its 1-based position, in reading order. */
  *cells() {
    for (const [index, row] of [...this.rows.entries()].sort((a, b) => a[0] - b[0])) {
      for (const cell of children(row, "c")) yield { row: index, col: parseCell(cell.getAttribute("r")!).col, element: cell, style: Number(cell.getAttribute("s") ?? 0) };
    }
  }

  get pageSetup() { return firstChild(this.doc.documentElement, "pageSetup"); }
  get state() { return this.workbook.sheetState(this.name); }

  setFitToHeight(pages: number) {
    const setup = this.pageSetup;
    if (!setup) throw new Error(`У листа «${this.name}» нет параметров страницы`);
    setup.setAttribute("fitToHeight", String(pages));
  }
}

export class XlsxWorkbook {
  private sheetList: XlsxSheet[] = [];
  private zip: PizZip;
  private workbookDoc: Document;
  private relsDoc: Document;

  private constructor(zip: PizZip, workbookDoc: Document, relsDoc: Document) {
    this.zip = zip;
    this.workbookDoc = workbookDoc;
    this.relsDoc = relsDoc;
  }

  static load(bytes: Uint8Array) {
    const zip = new PizZip(bytes as Buffer);
    const read = (path: string) => { const file = zip.file(path); if (!file) throw new Error(`В XLSX нет части ${path}`); return file.asText(); };
    const workbookDoc = parseXml(read("xl/workbook.xml"));
    const relsDoc = parseXml(read("xl/_rels/workbook.xml.rels"));
    const workbook = new XlsxWorkbook(zip, workbookDoc, relsDoc);
    const strings = zip.file("xl/sharedStrings.xml") ? children(parseXml(read("xl/sharedStrings.xml")).documentElement, "si") : [];
    const targets = new Map(children(relsDoc.documentElement, "Relationship").map(rel => [rel.getAttribute("Id")!, rel.getAttribute("Target")!]));
    const sheets = firstChild(workbookDoc.documentElement, "sheets");
    if (!sheets) throw new Error("В книге нет листов");
    for (const sheet of children(sheets, "sheet")) {
      const target = targets.get(sheet.getAttributeNS(REL_NS, "id") ?? sheet.getAttribute("r:id") ?? "");
      if (!target) throw new Error(`Нет связи для листа ${sheet.getAttribute("name")}`);
      const path = `xl/${target.replace(/^\/?xl\//, "")}`;
      const parsed = new XlsxSheet(workbook, sheet.getAttribute("name")!, path, parseXml(read(path)));
      workbook.sheetList.push(parsed);
    }
    for (const sheet of workbook.sheetList) { workbook.expandSharedFormulas(sheet); workbook.inlineSharedStrings(sheet, strings); }
    // Shared strings are inlined, so the table is emptied: stale sample values must not stay inside the file.
    if (zip.file("xl/sharedStrings.xml")) zip.file("xl/sharedStrings.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>');
    return workbook;
  }

  /** Text of a package part, or null when absent (used by the HTML preview for styles and theme). */
  part(path: string) { return this.zip.file(path)?.asText() ?? null; }
  hasPart(path: string) { return !!this.zip.file(path); }
  partNames() { return Object.keys(this.zip.files); }

  get sheets() { return this.sheetList; }
  sheetNames() { return this.sheetList.map(sheet => sheet.name); }
  sheet(name: string) {
    const found = this.sheetList.find(sheet => sheet.name === name);
    if (!found) throw new Error(`В книге нет листа «${name}»`);
    return found;
  }
  hasSheet(name: string) { return this.sheetList.some(sheet => sheet.name === name); }

  sheetState(name: string) {
    return this.sheetElement(name).getAttribute("state") ?? "visible";
  }

  private sheetElement(name: string) {
    const sheets = firstChild(this.workbookDoc.documentElement, "sheets")!;
    const found = children(sheets, "sheet").find(sheet => sheet.getAttribute("name") === name);
    if (!found) throw new Error(`В книге нет листа «${name}»`);
    return found;
  }

  private expandSharedFormulas(sheet: XlsxSheet) {
    const masters = new Map<string, { formula: string; col: number; row: number }>();
    for (const { f, ref } of sheet.formulaCells()) {
      if (f.getAttribute("t") === "shared" && textOf(f)) { const { col, row } = parseCell(ref); masters.set(f.getAttribute("si")!, { formula: textOf(f), col, row }); }
    }
    for (const { f, ref } of [...sheet.formulaCells()]) {
      if (f.getAttribute("t") !== "shared") continue;
      const master = masters.get(f.getAttribute("si")!);
      if (!master) throw new Error(`Общая формула без источника в ${sheet.name}!${ref}`);
      const { col, row } = parseCell(ref);
      if (!textOf(f)) f.appendChild(sheet.doc.createTextNode(translateFormula(master.formula, row - master.row, col - master.col)));
      for (const attribute of ["t", "ref", "si"]) f.removeAttribute(attribute);
    }
  }

  private inlineSharedStrings(sheet: XlsxSheet, strings: Element[]) {
    for (const row of children(sheet.sheetData, "row")) for (const cell of children(row, "c")) {
      if (cell.getAttribute("t") !== "s") continue;
      const v = firstChild(cell, "v");
      const entry = v ? strings[Number(textOf(v))] : undefined;
      if (v) cell.removeChild(v);
      cell.setAttribute("t", "inlineStr");
      const inline = sheet.doc.createElementNS(MAIN_NS, "is");
      if (entry) for (const node of children(entry)) if (node.localName === "t" || node.localName === "r") inline.appendChild(sheet.doc.importNode(node as never, true) as never);
      cell.appendChild(inline);
    }
  }

  /** Shifts formula references (all sheets) after rows are inserted (delta > 0) or deleted (delta < 0) in `target`. */
  shiftReferences(target: string, at: number, delta: number) {
    for (const sheet of this.sheetList) for (const { f } of sheet.formulaCells()) {
      f.textContent = shiftFormulaRows(textOf(f), sheet.name, target, at, delta);
    }
  }

  /** Evaluates every formula and stores the result as the cached value. */
  recalculate() {
    const cache = new Map<string, Scalar>();
    const active = new Set<string>();
    const resolve = (sheetName: string, col: number, row: number): Scalar => {
      const key = `${sheetName}!${col}:${row}`;
      if (cache.has(key)) return cache.get(key)!;
      if (!this.hasSheet(sheetName)) throw new FormulaError(`Нет листа ${sheetName}`);
      const sheet = this.sheet(sheetName);
      const ref = cellName(col, row);
      const formula = sheet.formula(ref);
      let value: Scalar;
      if (formula === null) { const raw = sheet.raw(ref); value = raw === undefined ? null : raw; }
      else {
        if (active.has(key)) throw new FormulaError(`Циклическая ссылка ${sheetName}!${ref}`);
        active.add(key);
        try {
          const result = evaluateFormula(formula, sheetName, { cell: resolve });
          value = result === null ? 0 : result;
        } catch (error) {
          if (error instanceof FormulaError && /^#/.test(error.message)) value = error.message;
          else throw error;
        } finally { active.delete(key); }
      }
      cache.set(key, value);
      return value;
    };
    for (const sheet of this.sheetList) for (const { cell, f, ref } of [...sheet.formulaCells()]) {
      for (const child of children(cell)) if (child !== f) cell.removeChild(child);
      cell.removeAttribute("t");
      const { col, row } = parseCell(ref);
      const value = resolve(sheet.name, col, row);
      const v = sheet.doc.createElementNS(MAIN_NS, "v");
      if (typeof value === "number") v.appendChild(sheet.doc.createTextNode(formatNumber(value)));
      else if (typeof value === "boolean") { cell.setAttribute("t", "b"); v.appendChild(sheet.doc.createTextNode(value ? "1" : "0")); }
      else if (typeof value === "string" && /^#[A-Z/0!?]+$/.test(value)) { cell.setAttribute("t", "e"); v.appendChild(sheet.doc.createTextNode(value)); }
      else { cell.setAttribute("t", "str"); v.appendChild(sheet.doc.createTextNode(value === null ? "" : String(value))); }
      cell.appendChild(v);
    }
    const root = this.workbookDoc.documentElement;
    let calc = firstChild(root, "calcPr");
    if (!calc) {
      calc = this.workbookDoc.createElementNS(MAIN_NS, "calcPr");
      const before = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"].map(name => firstChild(root, name)).find(Boolean);
      root.insertBefore(calc, before ?? null);
    }
    calc.setAttribute("fullCalcOnLoad", "1");
  }

  /** Replaces formulas of one sheet by their current values (used before detaching the sheet from the book). */
  freezeFormulas(sheetName: string) {
    this.recalculate();
    const sheet = this.sheet(sheetName);
    for (const { cell, f } of [...sheet.formulaCells()]) cell.removeChild(f);
  }

  /** Drops the hidden/visible sheet and every part that only it used. */
  removeSheet(name: string) {
    const sheet = this.sheet(name);
    const index = this.sheetList.indexOf(sheet);
    const sheetsElement = firstChild(this.workbookDoc.documentElement, "sheets")!;
    const element = this.sheetElement(name);
    const relId = element.getAttributeNS(REL_NS, "id") ?? element.getAttribute("r:id");
    sheetsElement.removeChild(element);
    this.sheetList.splice(index, 1);
    const relation = children(this.relsDoc.documentElement, "Relationship").find(rel => rel.getAttribute("Id") === relId);
    if (relation) this.relsDoc.documentElement.removeChild(relation);
    this.dropPart(sheet.path);
    const relsPath = `${sheet.path.replace(/[^/]+$/, "_rels/")}${sheet.path.split("/").pop()}.rels`;
    const relsFile = this.zip.file(relsPath);
    if (relsFile) {
      for (const rel of children(parseXml(relsFile.asText()).documentElement, "Relationship")) {
        const target = rel.getAttribute("Target") ?? "";
        if (!/^(https?:)/.test(target)) this.dropPart(this.resolvePath(sheet.path, target));
      }
      this.dropPart(relsPath);
    }
    // definedNames use positional localSheetId: remove names of the dropped sheet and renumber the rest.
    const names = firstChild(this.workbookDoc.documentElement, "definedNames");
    if (names) {
      for (const item of children(names, "definedName")) {
        const local = item.getAttribute("localSheetId");
        if (local === null) continue;
        if (Number(local) === index) names.removeChild(item);
        else if (Number(local) > index) item.setAttribute("localSheetId", String(Number(local) - 1));
      }
      if (!children(names).length) this.workbookDoc.documentElement.removeChild(names);
    }
    this.normalizeViews();
  }

  private resolvePath(from: string, target: string) {
    if (target.startsWith("/")) return target.slice(1);
    const parts = from.split("/").slice(0, -1);
    for (const part of target.split("/")) { if (part === "..") parts.pop(); else if (part !== ".") parts.push(part); }
    return parts.join("/");
  }

  private dropPart(path: string) {
    if (!this.zip.file(path)) return;
    this.zip.remove(path);
    const typesFile = this.zip.file("[Content_Types].xml");
    if (typesFile) {
      const types = parseXml(typesFile.asText());
      for (const override of children(types.documentElement, "Override")) if (override.getAttribute("PartName") === `/${path}`) types.documentElement.removeChild(override);
      this.zip.file("[Content_Types].xml", serialize(types));
    }
  }

  /** Makes the first visible sheet the active one after sheets were removed. */
  private normalizeViews() {
    const root = this.workbookDoc.documentElement;
    const views = firstChild(root, "bookViews");
    const first = Math.max(0, this.sheetList.findIndex(sheet => this.sheetState(sheet.name) === "visible"));
    if (views) for (const view of children(views, "workbookView")) { view.setAttribute("activeTab", String(first)); view.setAttribute("firstSheet", "0"); }
    this.sheetList.forEach((sheet, index) => {
      const sheetViews = firstChild(sheet.doc.documentElement, "sheetViews");
      if (sheetViews) for (const view of children(sheetViews, "sheetView")) { if (index === first) view.setAttribute("tabSelected", "1"); else view.removeAttribute("tabSelected"); }
    });
  }

  setPrintTitleRows(sheetName: string, from: number, to: number) {
    const root = this.workbookDoc.documentElement;
    const index = this.sheetList.findIndex(sheet => sheet.name === sheetName);
    if (index < 0) throw new Error(`В книге нет листа «${sheetName}»`);
    let names = firstChild(root, "definedNames");
    if (!names) {
      names = this.workbookDoc.createElementNS(MAIN_NS, "definedNames");
      root.insertBefore(names, firstChild(root, "calcPr") ?? null);
    }
    for (const item of children(names, "definedName")) if (item.getAttribute("name") === "_xlnm.Print_Titles" && item.getAttribute("localSheetId") === String(index)) names.removeChild(item);
    const item = this.workbookDoc.createElementNS(MAIN_NS, "definedName");
    item.setAttribute("name", "_xlnm.Print_Titles");
    item.setAttribute("localSheetId", String(index));
    item.appendChild(this.workbookDoc.createTextNode(`'${sheetName.replace(/'/g, "''")}'!$${from}:$${to}`));
    names.appendChild(item);
  }

  /** Output-only housekeeping: drop calcChain (stale after edits), the author's local path and extended properties that list sheet names. */
  private sanitizePackage() {
    const root = this.workbookDoc.documentElement;
    for (const node of Array.from(root.childNodes as unknown as ArrayLike<Node>)) {
      if (node.nodeType === 1 && (node as Element).localName === "AlternateContent") root.removeChild(node);
    }
    const relation = (type: RegExp) => children(this.relsDoc.documentElement, "Relationship").find(rel => type.test(rel.getAttribute("Type") ?? ""));
    const calc = relation(/\/calcChain$/);
    if (calc) { this.relsDoc.documentElement.removeChild(calc); }
    this.dropPart("xl/calcChain.xml");
    const rootRels = this.zip.file("_rels/.rels");
    if (rootRels && this.zip.file("docProps/app.xml")) {
      const doc = parseXml(rootRels.asText());
      for (const rel of children(doc.documentElement, "Relationship")) if (/extended-properties$/.test(rel.getAttribute("Type") ?? "")) doc.documentElement.removeChild(rel);
      this.zip.file("_rels/.rels", serialize(doc));
      this.dropPart("docProps/app.xml");
    }
    if (this.zip.file("docProps/core.xml")) {
      // Authorship of the sample must not leak into generated documents.
      this.zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Nexus ARSEO</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`);
    }
  }

  toBytes(options: { recalculate?: boolean } = {}) {
    if (options.recalculate !== false) this.recalculate();
    this.sanitizePackage();
    this.zip.file("xl/workbook.xml", serialize(this.workbookDoc));
    this.zip.file("xl/_rels/workbook.xml.rels", serialize(this.relsDoc));
    for (const sheet of this.sheetList) this.zip.file(sheet.path, serialize(sheet.doc));
    return new Uint8Array(this.zip.generate({ type: "uint8array", compression: "DEFLATE" }));
  }
}
