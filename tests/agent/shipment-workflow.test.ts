import { test } from "node:test";
import assert from "node:assert/strict";
import { preparationRequest, folderHint, workspacePath, documentActionReturn, createReturn } from "../../src/lib/agent/shipment-workflow.ts";

const id = "00000000-0000-4000-8000-000000000001";
test("preparation is navigation from the employee's request, not posting", () => {
  const result = preparationRequest("Подготовь поставку из папки https://drive.google.com/drive/folders/Synthetic_folder_123. Приёмку пока не проводи");
  assert.equal(result?.href, "/assistant/shipments"); // punctuation is not silently turned into a valid URL
  assert.equal(preparationRequest("Разбери документы поставки из https://drive.google.com/drive/folders/Synthetic_folder_123")?.folder, "Synthetic_folder_123");
  assert.equal(preparationRequest("Создай новую поставку")?.href, "/assistant/shipments");
  for (const text of ["Какие документы есть у поставки?", "Подготовь приёмку поставки по документам", "Подготовь отгрузку поставки", "Проведи продажу", "а".repeat(1001)]) assert.equal(preparationRequest(text), null);
});
test("untrusted URLs and ambiguous folders cannot select a source", () => {
  for (const value of ["https://evil.example/drive/folders/Synthetic_folder_123", "https://drive.google.com.evil.example/drive/folders/Synthetic_folder_123", "https://u:p@drive.google.com/drive/folders/Synthetic_folder_123", "javascript:alert(1)", ["Synthetic_folder_123"]]) assert.equal(folderHint(value), null);
  assert.equal(preparationRequest("Загрузи папки https://drive.google.com/drive/folders/Synthetic_folder_123 https://drive.google.com/drive/folders/Synthetic_folder_456")?.folder, null);
  assert.equal(folderHint("https://drive.google.com/drive/u/0/folders/Synthetic_folder_123?usp=sharing"), "Synthetic_folder_123");
});
test("native redirects remain native; workflow destination is closed and anchored", () => {
  const f = new FormData();
  f.set("return_to", "https://evil.example");
  assert.equal(documentActionReturn(f, id, "success", "done"), `/shipments/${id}?tab=documents&success=done#drive-folder`);
  assert.equal(documentActionReturn(f, id, "success", "done", "check"), `/shipments/${id}?tab=documents&check_success=done#document-check`);
  f.set("assistant_workflow", "1");
  assert.equal(documentActionReturn(f, id, "error", "check", true), `/assistant/shipments/${id}?step=review&source_error=check#source-documents`);
  assert.equal(documentActionReturn(f, id, "success", "done", "check"), `/assistant/shipments/${id}?step=review&check_success=done#document-check`);
  assert.equal(documentActionReturn(f, "//evil.example", "success", "done"), "/shipments");
  assert.throws(() => workspacePath("not-an-id"));
  f.set("folder", "https://evil.example");
  assert.equal(createReturn(f, id), `/assistant/shipments/${id}?step=files`);
});
