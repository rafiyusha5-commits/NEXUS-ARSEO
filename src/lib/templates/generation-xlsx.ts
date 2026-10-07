import "server-only";
import { buildExportDocuments, XLSX_CONTENT_TYPE } from "../export-workbook/index.ts";

export const XLSX_MIME = XLSX_CONTENT_TYPE;

/** Fills the reference export workbook from the shipment data (the template bytes are never modified). */
export function renderShipmentWorkbookTemplate(template: Uint8Array, data: Record<string, unknown>) {
  return buildExportDocuments(template, data, ["workbook"])[0].bytes;
}
