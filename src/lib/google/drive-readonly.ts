// Fixed approved source. No arbitrary URLs, global searches, shortcuts or Drive write methods.
export const DRIVE_ROOT = "1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DRIVE_PERMISSIONS = ["documents.view", "documents.drive.view"] as const;
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,120}$/;
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const MAX_BYTES = 15 * 1024 * 1024;
export type DriveFile = { id: string; name: string; mimeType: string; path: string; size?: string; parents?: string[]; modifiedTime?: string; ancestors?: string[]; indexedAt?: string; contentStatus?: string; textMethod?: "text_layer" | "ocr" | null; ocrConfidence?: number | null; ocrPages?: number | null; ocrError?: string | null };
export type DriveFolder = { id: string; path: string; depth: number; ancestors: string[]; page?: string };
export class DriveReadError extends Error { constructor() { super("DRIVE_READ_UNAVAILABLE"); } }
export function safeFilename(name: string) { return name.replace(/[\x00-\x1f\x7f/\\"<>:|?*]/g, "_").slice(0, 160) || "document"; }
export function driveTerms(query: string): string[] {
  return query.toLowerCase().normalize("NFKC").replace(/belgain/g, "belgian")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).filter(word => !["найди", "найти", "покажи", "пришли", "документ", "документы", "соответствия", "мне", "для"].includes(word))
    .map(word => /^(декларац|declaration)/.test(word) ? "дс" : word);
}
export class DriveReadonly {
  private knownFiles = new Set<string>();
  private knownFolders = new Set<string>([DRIVE_ROOT]);
  private token: (signal: AbortSignal) => Promise<string>;
  private fetcher: typeof fetch;
  constructor(token: (signal: AbortSignal) => Promise<string>, fetcher: typeof fetch = fetch) { this.token = token; this.fetcher = fetcher; }
  private async get(path: string, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const response = await this.fetcher(`https://www.googleapis.com/drive/v3/${path}`, {
      method: "GET", redirect: "error", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${await this.token(signal)}` },
    });
    if (!response.ok) throw new DriveReadError();
    return response;
  }
  private async json(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.get(path, signal);
    const bytes = await this.boundedBytes(response, 2 * 1024 * 1024);
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DriveReadError();
    return data as Record<string, unknown>;
  }
  private async metadata(id: string, signal: AbortSignal): Promise<DriveFile> {
    if (!DRIVE_ID.test(id)) throw new DriveReadError();
    const data = await this.json(`files/${id}?supportsAllDrives=true&fields=id,name,mimeType,size,parents,trashed,modifiedTime`, signal);
    if (data.trashed === true || data.id !== id || typeof data.name !== "string" || typeof data.mimeType !== "string") throw new DriveReadError();
    return { ...data, path: "" } as DriveFile;
  }
  /** References come only from the server-side catalog discovered below the approved root. */
  async catalogReference(id: string, ancestors: string[], signal: AbortSignal): Promise<DriveFile> {
    if (!DRIVE_ID.test(id) || ancestors.length > 16 || (id !== DRIVE_ROOT && ancestors.at(-1) !== DRIVE_ROOT) || !ancestors.every(parent => DRIVE_ID.test(parent)) || new Set([id,...ancestors]).size !== ancestors.length + 1) throw new DriveReadError();
    const chain = [id,...ancestors]; let file: DriveFile | undefined;
    for (let index = chain.length - 1; index >= 0; index--) {
      const current = await this.metadata(chain[index], signal);
      if (index < chain.length - 1 && (current.parents?.length !== 1 || current.parents[0] !== chain[index + 1])) throw new DriveReadError();
      if (index > 0 || id === DRIVE_ROOT) { if (current.mimeType !== FOLDER) throw new DriveReadError(); this.knownFolders.add(current.id); }
      else file = current;
    }
    if (id === DRIVE_ROOT) return this.metadata(id,signal);
    if (!file || file.mimeType === SHORTCUT) throw new DriveReadError();
    if (file.mimeType === FOLDER) this.knownFolders.add(id); else this.knownFiles.add(id);
    return file;
  }
  async catalogPage(folder: DriveFolder, signal: AbortSignal): Promise<{ files: DriveFile[]; nextPage: string }> {
    const current = await this.catalogReference(folder.id, folder.ancestors, signal);
    if (current.mimeType !== FOLDER || folder.depth > 15) throw new DriveReadError();
    const params = new URLSearchParams({ q: `'${folder.id}' in parents and trashed=false`, pageSize: "100", orderBy: "name", fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (folder.page) params.set("pageToken",folder.page);
    const data = await this.json(`files?${params}`,signal);
    if (!Array.isArray(data.files)) throw new DriveReadError();
    const files = data.files.map(raw => {
      const file = raw as DriveFile;
      if (!file || !DRIVE_ID.test(file.id) || typeof file.name !== "string" || typeof file.mimeType !== "string" || typeof file.modifiedTime !== "string" || Number.isNaN(Date.parse(file.modifiedTime))) throw new DriveReadError();
      if(file.mimeType === FOLDER) this.knownFolders.add(file.id); else if(file.mimeType !== SHORTCUT) this.knownFiles.add(file.id);
      return {...file,path:[folder.path,file.name].filter(Boolean).join(" / "),ancestors:[folder.id,...folder.ancestors]};
    });
    await this.catalogReference(folder.id, folder.ancestors, signal);
    return { files, nextPage: typeof data.nextPageToken === "string" ? data.nextPageToken : "" };
  }
  /** Validate current ancestry on every retrieval; never trust a cached search result or model ID. */
  async file(id: string, signal: AbortSignal): Promise<DriveFile> {
    if (!DRIVE_ID.test(id)) throw new DriveReadError();
    if (!this.knownFiles.has(id)) await this.search(id, signal);
    if (!this.knownFiles.has(id)) throw new DriveReadError();
    const root = await this.metadata(DRIVE_ROOT, signal);
    if (root.mimeType !== FOLDER) throw new DriveReadError();
    const file = await this.metadata(id, signal);
    if (file.mimeType === FOLDER || file.mimeType === SHORTCUT) throw new DriveReadError();
    const parts = [file.name]; const seen = new Set([id]); let current = file;
    for (let depth = 0; depth < 16; depth++) {
      if (!Array.isArray(current.parents) || current.parents.length !== 1) throw new DriveReadError();
      const parent = current.parents[0];
      if (parent === DRIVE_ROOT) return { ...file, path: parts.reverse().join(" / ") };
      if (!this.knownFolders.has(parent)) throw new DriveReadError();
      if (seen.has(parent)) throw new DriveReadError(); seen.add(parent);
      current = await this.metadata(parent, signal);
      if (current.mimeType !== FOLDER) throw new DriveReadError(); parts.push(current.name);
    }
    throw new DriveReadError();
  }
  async search(query: string, signal: AbortSignal, offset = 0): Promise<{ files: DriveFile[]; total: number | null; truncated: boolean }> {
    const terms = driveTerms(query); if (!terms.length || query.length > 120 || offset < 0 || offset > 1000) throw new DriveReadError();
    const queue: DriveFolder[] = [{ id: DRIVE_ROOT, path: "", depth: 0, ancestors: [] }]; const seen = new Set<string>(); const matches: DriveFile[] = [];
    let calls = 0; let incomplete = false; let scoped = false;
    const idQuery = query.length >= 20 && DRIVE_ID.test(query);
    const goal = offset + (terms.includes("дс") || idQuery ? 1 : 20);
    while (queue.length && calls < 100 && matches.length < goal) {
      const folder = queue.shift()!; if (seen.has(folder.id)) continue; seen.add(folder.id);
      try { await this.catalogReference(folder.id, folder.ancestors, signal); }
      catch { signal.throwIfAborted(); continue; }
      let page = "";
      do {
        if (++calls > 100) { incomplete = true; break; }
        const params = new URLSearchParams({ q: `'${folder.id}' in parents and trashed=false`, pageSize: "100", orderBy: "name", fields: "nextPageToken,files(id,name,mimeType,size)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
        if (page) params.set("pageToken", page);
        const data = await this.json(`files?${params}`, signal);
        if (!Array.isArray(data.files)) throw new DriveReadError();
        for (const raw of data.files) {
          const file = raw as DriveFile;
          if (!file || !DRIVE_ID.test(file.id) || typeof file.name !== "string" || typeof file.mimeType !== "string") throw new DriveReadError();
          const path = [folder.path, file.name].filter(Boolean).join(" / ");
          if (file.mimeType === SHORTCUT) continue;
          if (file.mimeType === FOLDER) { this.knownFolders.add(file.id); if (folder.depth < 15) queue.push({ id: file.id, path, depth: folder.depth + 1, ancestors: [folder.id, ...folder.ancestors] }); else incomplete = true; }
          else { this.knownFiles.add(file.id); if (file.id === query || terms.every(term => driveTerms(path).some(word => word.includes(term)))) {
            try {
              const live = await this.catalogReference(file.id, [folder.id, ...folder.ancestors], signal);
              matches.push({ ...live, path: [folder.path, live.name].filter(Boolean).join(" / "), ancestors: [folder.id, ...folder.ancestors] });
            } catch { signal.throwIfAborted(); }
          } }
        }
        page = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
      } while (page);
      if (folder.id === DRIVE_ROOT && !idQuery) {
        const brandTerms = terms.filter(term => !["дс", "pdf", "docx", "xlsx", "сертификат", "сертификаты", "протокол"].includes(term));
        const brandFolders = queue.filter(item => brandTerms.some(term => driveTerms(item.path).some(word => word.includes(term))));
        if (brandFolders.length && brandFolders.length < queue.length) { queue.splice(0, queue.length, ...brandFolders); scoped = true; }
      }
    }
    incomplete ||= queue.length > 0;
    const valid: DriveFile[] = [];
    for (const match of matches) {
      try { await this.catalogReference(match.id, match.ancestors!, signal); valid.push(match); }
      catch { signal.throwIfAborted(); }
    }
    return { files: valid.slice(offset, offset + 20), total: incomplete || scoped ? null : valid.length, truncated: incomplete || scoped || valid.length > offset + 20 };
  }
  async download(id: string, signal: AbortSignal): Promise<{ blob: Blob; filename: string }> {
    const file = await this.file(id, signal);
    if (Number(file.size) > MAX_BYTES) throw new DriveReadError();
    const exports: Record<string, { type: string; suffix: string }> = {
      "application/vnd.google-apps.document": { type: "application/pdf", suffix: ".pdf" },
      "application/vnd.google-apps.spreadsheet": { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", suffix: ".xlsx" },
      "application/vnd.google-apps.presentation": { type: "application/pdf", suffix: ".pdf" },
    };
    const format = exports[file.mimeType];
    if (file.mimeType.startsWith("application/vnd.google-apps.") && !format) throw new DriveReadError();
    const path = format ? `files/${id}/export?mimeType=${encodeURIComponent(format.type)}` : `files/${id}?alt=media&supportsAllDrives=true`;
    const response = await this.get(path, signal);
    const bytes = await this.boundedBytes(response, MAX_BYTES);
    // Recheck after download in case the file was moved out of the permitted tree in flight.
    await this.file(id, signal);
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: format?.type ?? "application/octet-stream" }), filename: safeFilename(file.name + (format?.suffix ?? "")) };
  }
  private async boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
    if (Number(response.headers.get("content-length")) > limit || !response.body) { await response.body?.cancel(); throw new DriveReadError(); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > limit) throw new DriveReadError(); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
  }
}
