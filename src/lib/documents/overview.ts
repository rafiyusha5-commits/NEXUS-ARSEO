// The overview at the top of a shipment's «Документы» tab (2026-11-23): pure functions, display only.

export type KitRequirement = { typeId: string; typeName: string; mandatory: boolean; stageName: string | null; stageOrder: number | null };
export type KitDocument = { id: string; typeId: string; typeName: string; status: string };
export type KitTone = "ok" | "wait" | "now" | "later" | "optional";
export type KitItem = { name: string; state: string; tone: KitTone; counted: boolean };
export type KitGroup = { stage: string; items: KitItem[] };

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

/** The document set by process stage: each required type with its state, then the documents no rule asks for. */
export function kitRows(requirements: readonly KitRequirement[], documents: readonly KitDocument[], currentStageOrder: number): KitGroup[] {
  const groups = new Map<string, { order: number; items: KitItem[] }>();
  const add = (stage: string, order: number, item: KitItem) => {
    const group = groups.get(stage) ?? { order, items: [] };
    if (!group.items.some(existing => existing.name === item.name)) group.items.push(item);
    groups.set(stage, group);
  };
  const byType = new Map<string, KitRequirement>();
  for (const rule of requirements) {
    const known = byType.get(rule.typeId);
    // A type required at several stages counts at its earliest mandatory one.
    if (!known || (rule.mandatory && !known.mandatory) || (rule.mandatory === known.mandatory && (rule.stageOrder ?? 999) < (known.stageOrder ?? 999))) byType.set(rule.typeId, rule);
  }
  for (const rule of byType.values()) {
    const present = documents.filter(document => document.typeId === rule.typeId);
    const stage = rule.stageName ?? "Вся поставка";
    const order = rule.stageOrder ?? 0;
    if (present.length) {
      const approved = present.filter(document => document.status === "approved").length;
      const count = present.length > 1 ? `${present.length} ${plural(present.length, "загружен", "загружено", "загружено")}` : "Загружен";
      add(stage, order, approved === present.length
        ? { name: rule.typeName, state: present.length > 1 ? `${present.length} утверждено` : "Утверждён", tone: "ok", counted: rule.mandatory }
        : { name: rule.typeName, state: `${count} · ждёт проверки`, tone: "wait", counted: rule.mandatory });
    } else if (!rule.mandatory) add(stage, order, { name: rule.typeName, state: "Необязательный", tone: "optional", counted: false });
    else if (rule.stageOrder !== null && rule.stageOrder > currentStageOrder) add(stage, order, { name: rule.typeName, state: "Понадобится позже", tone: "later", counted: true });
    else add(stage, order, { name: rule.typeName, state: "Нужен сейчас", tone: "now", counted: true });
  }
  // Documents of types no rule asks for: shown by type with their number, so a wrong type is easy to spot.
  const other = new Map<string, number>();
  for (const document of documents) if (!byType.has(document.typeId)) other.set(document.typeName, (other.get(document.typeName) ?? 0) + 1);
  for (const [name, count] of [...other].sort((a, b) => a[0].localeCompare(b[0], "ru")))
    add("Другие документы", 10000, { name, state: `${count} ${plural(count, "документ", "документа", "документов")}`, tone: "optional", counted: false });
  return [...groups].sort((a, b) => a[1].order - b[1].order).map(([stage, group]) => ({ stage, items: group.items }));
}

export type TodoInput = { uploadable: number; toConfirm: number; unreadable: number; errors: number; workbook: boolean };
export type TodoCard = { key: string; count: number | null; title: string; hint: string; action: string; href: string; tone: "now" | "wait" | "ok" | "error" };

/** The «Что сделать сейчас» cards: only the ones with something to do. */
export function todoCards(input: TodoInput, shipmentId: string): TodoCard[] {
  const tab = `/shipments/${shipmentId}?tab=documents`;
  const cards: TodoCard[] = [];
  if (input.errors) cards.push({ key: "errors", count: input.errors, tone: "error", title: plural(input.errors, "ошибка в документах", "ошибки в документах", "ошибок в документах"),
    hint: "Агент «Сверка» нашёл расхождения с карточкой поставки.", action: "Посмотреть ошибки", href: `${tab}#document-check` });
  if (input.uploadable) cards.push({ key: "upload", count: input.uploadable, tone: "now", title: plural(input.uploadable, "файл в папке Drive не загружен", "файла в папке Drive не загружены", "файлов в папке Drive не загружены"),
    hint: "Тип документа уже подставлен по названию — проверьте и загрузите.", action: "Загрузить файлы", href: `${tab}#drive-folder` });
  if (input.toConfirm) cards.push({ key: "confirm", count: input.toConfirm, tone: "wait", title: plural(input.toConfirm, "документ ждёт подтверждения", "документа ждут подтверждения", "документов ждут подтверждения"),
    hint: "Nexus прочитал данные — сверьте их с оригиналом и подтвердите.", action: "Проверить данные", href: `${tab}#source-documents` });
  if (input.unreadable) cards.push({ key: "failed", count: input.unreadable, tone: "error", title: plural(input.unreadable, "документ не прочитан", "документа не прочитаны", "документов не прочитаны"),
    hint: "Откройте строку документа и повторите чтение или введите данные вручную.", action: "Открыть", href: `${tab}#source-documents` });
  if (input.workbook) cards.push({ key: "workbook", count: null, tone: "ok", title: "Сверка с «Вн расчетами»",
    hint: "Строки заказа, растаможка, стикеры и распределение из таблицы папки.", action: "Открыть сверку", href: `/shipments/${shipmentId}/workbook` });
  return cards;
}

export type FolderGroup = { name: string; ids: string[]; open: boolean; summary: string };

/** Documents by the top Drive subfolder they came from; small groups stay open, large ones start folded. */
export function documentFolders(documents: readonly { id: string; status: string; path: string | null }[]): FolderGroup[] {
  const MANUAL = "Загружены в Nexus вручную", ROOT = "Корень папки";
  const groups = new Map<string, { id: string; status: string }[]>();
  for (const document of documents) {
    const parts = document.path ? document.path.split(" / ") : [];
    const name = document.path === null ? MANUAL : parts.length > 1 ? parts[0].trim() || ROOT : ROOT;
    groups.set(name, [...(groups.get(name) ?? []), document]);
  }
  const names = [...groups.keys()].sort((a, b) => (a === MANUAL ? 1 : 0) - (b === MANUAL ? 1 : 0) || a.localeCompare(b, "ru"));
  return names.map(name => {
    const rows = groups.get(name)!;
    const approved = rows.filter(row => row.status === "approved").length, review = rows.filter(row => row.status === "under_review").length;
    const rest = rows.length - approved - review;
    const summary = [approved && `${approved} ${plural(approved, "утверждён", "утверждено", "утверждено")}`, review && `${review} на проверке`,
      rest && `${rest} ${plural(rest, "загружен", "загружено", "загружено")}`].filter(Boolean).join(" · ");
    return { name, ids: rows.map(row => row.id), open: names.length === 1 || rows.length <= 6, summary };
  });
}

/** A short tag for a document type in the list («Инвойс» → «ИНВ»). */
export function typeTag(typeName: string): string {
  const known: Record<string, string> = { "Инвойс": "ИНВ", "Упаковочный лист": "УЛ", "Спецификация": "СП", "CMR": "CMR", "ТТН": "ТТН", "СНТ": "СНТ",
    "Таможенная декларация": "ДТ", "Таможенный документ": "ТД", "Сертификат": "СЕР", "Договор-заявка на перевозку": "ДЗ", "Макет стикера": "СТ",
    "Файл кодов маркировки": "ЧЗ", "Контракт с поставщиком": "КП", "Контракт с клиентом": "КК", "Гарантийное письмо": "ГП", "Накладная": "НАК" };
  return known[typeName] ?? (typeName.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").slice(0, 2).map(word => word[0]?.toLocaleUpperCase("ru") ?? "").join("") || "ДОК");
}
