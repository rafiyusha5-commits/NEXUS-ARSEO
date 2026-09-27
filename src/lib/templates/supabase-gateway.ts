import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DOCUMENT_BUCKET } from "../documents/files.ts";
import { loadPermissions } from "../permissions.ts";
import type { TemplateGateway, TemplatePermissions } from "./operations.ts";

export const TEMPLATE_PERMISSION_CODES = [
  "templates.view",
  "templates.create",
  "templates.update",
  "templates.upload",
  "templates.archive",
  "templates.approve",
  "templates.change_status",
  "templates.export",
] as const;

export async function loadTemplatePermissions(supabase: SupabaseClient): Promise<TemplatePermissions> {
  const flags = await loadPermissions(supabase, TEMPLATE_PERMISSION_CODES);
  return {
    view: flags["templates.view"],
    create: flags["templates.create"],
    update: flags["templates.update"],
    upload: flags["templates.upload"],
    archive: flags["templates.archive"],
    approve: flags["templates.approve"],
    change_status: flags["templates.change_status"],
    export: flags["templates.export"],
  };
}

// Uses the signed-in user's session only; RLS, triggers and Storage policies decide.
export function createTemplateGateway(supabase: SupabaseClient, userId: string): TemplateGateway {
  let cached: TemplatePermissions | null = null;
  const storage = () => supabase.storage.from(DOCUMENT_BUCKET);

  return {
    async permissions() {
      cached ??= await loadTemplatePermissions(supabase);
      return cached;
    },

    async getTemplateState(templateId) {
      const [{ data: template }, { data: versions }] = await Promise.all([
        supabase.from("document_templates").select("id, archived_at").eq("id", templateId).maybeSingle(),
        supabase.from("document_template_versions").select("checksum_sha256").eq("template_id", templateId),
      ]);
      if (!template) return null;
      return {
        archived: template.archived_at !== null,
        checksums: (versions ?? []).map((version) => version.checksum_sha256 as string).filter(Boolean),
      };
    },

    async uploadFile(path, bytes, contentType) {
      const { error } = await storage().upload(path, bytes, { contentType, upsert: false, cacheControl: "0" });
      if (!error) return null;
      const details = error as { message: string; statusCode?: string | number; status?: number };
      return { message: details.message, statusCode: details.statusCode ?? details.status ?? null };
    },

    async removeFile(path) {
      await storage().remove([path]);
    },

    async registerTemplate(input) {
      const { error } = await supabase.rpc("register_document_template", {
        p_template_id: input.template_id,
        p_document_type_id: input.document_type_id,
        p_name: input.name,
        p_language: input.language,
        p_storage_path: input.storage_path,
        p_original_filename: input.original_filename,
        p_purpose: input.purpose,
        p_counterparty_id: input.counterparty_id,
        p_variables_schema: input.variables_schema,
        p_checksum_sha256: input.checksum_sha256,
      });
      return error?.message ?? null;
    },

    async insertVersion(input) {
      const { error } = await supabase.from("document_template_versions").insert(input);
      return error?.message ?? null;
    },

    async getVersionFile(templateId, versionId) {
      let query = supabase
        .from("document_template_versions")
        .select("storage_path, original_filename, version_number")
        .eq("template_id", templateId);
      query = versionId ? query.eq("id", versionId) : query.eq("is_current", true);
      const { data } = await query.maybeSingle();
      if (!data) return null;
      return { path: data.storage_path as string, filename: data.original_filename as string, versionNumber: data.version_number as number };
    },

    async createSignedUrl(path, expiresInSeconds, downloadName) {
      const { data, error } = await storage().createSignedUrl(path, expiresInSeconds, { download: downloadName });
      return error || !data?.signedUrl ? null : data.signedUrl;
    },

    async recordDownload(templateId, versionNumber) {
      await supabase.from("audit_log").insert({
        actor_user_id: userId,
        action: "download",
        entity_type: "document_templates",
        entity_id: templateId,
        metadata: { source: "ui", version: versionNumber },
      });
    },
  };
}
