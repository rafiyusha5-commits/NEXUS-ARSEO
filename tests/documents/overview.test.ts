import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentFolders, kitRows, todoCards, typeTag } from "../../src/lib/documents/overview.ts";

const rule = (typeId: string, typeName: string, stageOrder: number | null, mandatory = true, stageName = `Этап ${stageOrder}`) => ({ typeId, typeName, mandatory, stageName, stageOrder });

describe("documents tab overview", () => {
  it("shows the document set by stage: ready, waiting, needed now, needed later", () => {
    const groups = kitRows(
      [rule("inv", "Инвойс", 2), rule("pl", "Упаковочный лист", 2), rule("cmr", "CMR", 6), rule("dt", "Таможенная декларация", 8), rule("cert", "Сертификат", 2, false)],
      [{ id: "d1", typeId: "inv", typeName: "Инвойс", status: "approved" }, { id: "d2", typeId: "pl", typeName: "Упаковочный лист", status: "uploaded" },
       { id: "d3", typeId: "st", typeName: "Макет стикера", status: "uploaded" }, { id: "d4", typeId: "st", typeName: "Макет стикера", status: "uploaded" }],
      3);
    assert.deepEqual(groups.map(group => group.stage), ["Этап 2", "Этап 6", "Этап 8", "Другие документы"]);
    assert.deepEqual(groups[0].items.map(item => [item.name, item.tone]), [["Инвойс", "ok"], ["Упаковочный лист", "wait"], ["Сертификат", "optional"]]);
    assert.equal(groups[1].items[0].tone, "later");
    assert.deepEqual(groups[3].items, [{ name: "Макет стикера", state: "2 документа", tone: "optional", counted: false }]);
  });

  it("says «needed now» for a mandatory document of a stage already reached", () => {
    const [group] = kitRows([rule("cmr", "CMR", 4)], [], 5);
    assert.deepEqual(group.items[0], { name: "CMR", state: "Нужен сейчас", tone: "now", counted: true });
  });

  it("shows only the cards with something to do", () => {
    assert.deepEqual(todoCards({ uploadable: 0, toConfirm: 0, unreadable: 0, errors: 0, workbook: false }, "s"), []);
    const cards = todoCards({ uploadable: 7, toConfirm: 3, unreadable: 0, errors: 1, workbook: true }, "s");
    assert.deepEqual(cards.map(card => [card.key, card.count, card.title]), [
      ["errors", 1, "ошибка в документах"], ["upload", 7, "файлов в папке Drive не загружены"],
      ["confirm", 3, "документа ждут подтверждения"], ["workbook", null, "Сверка с «Вн расчетами»"]]);
    assert.equal(cards[1].href, "/shipments/s?tab=documents#drive-folder");
  });

  it("groups documents by their Drive folder and folds the large groups", () => {
    const docs = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, status: "uploaded", path: `Продажа / Стикеры / ${i}.jpg` })),
      { id: "a", status: "approved", path: "Закуп / invoice.pdf" }, { id: "b", status: "under_review", path: "Закуп / pl.pdf" },
      { id: "c", status: "uploaded", path: null }, { id: "d", status: "uploaded", path: "readme.pdf" },
    ];
    const groups = documentFolders(docs);
    assert.deepEqual(groups.map(group => [group.name, group.ids.length, group.open]), [["Закуп", 2, true], ["Корень папки", 1, true], ["Продажа", 8, false], ["Загружены в Nexus вручную", 1, true]]);
    assert.equal(groups[0].summary, "1 утверждён · 1 на проверке");
    assert.equal(documentFolders([{ id: "x", status: "uploaded", path: null }])[0].open, true);
  });

  it("gives every document type a short tag", () => {
    assert.equal(typeTag("Инвойс"), "ИНВ");
    assert.equal(typeTag("Документ водителя"), "ДВ");
    assert.equal(typeTag(""), "ДОК");
  });
});
