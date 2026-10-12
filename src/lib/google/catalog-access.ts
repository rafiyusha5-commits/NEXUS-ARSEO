import type { SupabaseClient } from "@supabase/supabase-js";
import { DRIVE_ID, DRIVE_PERMISSIONS, driveTerms, type DriveFile, type DriveReadonly } from "./drive-readonly.ts";
import type { AgentDataSource } from "../agent/types.ts";

const BASE = ["agent.use", ...DRIVE_PERMISSIONS];
const TEXT = ["prices.purchase.view", "documents.drive.text.view"];
const unavailable = () => new Error("CATALOG_UNAVAILABLE");
const sameVersion = (a?: string, b?: string) => !!a && !!b && Date.parse(a) === Date.parse(b);

/** Internal DAL. The injected catalog client must carry BOTH the server gateway
 * credential and the employee JWT. Results leave this layer only after live checks.
 */
export function createCatalogAccess(session: SupabaseClient, gateway: () => Promise<SupabaseClient>, drive: Pick<DriveReadonly, "catalogReference" | "file" | "search" | "download">) {
  async function grants(codes: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await session.rpc("my_permissions", { p_codes: codes }).abortSignal(signal);
    if (result.error || !Array.isArray(result.data)) throw unavailable();
    return new Set<string>(result.data);
  }
  async function requireAccess(codes: string[], signal: AbortSignal) {
    const held = await grants(codes, signal);
    if (!codes.every(code => held.has(code))) throw unavailable();
  }
  async function current(file: DriveFile, signal: AbortSignal) {
    try {
      const latest = file.ancestors
        ? await drive.catalogReference(file.id, file.ancestors, signal)
        : await drive.file(file.id, signal);
      return !file.modifiedTime || sameVersion(latest.modifiedTime, file.modifiedTime);
    } catch { signal.throwIfAborted(); return false; }
  }
  const findDriveDocuments: NonNullable<AgentDataSource["findDriveDocuments"]> = async (query, offset, signal) => {
    if (!query.trim() || query.length > 120 || !Number.isInteger(offset) || offset < 0 || offset > 1000) throw unavailable();
    await requireAccess(BASE, signal);
    let requiredPermissions: string[] = [];
    const db = await gateway();
    const visible: DriveFile[] = [];
    let complete = false;
    for (let page = 0; page < 1000; page += 20) {
      const result = await db.rpc("search_drive_catalog", { p_query: driveTerms(query).join(" "), p_offset: page }).abortSignal(signal);
      // Never downgrade on missing migrations, invalid gateway credentials, or DB failure.
      if (result.error || !Array.isArray(result.data?.files) || typeof result.data.textSearch !== "boolean") throw unavailable();
      if (result.data.textSearch) requiredPermissions = TEXT;
      if (!result.data.ready) {
        const live = await drive.search(query, signal, offset);
        const files: DriveFile[] = [];
        for (const file of live.files) if (await current(file, signal)) files.push(file);
        await requireAccess(BASE, signal);
        return { files, total: null, truncated: live.truncated };
      }
      for (const file of result.data.files as DriveFile[]) if (await current(file, signal)) visible.push(file);
      if (!result.data.truncated) { complete = true; break; }
      if (visible.length > offset + 20) break;
    }
    // Revalidate the actual outgoing page after the possibly long scan.
    const files: DriveFile[] = [];
    let changed = false;
    for (const file of visible.slice(offset, offset + 20)) {
      if (await current(file, signal)) files.push(file); else changed = true;
    }
    await requireAccess([...BASE, ...requiredPermissions], signal);
    // Do not leak counts of unverified/removed matches through pagination.
    return { files, total: complete && !changed ? visible.length : null,
      truncated: !complete || visible.length > offset + 20, requiredPermissions };
  };
  const getDriveDocument: NonNullable<AgentDataSource["getDriveDocument"]> = async (id, signal) => {
    if (!DRIVE_ID.test(id)) return null;
    await requireAccess([...BASE, ...TEXT], signal);
    const db = await gateway();
    const result = await db.from("drive_catalog_files").select("file_id,name,folder_path,mime_type,ancestor_ids,source_modified_at,content_status,text_indexed_at,text_method,ocr_confidence,ocr_pages,ocr_error").eq("file_id", id).abortSignal(signal).maybeSingle();
    if (result.error) throw unavailable();
    const row = result.data;
    if (!row) return null;
    const file: DriveFile = { id, name: row.name, path: row.folder_path, mimeType: row.mime_type, ancestors: row.ancestor_ids,
      modifiedTime: row.source_modified_at, contentStatus: row.content_status, indexedAt: row.text_indexed_at,
      textMethod: row.text_method, ocrConfidence: row.ocr_confidence, ocrPages: row.ocr_pages, ocrError: row.ocr_error };
    if (!await current(file, signal)) return null;
    const text = await db.from("drive_catalog_text").select("body,truncated,source_modified_at").eq("file_id", id).abortSignal(signal).maybeSingle();
    if (text.error) throw unavailable();
    if (text.data && !sameVersion(text.data.source_modified_at, file.modifiedTime)) return null;
    if (!await current(file, signal)) return null;
    await requireAccess([...BASE, ...TEXT], signal);
    return { file, text: text.data?.body ?? null, truncated: text.data?.truncated ?? false };
  };
  const downloadDriveFile: NonNullable<AgentDataSource["downloadDriveFile"]> = async (id, signal) => {
    if (!DRIVE_ID.test(id)) throw unavailable();
    await requireAccess(BASE, signal);
    const db = await gateway();
    const record = await db.from("drive_catalog_files").select("ancestor_ids").eq("file_id", id).abortSignal(signal).maybeSingle();
    if (record.error) throw unavailable();
    if (record.data) await drive.catalogReference(id, record.data.ancestor_ids, signal);
    const result = await drive.download(id, signal);
    await requireAccess(BASE, signal);
    return result;
  };
  async function verifyDriveAccess(record: { section: string; ids: string[]; versions?: Record<string, string> }, signal: AbortSignal) {
    try {
      const codes = [...BASE, ...(record.section === "drive_text" ? TEXT : [])];
      await requireAccess(codes, signal);
      const db = await gateway();
      for (const id of record.ids) {
        if (!DRIVE_ID.test(id)) return false;
        const result = await db.from("drive_catalog_files").select("ancestor_ids,source_modified_at").eq("file_id", id).abortSignal(signal).maybeSingle();
        if (result.error) return false;
        const version = record.versions?.[id];
        if (record.section === "drive_text" && (!result.data || !version)) return false;
        if (result.data) {
          const live = await drive.catalogReference(id, result.data.ancestor_ids, signal);
          if (version && (!sameVersion(live.modifiedTime, version) || !sameVersion(result.data.source_modified_at, version))) return false;
        } else {
          const live = await drive.file(id, signal);
          if (version && !sameVersion(live.modifiedTime, version)) return false;
        }
      }
      await requireAccess(codes, signal);
      return true;
    } catch { return false; }
  }
  return { findDriveDocuments, getDriveDocument, downloadDriveFile, verifyDriveAccess };
}
