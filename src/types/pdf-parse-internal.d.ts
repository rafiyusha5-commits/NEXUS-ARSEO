declare module "pdf-parse/lib/pdf-parse.js" {
  type PdfParseResult = { text?: string };
  type PdfParse = (input: Buffer) => Promise<PdfParseResult>;

  const parse: PdfParse;
  export default parse;
}
