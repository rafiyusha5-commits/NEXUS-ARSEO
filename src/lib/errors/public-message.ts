type ErrorLike = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const DEFAULT_MESSAGE = "Не удалось выполнить действие. Повторите попытку.";

/** Error text authored by the application and intentionally safe for users. */
export class PublicError extends Error {
  override readonly name = "PublicError";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as ErrorLike).code;
  return typeof value === "string" ? value : "";
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = (error as ErrorLike).statusCode ?? (error as ErrorLike).status;
  const value = typeof candidate === "string" ? Number(candidate) : candidate;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Converts server and database errors into messages that are safe to show in
 * the browser. Raw provider messages can contain SQL, table names, constraints
 * and policy details, so unknown errors deliberately use the supplied fallback.
 */
export function publicErrorMessage(error: unknown, fallback = DEFAULT_MESSAGE): string {
  if (error instanceof PublicError) return error.message;
  const code = errorCode(error);
  const status = errorStatus(error);

  if (status === 401 || code === "PGRST301") return "Сессия истекла. Войдите снова.";
  if (status === 403 || code === "42501") return "Недостаточно прав для этого действия.";
  if (status === 404 || code === "PGRST116") return "Запись не найдена или недоступна.";
  if (code === "23505") return "Такая запись уже существует.";
  if (code === "23503") return "Действие невозможно: запись связана с другими данными.";
  if (["23502", "23514", "22P02", "22003"].includes(code)) return "Проверьте заполненные данные.";

  return fallback;
}

/**
 * Business rules of the database raise exceptions with an authored Russian message ("Автомобиль с госномером … уже есть").
 * Those are meant for the employee and are shown as they are; every other database error keeps the generic fallback.
 */
export function ruleViolationMessage(error: unknown, fallback = DEFAULT_MESSAGE): string {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === "P0001" && typeof message === "string" && /^[А-ЯЁ]/.test(message) && message.length <= 300) return message;
  }
  return publicErrorMessage(error, fallback);
}
