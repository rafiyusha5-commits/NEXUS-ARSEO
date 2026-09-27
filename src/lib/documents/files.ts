// File rules for the document module. Pure functions: no Next.js or Supabase imports,
// so they run in the browser (hints), on the server (enforcement) and in unit tests.

export const DOCUMENT_BUCKET = "nexus-documents";

// Vercel rejects serverless request bodies above ~4.5 MB, so uploads that go through
// server code are capped at 4 MB. The same limit is set on the Storage bucket and in the
// document_versions.file_size_bytes CHECK constraint.
export const MAX_DOCUMENT_FILE_SIZE_BYTES = 4 * 1024 * 1024;
export const MAX_DOCUMENT_FILE_SIZE_LABEL = "4 МБ";

type FileKind = {
  label: string;
  extensions: string[];
  mimeType: string;
  browserTypes: string[];
  signature: (bytes: Uint8Array) => boolean;
};

const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export const DOCUMENT_FILE_KINDS: Record<string, FileKind> = {
  pdf: {
    label: "PDF",
    extensions: ["pdf"],
    mimeType: "application/pdf",
    browserTypes: ["application/pdf"],
    signature: (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
  xlsx: {
    label: "XLSX",
    extensions: ["xlsx"],
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    browserTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    signature: (bytes) => startsWith(bytes, ZIP),
  },
  xls: {
    label: "XLS",
    extensions: ["xls"],
    mimeType: "application/vnd.ms-excel",
    browserTypes: ["application/vnd.ms-excel"],
    signature: (bytes) => startsWith(bytes, OLE),
  },
  csv: {
    label: "CSV",
    extensions: ["csv"],
    mimeType: "text/csv",
    browserTypes: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"],
    signature: (bytes) => !bytes.subarray(0, 8192).includes(0),
  },
  docx: {
    label: "DOCX",
    extensions: ["docx"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    browserTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    signature: (bytes) => startsWith(bytes, ZIP),
  },
  jpg: {
    label: "JPG",
    extensions: ["jpg", "jpeg"],
    mimeType: "image/jpeg",
    browserTypes: ["image/jpeg", "image/pjpeg"],
    signature: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  },
  png: {
    label: "PNG",
    extensions: ["png"],
    mimeType: "image/png",
    browserTypes: ["image/png"],
    signature: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
};

export const DOCUMENT_FILE_ACCEPT = Object.values(DOCUMENT_FILE_KINDS)
  .flatMap((kind) => kind.extensions.map((extension) => `.${extension}`))
  .join(",");

export const DOCUMENT_FILE_TYPES_LABEL = Object.values(DOCUMENT_FILE_KINDS)
  .map((kind) => kind.label)
  .join(", ");

export type FileCheck =
  | { ok: true; kind: string; extension: string; mimeType: string }
  | { ok: false; error: string };

function extensionOf(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function kindForExtension(extension: string) {
  return Object.entries(DOCUMENT_FILE_KINDS).find(([, kind]) =>
    kind.extensions.includes(extension),
  );
}

// Checks what the browser reported. The server must also call matchesFileSignature()
// on the actual bytes: the name and the reported type are controlled by the user.
export function checkDocumentFile(file: { name: string; size: number; type: string }): FileCheck {
  if (!file.name) return { ok: false, error: "Выберите файл" };
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "Файл пустой" };
  }
  if (file.size > MAX_DOCUMENT_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: `Файл больше ${MAX_DOCUMENT_FILE_SIZE_LABEL}. Уменьшите файл или разделите его на части`,
    };
  }

  const extension = extensionOf(file.name);
  const match = kindForExtension(extension);
  if (!match) {
    return {
      ok: false,
      error: `Недопустимый тип файла. Разрешены: ${DOCUMENT_FILE_TYPES_LABEL}`,
    };
  }

  const [kindKey, kind] = match;
  const reported = (file.type || "").toLowerCase().split(";")[0].trim();
  if (reported && reported !== "application/octet-stream" && !kind.browserTypes.includes(reported)) {
    return { ok: false, error: "Тип файла не совпадает с его расширением" };
  }

  return { ok: true, kind: kindKey, extension, mimeType: kind.mimeType };
}

export function matchesFileSignature(kind: string, bytes: Uint8Array) {
  const definition = DOCUMENT_FILE_KINDS[kind];
  return Boolean(definition) && definition.signature(bytes);
}

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ә: "a", ғ: "g", қ: "q", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i",
};

function transliterate(value: string) {
  return Array.from(value)
    .map((char) => {
      const lower = char.toLowerCase();
      const replacement = CYRILLIC[lower];
      if (replacement === undefined) return char;
      return char === lower ? replacement : replacement.charAt(0).toUpperCase() + replacement.slice(1);
    })
    .join("");
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

// Produces a Storage-safe file name: Latin letters, digits, dot, dash and underscore,
// no directories, at most 120 characters, extension kept. The original name is stored
// separately in the database for display.
export function normalizeFileName(name: string) {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFKC");
  const dot = base.lastIndexOf(".");
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const rawExtension = dot > 0 ? base.slice(dot + 1) : "";

  const clean = (value: string) =>
    transliterate(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/[-_.]{2,}/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "");

  const extension = clean(rawExtension).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
  const stem = clean(rawStem).slice(0, 100) || "document";
  const result = extension ? `${stem}.${extension}` : stem;
  return SAFE_NAME.test(result) ? result : "document";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RANDOM_HEX = /^[0-9a-f]{32}$/;
const STORAGE_PATH =
  /^documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

// The path is always built on the server from the document id and a random part;
// user input only contributes the already normalized file name.
export function buildDocumentStoragePath(documentId: string, safeFileName: string, randomHex: string) {
  if (!UUID.test(documentId)) throw new Error("Некорректный идентификатор документа");
  if (!RANDOM_HEX.test(randomHex)) throw new Error("Некорректная случайная часть пути");
  if (!SAFE_NAME.test(safeFileName)) throw new Error("Некорректное имя файла");
  return `documents/${documentId}/${randomHex}-${safeFileName}`;
}

export function isDocumentStoragePath(path: string, documentId?: string) {
  const match = STORAGE_PATH.exec(path);
  if (!match) return false;
  return documentId === undefined || match[1] === documentId;
}

export function formatFileSize(bytes: number | null | undefined) {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
  return `${(bytes / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}
