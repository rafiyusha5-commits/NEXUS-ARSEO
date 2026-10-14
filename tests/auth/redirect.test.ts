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
    for (const value of ["/\\evil.example", "/\\/evil.example", "//evil.example", "///evil.example", "/a/..//evil.example", "/.//evil.example", "/%2e//evil.example", "https://evil.example", "evil.example",
      "/\tevil", "/\n/evil.example", "\\\\evil.example", "", null, undefined]) {
      assert.equal(safeNextPath(value as string | null | undefined, ORIGIN), "/", String(value));
      assert.equal(new URL(safeNextPath(value as string, ORIGIN), ORIGIN).origin, ORIGIN);
    }
  });
});

describe("address for e-mail links", () => {
  it("uses the configured address and ignores the Origin header", () => {
    assert.equal(appOrigin({ APP_ORIGIN: "https://nexus.example.kz/" }, headers({ origin: "https://evil.example", host: "evil.example" })), ORIGIN);
    assert.equal(appOrigin({ APP_ORIGIN: " https://nexus.example.kz " }, headers({})), ORIGIN);
  });

  it("requires a trusted configuration in production and rejects malformed settings", () => {
    const untrusted = headers({ host: "localhost:3000", "x-forwarded-host": "evil.example" });
    assert.throws(() => appOrigin({ NODE_ENV: "production" }, untrusted), /APP_ORIGIN/);
    for (const value of ["ftp://other.example", "https://other.example/path", "https://user:pass@other.example", "invalid"]) {
      assert.throws(() => appOrigin({ APP_ORIGIN: value }, untrusted), /APP_ORIGIN/);
    }
    assert.equal(appOrigin({}, untrusted), "http://localhost:3000");
    assert.throws(() => appOrigin({}, headers({ host: "evil.example" })), /APP_ORIGIN/);
  });
});
