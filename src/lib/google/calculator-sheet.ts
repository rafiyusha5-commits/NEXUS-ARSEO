import "server-only";

import { createSign } from "node:crypto";
import { PublicError } from "@/lib/errors/public-message";
import type { Cell } from "@/lib/reference-import/normalize.ts";
import {
  calculatorValuesUrl,
  GOOGLE_SHEETS_READONLY_SCOPE,
  parseGoogleValues,
} from "@/lib/google/sheets-readonly";

export {
  CALCULATOR_SHEET_NAME,
  CALCULATOR_SOURCE_TITLE,
  CALCULATOR_SPREADSHEET_ID,
  GOOGLE_SHEETS_READONLY_SCOPE,
} from "@/lib/google/sheets-readonly";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FETCH_TIMEOUT_MS = 30_000;

type GoogleToken = { access_token?: unknown; expires_in?: unknown };

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function serviceAccount() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!email || !privateKey) {
    throw new PublicError("Google Sheets не настроен: добавьте служебный аккаунт только для чтения.");
  }
  if (!email.endsWith(".iam.gserviceaccount.com") || !privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new PublicError("Некорректная конфигурация служебного аккаунта Google Sheets.");
  }
  return { email, privateKey };
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.email,
    scope: GOOGLE_SHEETS_READONLY_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(account.privateKey))}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new PublicError("Google отклонил доступ служебного аккаунта к таблице.");
  const token = await response.json() as GoogleToken;
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new PublicError("Google не вернул токен чтения таблицы.");
  }
  const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 3600;
  cachedToken = { value: token.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cachedToken.value;
}

export async function readCalculatorSheet(): Promise<Cell[][]> {
  const token = await accessToken();
  const response = await fetch(calculatorValuesUrl(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 403 || response.status === 404) {
    throw new PublicError("Служебному аккаунту не выдан доступ Viewer к мастер-калькулятору.");
  }
  if (!response.ok) throw new PublicError("Не удалось прочитать мастер-калькулятор из Google Sheets.");
  try {
    return parseGoogleValues(await response.json());
  } catch (error) {
    throw new PublicError(error instanceof Error ? error.message : "Google Sheets вернул некорректный ответ.");
  }
}
