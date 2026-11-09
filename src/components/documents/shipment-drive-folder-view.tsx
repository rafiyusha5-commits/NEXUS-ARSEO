"use client";
import { useState } from "react";
import { DocumentActions } from "@/components/documents/document-actions";
import type { DocumentActionIndex } from "@/lib/documents/action-index";
import { sourceState } from "@/lib/google/shipment-folder";
import { reconciliationLabels, type Candidate, type ReconciliationState } from "@/lib/google/folder-reconciliation";
import { DriveSubmit } from "./shipment-drive-submit";
export type FolderBinding = { folder_id: string; folder_name: string; checked_at: string | null };
export type FolderFile = { file_id: string; name: string; path: string; revision: string; present: boolean; imported_document_id: string | null; imported_revision: string | null; state?: ReconciliationState; candidates?: Candidate[]; verified?: boolean; operation_id?: string };
export type FolderActions = { bind: (form: FormData) => Promise<void>; scan: (form: FormData) => Promise<void>; upload: (form: FormData) => Promise<void>; check?: (form: FormData) => Promise<void>; link?: (form: FormData) => Promise<void> };
export function ShipmentDriveFolderView({ shipmentId, binding, files, types, canImport, actions, operationId, initialFolder, documentActions = {} }: { documentActions?: DocumentActionIndex;  shipmentId: string; binding: FolderBinding | null; files: FolderFile[]; types: { id: string; name_ru: string }[]; canImport: boolean; actions: FolderActions; operationId?: string; initialFolder?: string }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [folder, setFolder] = useState("");
  const group = (file: FolderFile) => file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")).trim() : "Корень папки";
  const groups = [...new Set(files.map(group))].sort();
  const shown = files.filter(f => (!filter || f.state === filter) && (!folder || group(f) === folder)
    && `${f.name} ${f.path}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru")));
  let content;
    if (!binding) {
      content = <form action={actions.bind} className="form-grid drive-binding-form">
        <input type="hidden" name="shipment_id" value={shipmentId}/>
        <input type="hidden" name="operation_id" value={operationId ?? ""}/>
        <p>Выберите папку отдельной поставки внутри «2026» или «Будущие заказы (ARSEO)».</p>
        <label>Ссылка на папку Google Drive<input name="folder" type="url" defaultValue={initialFolder ?? ""} required placeholder="https://drive.google.com/drive/folders/…" aria-describedby="drive-folder-help"/></label>
        <p id="drive-folder-help">Скопируйте адрес папки из браузера и вставьте в это поле. После привязки нажмите «Проверить папку», чтобы получить список файлов.</p>
        <DriveSubmit pending="Проверяю доступ…">Привязать папку</DriveSubmit>
      </form>;
    } else {
      content = <>
        <div className="drive-source"><p>Подключена папка <a href={`https://drive.google.com/drive/folders/${binding.folder_id}`} target="_blank" rel="noreferrer">{binding.folder_name}</a></p>
        <p>{binding.checked_at ? `Список проверен ${new Date(binding.checked_at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}. Файлов в сохранённом списке: ${files.length}.` : "Нажмите «Проверить папку», чтобы увидеть её файлы."}</p></div>
        <form action={actions.scan}><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="operation_id" value={operationId ?? ""}/><DriveSubmit pending="Проверяю папку и вложенные папки…">Проверить папку</DriveSubmit></form>
        <p>Файлы проверяются по кнопке. Удалённые или изменённые исходники не удаляют и не заменяют документы Nexus. Ярлыки пропускаются.</p>
        <p className="form-help">Выберите нужные файлы ниже. Для каждого проверьте тип и назначение. Файлов без доступной связи с документом Nexus: {files.filter(f => !f.imported_document_id).length}. Полноту обязательного комплекта проверяйте в блоке «Сверка».</p>
        <div className="form-grid">
          <label>Поиск файлов<input type="search" value={search} onChange={e => setSearch(e.target.value)}/></label>
          <label>Состояние<select aria-label="Состояние" value={filter} onChange={e => setFilter(e.target.value)}><option value="">Все ({files.length})</option>{Object.entries(reconciliationLabels).map(([key, label]) => <option key={key} value={key}>{label} ({files.filter(f => f.state === key).length})</option>)}</select></label>
          <label>Подпапка<select aria-label="Подпапка" value={folder} onChange={e => setFolder(e.target.value)}><option value="">Все подпапки</option>{groups.map(path => <option key={path}>{path}</option>)}</select></label>
        </div>
        <p role="status">Показано {shown.length} из {files.length}</p>
        {binding.checked_at && !files.length && <p className="empty-state">В сохранённом списке пока нет файлов. Откройте подключённую папку, проверьте её состав и нажмите «Проверить папку».</p>}
        {files.length > 0 && !shown.length && <div className="empty-state"><p>Под выбранные условия файлы не найдены.</p><button className="ghost" type="button" onClick={() => { setSearch(""); setFilter(""); setFolder(""); }}>Сбросить фильтры</button></div>}
        <div className="compact-list">{shown.map(file => <article className="shipment-drive-file" key={file.file_id}>
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}><strong>{file.name}</strong><small>{file.path} · версия Drive {file.revision}</small><p>{file.state ? reconciliationLabels[file.state] : sourceState(file)}</p>
            {file.present && !file.imported_document_id && file.state !== "unsupported" && actions.check && <form action={actions.check}>
              <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="file_id" value={file.file_id}/><input type="hidden" name="revision" value={file.revision}/>
              <p>{file.verified ? "Содержимое проверено для показанной версии. Перед связыванием оно проверяется повторно." : "Содержимое ещё не сравнивалось. Имя и размер не доказывают совпадение."}</p>
              <DriveSubmit pending="Скачиваю только для проверки…">Проверить содержимое</DriveSubmit>
            </form>}
            {file.candidates?.map(candidate => <aside className="panel" key={candidate.id}>
              <strong>{candidate.title}</strong><DocumentActions document={documentActions[candidate.id]} version={candidate.version}/>
              <p>{candidate.type} · версия {candidate.version} · {({ approved: "Документ одобрен сотрудником", uploaded: "Документ не подтверждён", under_review: "Документ на проверке" } as Record<string, string>)[candidate.status] ?? "Проверка требуется"}</p>
              {candidate.review && <p>{candidate.review}</p>}
              <p>Основание: {candidate.basis === "checksum" ? "Совпадает проверенное содержимое файлов" : candidate.basis === "linked" ? "Действующая связь с поставкой" : "Совпадает имя — проверьте содержимое файлов"}. Подтверждение прочитанных реквизитов проверяется отдельно в документе.</p>
              {candidate.basis === "checksum" && file.present && !file.imported_document_id && canImport && actions.link && <form action={actions.link}>
                <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="file_id" value={file.file_id}/><input type="hidden" name="revision" value={file.revision}/>
                <input type="hidden" name="document_id" value={candidate.id}/><input type="hidden" name="version_id" value={candidate.versionId}/>
                <label className="check-label"><input type="checkbox" name="confirm" value="yes" required/> Проверил назначение документа для этой поставки</label>
                <DriveSubmit pending="Повторно проверяю источник и версию…">Связать с существующим документом</DriveSubmit>
              </form>}
            </aside>)}
            {file.imported_document_id ? <><DocumentActions document={documentActions[file.imported_document_id]}/>{file.revision !== file.imported_revision && <p>Для замены сначала сравните оригиналы и отдельно согласуйте новую версию. Эта проверка сохраняет ручные подтверждения.</p>}</> : file.present && file.state !== "unsupported" && file.state !== "exact" && canImport && <form action={actions.upload} className="form-grid">
              <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="file_id" value={file.file_id}/><input type="hidden" name="revision" value={file.revision}/>
              <input type="hidden" name="operation_id" value={file.operation_id ?? ""}/>
              <label>Тип документа<select name="document_type_id" required defaultValue=""><option value="" disabled>Выберите тип</option>{types?.map(type => <option key={type.id} value={type.id}>{type.name_ru}</option>)}</select></label>
              <label className="check-label"><input type="checkbox" name="confirm" value="yes" required/> Загрузить этот файл в Nexus для проверки или связать уже загруженный</label>
              <DriveSubmit pending="Проверяю файл и загружаю…">Загрузить для проверки</DriveSubmit>
            </form>}
          </div>
        </article>)}</div>
      </>;
    }
  return <section className="panel admin-section shipment-drive-panel" id="drive-folder"><div className="panel-heading"><div><p className="eyebrow">Источник документов · только чтение</p><h2>Папка Google Drive</h2></div></div><p>Google Drive остаётся без изменений. Загрузка файлов не меняет товары, приёмку, расходы и подтверждённые значения.</p>{content}</section>;
}
