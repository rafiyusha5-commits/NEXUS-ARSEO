import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appOrigin, safeNextPath } from "../../src/lib/auth/redirect.ts";

const ORIGIN = "https://nexus.example.kz";
const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

describe("path after the sign-in link", () => {
  it("keeps paths of this site", () => {
    assert.equal(safeNextPath("/update-password", ORIGIN), "/update-password");
    assert.equal(safeNextPath("/shipments/1?tab=documents#check", ORIGIN), "/shipments/1?tab=documents#check");
    assert.equal(safeNextPath("/a/../update-password", ORIGIN), "/update-password");
    assert.equal(safeNextPath("/%5Cevil.example", ORIGIN), "/%5Cevil.example", "an encoded backslash stays a path of this site");
  });

  it("never leads to another site", () => {
    for (const value of ["/\\evil.example", "/\\/evil.example", "//evil.example", "///evil.example", "https://evil.example", "evil.example",
      "/\tevil", "/\n/evil.example", "\\\\evil.example", "", null, undefined]) {
      assert.equal(safeNextPath(value as string | null | undefined, ORIGIN), "/", String(value));
    }
  });
});

describe("address for e-mail links", () => {
  it("uses the configured address and ignores the Origin header", () => {
    assert.equal(appOrigin({ APP_ORIGIN: "https://nexus.example.kz/" }, headers({ origin: "https://evil.example", host: "evil.example" })), ORIGIN);
    assert.equal(appOrigin({ APP_ORIGIN: " https://nexus.example.kz " }, headers({})), ORIGIN);
  });

  it("falls back to the host the request reached, not to Origin", () => {
    assert.equal(appOrigin({}, headers({ origin: "https://evil.example", host: "nexus.example.kz" })), ORIGIN);
    assert.equal(appOrigin({}, headers({ "x-forwarded-host": "nexus.example.kz", "x-forwarded-proto": "https", host: "internal:3000" })), ORIGIN);
    assert.equal(appOrigin({}, headers({ host: "localhost:3000" })), "http://localhost:3000");
    assert.equal(appOrigin({ APP_ORIGIN: "ftp://other.example.kz" }, headers({ host: "nexus.example.kz" })), ORIGIN, "an invalid setting is not used");
    assert.equal(appOrigin({ APP_ORIGIN: "https://other.example.kz/path" }, headers({ host: "nexus.example.kz" })), ORIGIN, "a setting with a path is not used");
    assert.equal(appOrigin({}, headers({ host: "evil.example/@x" })), "http://localhost:3000", "a malformed host is not used");
  });
});
