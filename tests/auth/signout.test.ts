import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signoutDecision } from "../../src/lib/auth/signout.ts";

describe("sign-out by link (GET /auth/signout)", () => {
  it("does not end the session of an active employee: a link or image from another site cannot log them out", () => {
    assert.deepEqual(signoutDecision(true, { is_active: true }), { signOut: false, location: "/" });
  });

  it("signs out a disabled profile and explains why", () => {
    assert.deepEqual(signoutDecision(true, { is_active: false }), { signOut: true, location: "/login?error=disabled" });
  });

  it("treats a session without a readable profile as disabled, like requireUser does", () => {
    assert.deepEqual(signoutDecision(true, null), { signOut: true, location: "/login?error=disabled" });
  });

  it("sends a visitor without a session to the login page", () => {
    assert.deepEqual(signoutDecision(false, null), { signOut: false, location: "/login" });
  });
});
