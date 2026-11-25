import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emailLinkNext, emailLinkToken, safeNextPath } from "../../src/lib/auth/redirect.ts";

describe("sign-in links of Auth e-mails", () => {
  it("accepts a token hash of a known type only", () => {
    assert.deepEqual(emailLinkToken("pkce_0123456789abcdef", "invite"), { tokenHash: "pkce_0123456789abcdef", type: "invite" });
    assert.deepEqual(emailLinkToken("0123456789abcdef", "recovery"), { tokenHash: "0123456789abcdef", type: "recovery" });
    assert.equal(emailLinkToken("0123456789abcdef", "sms"), null);
    assert.equal(emailLinkToken("0123456789abcdef", null), null);
    assert.equal(emailLinkToken("short", "invite"), null);
    assert.equal(emailLinkToken("has spaces and <tags>", "invite"), null);
    assert.equal(emailLinkToken(null, "invite"), null);
  });

  it("sends invitations and recovery to setting a password, other links where they asked", () => {
    assert.equal(emailLinkNext("invite", "/"), "/update-password");
    assert.equal(emailLinkNext("recovery", "/shipments"), "/update-password");
    assert.equal(emailLinkNext("magiclink", "/shipments"), "/shipments");
  });

  it("keeps the requested page inside Nexus", () => {
    assert.equal(safeNextPath("https://evil.example/", "https://nexus.example"), "/");
    assert.equal(safeNextPath("//evil.example", "https://nexus.example"), "/");
    assert.equal(safeNextPath("/update-password", "https://nexus.example"), "/update-password");
  });
});
