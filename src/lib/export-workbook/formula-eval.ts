// Minimal Excel formula evaluator for the export workbook. It exists so that generated files carry
// computed values (viewers that never recalculate, and single-sheet copies whose cross-sheet
// formulas are frozen into values). Unsupported syntax throws instead of guessing.

import { colToNumber } from "./refs.ts";

export type Scalar = string | number | boolean | null;
export type FormulaResolver = {
  cell(sheet: string, col: number, row: number): Scalar;
};

export class FormulaError extends Error {}

type Node =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ref"; sheet: string | null; col: number; row: number }
  | { kind: "range"; sheet: string | null; left: number; top: number; right: number; bottom: number }
  | { kind: "unary"; op: "-" | "+"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

type Token = { type: "number" | "string" | "ref" | "ident" | "op" | "punct"; text: string };

const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[^\s'!,;:()+\-*/^&=<>"]+)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)(?![A-Za-z0-9_(])|([A-Za-z_Ѐ-ӿ][A-Za-z0-9_.Ѐ-ӿ]*)(?=\()|(<=|>=|<>|[-+*/^&=<>])|([(),;]))/y;

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < formula.length) {
    if (/^\s*$/.test(formula.slice(TOKEN.lastIndex))) break;
    const match = TOKEN.exec(formula);
    if (!match) throw new FormulaError(`Не удалось разобрать формулу: ${formula}`);
    if (match[1] !== undefined) tokens.push({ type: "number", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: "string", text: match[2].slice(1, -1).replace(/""/g, '"') });
    else if (match[4] !== undefined) tokens.push({ type: "ref", text: `${match[3] ?? ""}${match[4]}` });
    else if (match[5] !== undefined) tokens.push({ type: "ident", text: match[5].toUpperCase() });
    else if (match[6] !== undefined) tokens.push({ type: "op", text: match[6] });
    else if (match[7] !== undefined) tokens.push({ type: "punct", text: match[7] });
  }
  return tokens;
}

function parseReference(text: string): Node {
  const bang = text.lastIndexOf("!");
  let sheet: string | null = null;
  let body = text;
  if (bang >= 0) {
    sheet = text.slice(0, bang);
    body = text.slice(bang + 1);
    if (sheet.startsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  const parts = body.replace(/\$/g, "").split(":");
  const cell = (value: string) => {
    const match = /^([A-Z]{1,3})(\d+)$/.exec(value);
    if (!match) throw new FormulaError(`Некорректная ссылка ${text}`);
    return { col: colToNumber(match[1]), row: Number(match[2]) };
  };
  const a = cell(parts[0]);
  if (parts.length === 1) return { kind: "ref", sheet, col: a.col, row: a.row };
  const b = cell(parts[1]);
  return { kind: "range", sheet, left: Math.min(a.col, b.col), top: Math.min(a.row, b.row), right: Math.max(a.col, b.col), bottom: Math.max(a.row, b.row) };
}

function parse(formula: string): Node {
  const tokens = tokenize(formula);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const isOp = (...ops: string[]) => peek()?.type === "op" && ops.includes(peek().text);

  const primary = (): Node => {
    const token = take();
    if (!token) throw new FormulaError(`Неожиданный конец формулы: ${formula}`);
    if (token.type === "number") return { kind: "number", value: Number(token.text) };
    if (token.type === "string") return { kind: "string", value: token.text };
    if (token.type === "ref") return parseReference(token.text);
    if (token.type === "ident") {
      const open = take();
      if (open?.text !== "(") throw new FormulaError(`Ожидалась скобка после ${token.text}`);
      const args: Node[] = [];
      if (peek()?.text !== ")") {
        for (;;) {
          args.push(comparison());
          if (peek()?.text === "," || peek()?.text === ";") { take(); continue; }
          break;
        }
      }
      if (take()?.text !== ")") throw new FormulaError(`Не закрыта скобка в ${formula}`);
      return { kind: "call", name: token.text, args };
    }
    if (token.text === "(") {
      const inner = comparison();
      if (take()?.text !== ")") throw new FormulaError(`Не закрыта скобка в ${formula}`);
      return inner;
    }
    throw new FormulaError(`Неожиданный элемент «${token.text}» в ${formula}`);
  };
  const unary = (): Node => {
    if (isOp("-", "+")) { const op = take().text as "-" | "+"; return { kind: "unary", op, operand: unary() }; }
    return primary();
  };
  const level = (next: () => Node, ...ops: string[]) => (): Node => {
    let left = next();
    while (isOp(...ops)) { const op = take().text; left = { kind: "binary", op, left, right: next() }; }
    return left;
  };
  const multiplicative = level(unary, "*", "/");
  const additive = level(multiplicative, "+", "-");
  const concat = level(additive, "&");
  const comparison = level(concat, "=", "<>", "<", ">", "<=", ">=");
  const result = comparison();
  if (position < tokens.length) throw new FormulaError(`Лишние символы в формуле: ${formula}`);
  return result;
}

const toNumber = (value: Scalar): number => {
  if (value === null || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(parsed)) throw new FormulaError("#VALUE!");
  return parsed;
};

export const formatNumber = (value: number) => {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(15)));
};

const toText = (value: Scalar): string => {
  if (value === null) return "";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value;
};

const truthy = (value: Scalar) => typeof value === "string" ? value !== "" : Boolean(toNumber(value));

export function evaluateFormula(formula: string, ownerSheet: string, resolver: FormulaResolver): Scalar {
  const tree = parse(formula.replace(/^=/, ""));
  const sheetOf = (sheet: string | null) => sheet ?? ownerSheet;

  const flatten = (node: Node): Scalar[] => {
    if (node.kind === "range") {
      const values: Scalar[] = [];
      for (let row = node.top; row <= node.bottom; row++) for (let col = node.left; col <= node.right; col++) values.push(resolver.cell(sheetOf(node.sheet), col, row));
      return values;
    }
    return [evaluate(node)];
  };

  function evaluate(node: Node): Scalar {
    switch (node.kind) {
      case "number": return node.value;
      case "string": return node.value;
      case "ref": return resolver.cell(sheetOf(node.sheet), node.col, node.row);
      case "range": throw new FormulaError("Диапазон вне функции");
      case "unary": return node.op === "-" ? -toNumber(evaluate(node.operand)) : toNumber(evaluate(node.operand));
      case "binary": {
        const left = evaluate(node.left), right = evaluate(node.right);
        switch (node.op) {
          case "+": return toNumber(left) + toNumber(right);
          case "-": return toNumber(left) - toNumber(right);
          case "*": return toNumber(left) * toNumber(right);
          case "/": { const divisor = toNumber(right); if (divisor === 0) throw new FormulaError("#DIV/0!"); return toNumber(left) / divisor; }
          case "&": return toText(left) + toText(right);
          default: {
            const comparable = typeof left === "string" || typeof right === "string" ? [toText(left), toText(right)] as const : [toNumber(left), toNumber(right)] as const;
            const [a, b] = comparable;
            switch (node.op) {
              case "=": return a === b;
              case "<>": return a !== b;
              case "<": return a < b;
              case ">": return a > b;
              case "<=": return a <= b;
              default: return a >= b;
            }
          }
        }
      }
      case "call": {
        switch (node.name) {
          // Like Excel, SUM adds numbers only; text and blanks inside ranges are ignored.
          case "SUM": return node.args.flatMap(flatten).reduce<number>((sum, value) => typeof value === "number" ? sum + value : sum, 0);
          case "IF": {
            if (node.args.length < 2) throw new FormulaError("IF требует минимум два аргумента");
            return truthy(evaluate(node.args[0])) ? evaluate(node.args[1]) : node.args[2] ? evaluate(node.args[2]) : false;
          }
          case "CONCATENATE": return node.args.flatMap(flatten).map(toText).join("");
          case "ROUND": {
            const digits = node.args[1] ? toNumber(evaluate(node.args[1])) : 0;
            const factor = 10 ** digits;
            return Math.round((toNumber(evaluate(node.args[0])) + Number.EPSILON) * factor) / factor;
          }
          default: throw new FormulaError(`Функция ${node.name} не поддерживается`);
        }
      }
    }
  }
  return evaluate(tree);
}
