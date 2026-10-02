"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DOCUMENT_FILE_ACCEPT, MAX_DOCUMENT_FILE_SIZE_BYTES, MAX_DOCUMENT_FILE_SIZE_LABEL } from "@/lib/documents/files";
import { inferDocumentTypeId, titleFromFileName, type BulkDocumentType } from "@/lib/documents/bulk";

type UploadType = BulkDocumentType & { category: string };
type UploadRow = {
  key: string;
  file: File;
  checked: boolean;
  documentTypeId: string;
  title: string;
  state: "ready" | "uploading" | "done" | "error";
  message: string;
};

const rowKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

export function BulkDocumentUpload({ types, primaryLink, autoExtractShipmentId }: { types: UploadType[]; primaryLink?: string; autoExtractShipmentId?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [running, setRunning] = useState(false);
  const [batchMessage, setBatchMessage] = useState("");
  const selected = rows.filter(row => row.checked && row.state !== "done");
  const allChecked = rows.length > 0 && rows.every(row => row.checked || row.state === "done");
  const typeOptions = useMemo(() => types.map(({ id, code, name }) => ({ id, code, name })), [types]);

  function addFiles(files: FileList | null) {
    if (!files) return;
    setRows(current => {
      const known = new Set(current.map(row => row.key));
      return [...current, ...Array.from(files).filter(file => !known.has(rowKey(file))).map(file => ({
        key: rowKey(file), file, checked: file.size > 0 && file.size <= MAX_DOCUMENT_FILE_SIZE_BYTES,
        documentTypeId: inferDocumentTypeId(file.name, typeOptions), title: titleFromFileName(file.name),
        state: "ready" as const,
        message: file.size > MAX_DOCUMENT_FILE_SIZE_BYTES ? `Файл больше ${MAX_DOCUMENT_FILE_SIZE_LABEL}` : file.size === 0 ? "Файл пустой" : "Готов к загрузке",
      }))];
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  function update(key: string, patch: Partial<UploadRow>) {
    setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row));
  }

  async function uploadSelected() {
    const queue = rows.filter(row => row.checked && row.state !== "done");
    const invalid = queue.find(row => !row.documentTypeId || !row.title.trim());
    if (invalid) {
      update(invalid.key, { state: "error", message: !invalid.documentTypeId ? "Выберите тип документа" : "Укажите название" });
      return;
    }
    setRunning(true);
    setBatchMessage("");
    let completed = 0;
    for (const row of queue) {
      update(row.key, { state: "uploading", message: "Загружается…" });
      const body = new FormData();
      body.set("file", row.file); body.set("document_type_id", row.documentTypeId); body.set("title", row.title.trim());
      if (primaryLink) body.set("link_primary", primaryLink);
      try {
        const response = await fetch("/api/documents/upload", { method: "POST", body });
        const result = await response.json() as { ok?: boolean; error?: string };
        if (!response.ok || !result.ok) throw new Error(result.error || "Документ не загружен");
        completed++;
        update(row.key, { state: "done", checked: false, message: "Загружен" });
      } catch (error) {
        update(row.key, { state: "error", message: error instanceof Error ? error.message : "Ошибка загрузки" });
      }
    }
    if (completed && autoExtractShipmentId) {
      setBatchMessage("Документы загружены. Система распознаёт комплект и сверяет данные…");
      try {
        const response = await fetch(`/api/shipments/${autoExtractShipmentId}/sources/extract`, { method: "POST" });
        const result = await response.json() as { ok?: boolean; error?: string; summary?: { confirmed: number; review: number; failed: number } };
        if (!response.ok || !result.ok || !result.summary) throw new Error(result.error || "Не удалось распознать комплект");
        setBatchMessage(`Распознано: ${result.summary.confirmed}; требует проверки: ${result.summary.review}; не прочитано: ${result.summary.failed}.`);
      } catch (error) {
        setBatchMessage(`Файлы сохранены, но автоматическое распознавание не завершено: ${error instanceof Error ? error.message : "ошибка"}. Можно повторить его кнопкой ниже.`);
      }
    }
    setRunning(false);
    if (completed) router.refresh();
  }

  return <div className="bulk-upload">
    <div className="bulk-upload-toolbar">
      <label className="primary file-button">+ Выбрать несколько файлов<input ref={inputRef} type="file" multiple accept={DOCUMENT_FILE_ACCEPT} onChange={event => addFiles(event.target.files)} /></label>
      {rows.length > 0 && <><label className="check-label"><input type="checkbox" checked={allChecked} onChange={event => setRows(current => current.map(row => row.state === "done" ? row : { ...row, checked: event.target.checked }))} /> Выбрать все</label><button className="primary" type="button" disabled={running || !selected.length} onClick={uploadSelected}>Загрузить отмеченные ({selected.length})</button></>}
    </div>
    <p className="form-help">Каждый отмеченный файл загружается отдельно, поэтому ошибка одного документа не отменяет остальные. Максимальный размер одного файла — {MAX_DOCUMENT_FILE_SIZE_LABEL}.</p>
    {batchMessage && <div className="setup-notice">{batchMessage}</div>}
    {rows.length > 0 && <div className="table-wrap"><table className="data-table bulk-upload-table"><thead><tr><th></th><th>Файл</th><th>Тип документа</th><th>Название</th><th>Состояние</th></tr></thead><tbody>{rows.map(row => <tr key={row.key} className={row.state === "error" ? "has-error" : ""}>
      <td><input aria-label={`Загрузить ${row.file.name}`} type="checkbox" checked={row.checked} disabled={running || row.state === "done"} onChange={event => update(row.key, { checked: event.target.checked, state: row.state === "error" ? "ready" : row.state })} /></td>
      <td><strong>{row.file.name}</strong><small>{(row.file.size / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ</small></td>
      <td><select aria-label={`Тип для ${row.file.name}`} value={row.documentTypeId} disabled={running || row.state === "done"} onChange={event => update(row.key, { documentTypeId: event.target.value, state: "ready", message: "Готов к загрузке" })}><option value="">Выберите тип</option>{types.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}</select></td>
      <td><input aria-label={`Название для ${row.file.name}`} value={row.title} disabled={running || row.state === "done"} maxLength={300} onChange={event => update(row.key, { title: event.target.value })} /></td>
      <td><span className={`doc-badge bulk-${row.state}`}>{row.message}</span>{row.state !== "uploading" && row.state !== "done" && <button className="text-button" type="button" onClick={() => setRows(current => current.filter(item => item.key !== row.key))}>Убрать</button>}</td>
    </tr>)}</tbody></table></div>}
  </div>;
}
