import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applicationSecurityHeaders, contentSecurityPolicy, createNonce } from "../../src/lib/security/headers.ts";

const directive = (policy: string, name: string) => policy.split("; ").find((part) => part.startsWith(`${name} `));

describe("Content-Security-Policy with a nonce (K11)", () => {
  it("runs scripts only from this origin or with the nonce of the response", () => {
    const nonce = createNonce();
    const script = directive(contentSecurityPolicy(nonce), "script-src");
    assert.equal(script, `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    assert.ok(!script?.includes("unsafe-inline"), "no inline scripts without the nonce");
    assert.ok(!script?.includes("unsafe-eval"), "no eval in production");
  });

  it("allows eval only for the development runtime", () => {
    assert.match(directive(contentSecurityPolicy(createNonce(), true), "script-src") ?? "", / 'unsafe-eval'$/);
  });

  it("keeps the other limits of the policy", () => {
    const policy = contentSecurityPolicy(createNonce());
    for (const part of ["default-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"]) {
      assert.ok(policy.split("; ").includes(part), part);
    }
  });

  it("gives every response its own nonce and refuses a malformed one", () => {
    const nonces = new Set(Array.from({ length: 50 }, createNonce));
    assert.equal(nonces.size, 50);
    for (const nonce of nonces) assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
    assert.throws(() => contentSecurityPolicy("abc'; script-src *"), /Invalid CSP nonce/);
    assert.throws(() => contentSecurityPolicy(""), /Invalid CSP nonce/);
  });

  it("does not set a second, static policy for every response", () => {
    assert.ok(!applicationSecurityHeaders.some((header) => header.key === "Content-Security-Policy"));
  });
});
