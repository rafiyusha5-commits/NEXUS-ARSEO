import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicError, publicErrorMessage } from "../../src/lib/errors/public-message.ts";

describe("public error messages", () => {
  it("maps known database errors without exposing provider details", () => {
    const error = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "contracts_number_key"',
      details: "Key (number)=(secret) already exists",
    };

    assert.equal(publicErrorMessage(error), "Такая запись уже существует.");
    assert.doesNotMatch(publicErrorMessage(error), /contracts|secret|duplicate/i);
  });

  it("uses an explicit safe fallback for unknown errors", () => {
    const error = {
      code: "XX000",
      message: "relation private.supplier_prices does not exist",
      hint: "Run privileged SQL",
    };

    assert.equal(publicErrorMessage(error, "Не удалось сохранить договор."), "Не удалось сохранить договор.");
  });

  it("maps access, session, relation and validation failures", () => {
    assert.equal(publicErrorMessage({ code: "42501" }), "Недостаточно прав для этого действия.");
    assert.equal(publicErrorMessage({ status: 401 }), "Сессия истекла. Войдите снова.");
    assert.equal(publicErrorMessage({ code: "23503" }), "Действие невозможно: запись связана с другими данными.");
    assert.equal(publicErrorMessage({ code: "23514" }), "Проверьте заполненные данные.");
  });

  it("keeps messages explicitly marked as safe by the application", () => {
    assert.equal(publicErrorMessage(new PublicError("Укажите плановую дату.")), "Укажите плановую дату.");
    assert.equal(publicErrorMessage(new Error("relation private.secret does not exist")), "Не удалось выполнить действие. Повторите попытку.");
  });
});
