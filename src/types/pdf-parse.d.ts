declare module "pdf-parse" {
  export type PdfParseResult = { text?: string; numpages?: number; info?: Record<string, unknown> };
  export default function parse(input: Buffer): Promise<PdfParseResult>;
}
