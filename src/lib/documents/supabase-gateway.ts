import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DOCUMENT_BUCKET } from "./files.ts";
import type { DocumentGateway, DocumentPermissions } from "./operations.ts";

const NO_PERMISSIONS: DocumentPermissions = {
  view: false,
  create: false,
  update: false,
  approve: false,
  archive: false,
  manage_types: false,
  manage_requirements: false,
  share_external: false,
};

// Uses the signed-in user's session only: every call is checked by RLS and Storage
// policies. No service-role or secret key is used for documents.
export async function loadDocumentPermissions(supabase: SupabaseClient): Promise<DocumentPermissions> {
  const { data, error } = await supabase.rpc("my_document_permissions");
  if (error || !data || typeof data !== "object") return NO_PERMISSIONS;
  const flags = data as Record<string, unknown>;
  return {
    view: flags.view === true,
    create: flags.create === true,
    update: flags.update === true,
    approve: flags.approve === true,
    archive: flags.archive === true,
    manage_types: flags.manage_types === true,
    manage_requirements: flags.manage_requirements === true,
    share_external: flags.share_external === true,
  };
}

export function createDocumentGateway(supabase: SupabaseClient, userId: string): DocumentGateway {
  let cachedPermissions: DocumentPermissions | null = null;
  const storage = () => supabase.storage.from(DOCUMENT_BUCKET);

  return {
    async permissions() {
      cachedPermissions ??= await loadDocumentPermissions(supabase);
      return cachedPermissions;
    },

    async findDocumentWithChecksum(checksum) {
      const { data } = await supabase
        .from("document_versions")
        .select("document_id, document:documents(title)")
        .eq("checksum_sha256", checksum)
        .limit(1)
        .maybeSingle();
      if (!data) return null;
      const document = Array.isArray(data.document) ? data.document[0] : data.document;
      return { id: data.document_id as string, title: (document as { title?: string } | null)?.title ?? "документ" };
    },

    async getDocumentState(documentId) {
      const [{ data: document }, { data: versions }] = await Promise.all([
        supabase.from("documents").select("id, archived_at").eq("id", documentId).maybeSingle(),
        supabase.from("document_versions").select("checksum_sha256").eq("document_id", documentId),
      ]);
      if (!document) return null;
      return {
        archived: document.archived_at !== null,
        checksums: (versions ?? []).map((version) => version.checksum_sha256 as string).filter(Boolean),
      };
    },

    async uploadFile(path, bytes, contentType) {
      const { error } = await storage().upload(path, bytes, {
        contentType,
        upsert: false,
        cacheControl: "0",
      });
      if (!error) return null;
      const details = error as { message: string; statusCode?: string | number; status?: number };
      return { message: details.message, statusCode: details.statusCode ?? details.status ?? null };
    },

    async removeFile(path) {
      await storage().remove([path]);
    },

    async registerDocument(input) {
      const { error } = await supabase.rpc("register_document", {
        p_document_id: input.document_id,
        p_document_type_id: input.document_type_id,
        p_title: input.title,
        p_storage_path: input.storage_path,
        p_original_filename: input.original_filename,
        p_document_number: input.document_number,
        p_description: input.description,
        p_document_date: input.document_date,
        p_valid_until: input.valid_until,
        p_language: input.language,
        p_currency_id: input.currency_id,
        p_amount: input.amount,
        p_checksum_sha256: input.checksum_sha256,
        p_links: input.links,
      });
      return error?.message ?? null;
    },

    async insertVersion(input) {
      const { error } = await supabase.from("document_versions").insert(input);
      return error?.message ?? null;
    },

    async archiveDocument(documentId, reason) {
      const { error } = await supabase.rpc("archive_document", {
        p_document_id: documentId,
        p_reason: reason,
      });
      return error?.message ?? null;
    },

    async getVersionFile(documentId, versionId) {
      let query = supabase
        .from("document_versions")
        .select("storage_path, original_filename, version_number")
        .eq("document_id", documentId);
      query = versionId ? query.eq("id", versionId) : query.eq("is_current", true);
      const { data } = await query.maybeSingle();
      if (!data) return null;
      return {
        path: data.storage_path as string,
        filename: data.original_filename as string,
        versionNumber: data.version_number as number,
      };
    },

    async createSignedUrl(path, expiresInSeconds, downloadName) {
      const { data, error } = await storage().createSignedUrl(path, expiresInSeconds, {
        download: downloadName,
      });
      return error || !data?.signedUrl ? null : data.signedUrl;
    },

    async recordDownload(documentId, versionNumber) {
      await supabase.from("audit_log").insert({
        actor_user_id: userId,
        action: "download",
        entity_type: "documents",
        entity_id: documentId,
        metadata: { source: "ui", version: versionNumber },
      });
    },
  };
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomHex() {
  return crypto.randomUUID().replace(/-/g, "");
}
