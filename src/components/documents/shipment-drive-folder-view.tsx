import Link from "next/link";
import { sourceState } from "@/lib/google/shipment-folder";
import { DriveSubmit } from "./shipment-drive-submit";
export type FolderBinding = { folder_id: string; folder_name: string; checked_at: string | null };
export type FolderFile = { file_id: string; name: string; path: string; revision: string; present: boolean; imported_document_id: string | null; imported_revision: string | null };
export type FolderActions = { bind: (form: FormData) => Promise<void>; scan: (form: FormData) => Promise<void>; upload: (form: FormData) => Promise<void> };
export function ShipmentDriveFolderView({ shipmentId, binding, files, types, canImport, actions }: { shipmentId: string; binding: FolderBinding | null; files: FolderFile[]; types: { id: string; name_ru: string }[]; canImport: boolean; actions: FolderActions }) {
  let content;
    if (!binding) {
      content = <form action={actions.bind} className="form-grid">
        <input type="hidden" name="shipment_id" value={shipmentId}/>
        <label>Папка этой поставки в архиве 2026 года<input name="folder" type="url" required placeholder="https://drive.google.com/drive/folders/…"/></label>
        <DriveSubmit pending="Проверяю доступ…">Привязать папку</DriveSubmit>
      </form>;
    } else {
      content = <>
        <p><a href={`https://drive.google.com/drive/folders/${binding.folder_id}`} target="_blank" rel="noreferrer">{binding.folder_name}</a></p>
        <p>{binding.checked_at ? `Последняя проверка: ${new Date(binding.checked_at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}` : "Папка ещё не проверена"}</p>
        <form action={actions.scan}><input type="hidden" name="shipment_id" value={shipmentId}/><DriveSubmit pending="Проверяю папку и вложенные папки…">Проверить папку</DriveSubmit></form>
        <p>Файлы проверяются по кнопке. Удалённые или изменённые исходники не удаляют и не заменяют документы Nexus. Ярлыки пропускаются.</p>
        <div className="compact-list">{files?.map(file => <article className="shipment-drive-file" key={file.file_id}>
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}><strong>{file.name}</strong><small>{file.path}</small><p>{sourceState(file)}</p>
            {file.imported_document_id ? <><Link href={`/documents/${file.imported_document_id}`}>Открыть сохранённый документ</Link>{file.revision !== file.imported_revision && <p>Для замены сначала сравните оригиналы и отдельно согласуйте новую версию. Эта проверка сохраняет ручные подтверждения.</p>}</> : file.present && canImport && <form action={actions.upload} className="form-grid">
              <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="file_id" value={file.file_id}/><input type="hidden" name="revision" value={file.revision}/>
              <label>Тип документа<select name="document_type_id" required defaultValue=""><option value="" disabled>Выберите тип</option>{types?.map(type => <option key={type.id} value={type.id}>{type.name_ru}</option>)}</select></label>
              <label><input type="checkbox" name="confirm" value="yes" required/> Загрузить этот файл в Nexus для проверки или связать уже загруженный</label>
              <DriveSubmit pending="Проверяю файл и загружаю…">Загрузить для проверки</DriveSubmit>
            </form>}
          </div>
        </article>)}</div>
      </>;
    }
  return <section className="panel admin-section shipment-drive-panel" id="drive-folder"><div className="panel-heading"><div><p className="eyebrow">Источник документов · только чтение</p><h2>Папка Google Drive</h2></div></div><p>Google Drive остаётся без изменений. Загрузка файлов не меняет товары, приёмку, расходы и подтверждённые значения.</p>{content}</section>;
}
