"use client";
import { useState } from "react";
import Link from "next/link";
import { sourceState } from "@/lib/google/shipment-folder";
import { reconciliationLabels, type Candidate, type ReconciliationState } from "@/lib/google/folder-reconciliation";
import { DriveSubmit } from "./shipment-drive-submit";
export type FolderBinding = { folder_id: string; folder_name: string; checked_at: string | null };
export type FolderFile = { file_id: string; name: string; path: string; revision: string; present: boolean; imported_document_id: string | null; imported_revision: string | null; state?: ReconciliationState; candidates?: Candidate[]; verified?: boolean };
export type FolderActions = { bind: (form: FormData) => Promise<void>; scan: (form: FormData) => Promise<void>; upload: (form: FormData) => Promise<void>; check?: (form: FormData) => Promise<void>; link?: (form: FormData) => Promise<void> };
export function ShipmentDriveFolderView({ shipmentId, binding, files, types, canImport, actions }: { shipmentId: string; binding: FolderBinding | null; files: FolderFile[]; types: { id: string; name_ru: string }[]; canImport: boolean; actions: FolderActions }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [folder, setFolder] = useState("");
  const group = (file: FolderFile) => file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")).trim() : "Корень папки";
  const groups = [...new Set(files.map(group))].sort();
  const shown = files.filter(f => (!filter || f.state === filter) && (!folder || group(f) === folder)
    && `${f.name} ${f.path}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru")));
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
        <p>Без доступной связи: {files.filter(f => !f.imported_document_id).length}. Это не число обязательных недостающих документов. Названия подпапок не определяют назначение документа: например, «Продажа клиенту» не означает импорт поставки.</p>
        <div className="form-grid">
          <label>Поиск файлов<input type="search" value={search} onChange={e => setSearch(e.target.value)}/></label>
          <label>Состояние<select aria-label="Состояние" value={filter} onChange={e => setFilter(e.target.value)}><option value="">Все ({files.length})</option>{Object.entries(reconciliationLabels).map(([key, label]) => <option key={key} value={key}>{label} ({files.filter(f => f.state === key).length})</option>)}</select></label>
          <label>Подпапка<select aria-label="Подпапка" value={folder} onChange={e => setFolder(e.target.value)}><option value="">Все подпапки</option>{groups.map(path => <option key={path}>{path}</option>)}</select></label>
        </div>
        <p role="status">Показано {shown.length} из {files.length}</p>
        <div className="compact-list">{shown.map(file => <article className="shipment-drive-file" key={file.file_id}>
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}><strong>{file.name}</strong><small>{file.path} · версия Drive {file.revision}</small><p>{file.state ? reconciliationLabels[file.state] : sourceState(file)}</p>
            {file.present && !file.imported_document_id && file.state !== "unsupported" && actions.check && <form action={actions.check}>
              <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="file_id" value={file.file_id}/><input type="hidden" name="revision" value={file.revision}/>
              <p>{file.verified ? "Содержимое проверено для показанной версии. Перед связыванием оно проверяется повторно." : "Содержимое ещё не сравнивалось. Имя и размер не доказывают совпадение."}</p>
              <DriveSubmit pending="Скачиваю только для проверки…">Проверить содержимое</DriveSubmit>
            </form>}
            {file.candidates?.map(candidate => <aside className="panel" key={candidate.id}>
              <Link href={`/documents/${candidate.id}`}>{candidate.title}</Link>
              <p>{candidate.type} · версия {candidate.version} · {({ approved: "Документ одобрен сотрудником", uploaded: "Документ не подтверждён", under_review: "Документ на проверке" } as Record<string, string>)[candidate.status] ?? "Проверка требуется"}</p>
              {candidate.review && <p>{candidate.review}</p>}
              <p>Основание: {candidate.basis === "checksum" ? "SHA-256 скачанного содержимого совпадает" : candidate.basis === "linked" ? "Действующая связь с поставкой" : "Совпадает имя — это не доказательство дубля"}. Подтверждение прочитанных реквизитов проверяется отдельно в документе.</p>
              {candidate.basis === "checksum" && file.present && !file.imported_document_id && canImport && actions.link && <form action={actions.link}>
                <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="file_id" value={file.file_id}/><input type="hidden" name="revision" value={file.revision}/>
                <input type="hidden" name="document_id" value={candidate.id}/><input type="hidden" name="version_id" value={candidate.versionId}/>
                <label className="check-label"><input type="checkbox" name="confirm" value="yes" required/> Проверил назначение документа для этой поставки</label>
                <DriveSubmit pending="Повторно проверяю источник и версию…">Связать с существующим документом</DriveSubmit>
              </form>}
            </aside>)}
            {file.imported_document_id ? <><Link href={`/documents/${file.imported_document_id}`}>Открыть сохранённый документ</Link>{file.revision !== file.imported_revision && <p>Для замены сначала сравните оригиналы и отдельно согласуйте новую версию. Эта проверка сохраняет ручные подтверждения.</p>}</> : file.present && file.state !== "unsupported" && file.state !== "exact" && canImport && <form action={actions.upload} className="form-grid">
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
