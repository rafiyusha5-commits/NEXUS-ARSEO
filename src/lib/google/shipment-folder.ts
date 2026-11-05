import { DRIVE_ID, type DriveFile, type DriveReadonly } from "./drive-readonly.ts";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export function folderId(input: string): string {
  const value = input.trim();
  if (DRIVE_ID.test(value)) return value;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/);
    if (url.origin === "https://drive.google.com" && !url.username && !url.password && match && DRIVE_ID.test(match[1])) return match[1];
  } catch { /* no arbitrary hosts or URLs */ }
  throw new Error("Вставьте ссылку на папку Google Drive");
}
export type FolderEntry = { file_id: string; name: string; path: string; mime_type: string; revision: string; size: number | null };
export function entry(file: DriveFile): FolderEntry {
  if (!file.version || !/^\d{1,30}$/.test(file.version)) throw new Error("Не удалось проверить версию файла");
  return { file_id: file.id, name: file.name.slice(0, 255), path: file.path.slice(0, 2000), mime_type: file.mimeType, revision: file.version, size: file.size && /^\d+$/.test(file.size) ? Number(file.size) : null };
}
/** An incomplete scan is never published as a complete snapshot or as removed files. */
export async function scanFolder(drive: Pick<DriveReadonly, "scopedReference" | "catalogPage">, id: string, signal: AbortSignal): Promise<FolderEntry[]> {
  const root = await drive.scopedReference(id, signal);
  if (root.mimeType !== FOLDER_MIME) throw new Error("Выберите папку");
  const queue = [{ id, path: "", depth: 0, ancestors: root.ancestors ?? [], page: "" }];
  const seen = new Set<string>([id]); const files: FolderEntry[] = []; let pages = 0;
  const cancellation = new AbortController();
  const scanSignal = AbortSignal.any([signal, cancellation.signal]);
  try {
    while (queue.length) {
      scanSignal.throwIfAborted();
      const batch = queue.splice(0, 3);
      pages += batch.length;
      if (pages > 50) throw new Error("Папка слишком велика. Выберите отдельную папку поставки");
      // Each page still checks its entire live ancestry before and after reading.
      // Bound parallelism avoids spending the deadline on serial round trips.
      const results = await Promise.all(batch.map(async folder => {
        try { return await drive.catalogPage(folder, scanSignal); }
        catch (error) { cancellation.abort(); throw error; }
      }));
      for (const [index, page] of results.entries()) {
        const folder = batch[index];
        if (page.nextPage) queue.unshift({ ...folder, page: page.nextPage });
        for (const file of page.files) {
          if (file.mimeType === "application/vnd.google-apps.shortcut") continue;
          if (seen.has(file.id)) throw new Error("Состав папки изменился. Повторите проверку");
          seen.add(file.id);
          if (file.mimeType === FOLDER_MIME) {
            if ((file.ancestors?.length ?? 0) >= 15) throw new Error("Слишком много вложенных папок");
            queue.push({ id: file.id, path: file.path, depth: folder.depth + 1, ancestors: file.ancestors!, page: "" });
          } else {
            files.push(entry(file));
            if (files.length > 500) throw new Error("В папке больше 500 файлов. Выберите отдельную папку поставки");
          }
        }
      }
    }
    await drive.scopedReference(id, scanSignal);
    return files;
  } finally { cancellation.abort(); }
}

export function insideFolder(file: DriveFile, folder: string, revision: string) {
  if (!file.ancestors?.includes(folder) || file.version !== revision) throw new Error("Файл изменён или перемещён. Сначала повторите проверку папки");
}

export function sourceState(row: { present: boolean; imported_revision: string | null; revision: string }) {
  if (!row.present) return "Не найден при последней проверке — документ Nexus сохранён";
  if (!row.imported_revision) return "Новый — можно загрузить для проверки";
  return row.imported_revision === row.revision ? "Уже связан с документом Nexus" : "Изменён на Drive — сохранённый документ не заменён";
}
