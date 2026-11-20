import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { profileGate, signoutDecision } from "../../src/lib/auth/signout.ts";

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

describe("profile check of the protected pages", () => {
  it("lets an active profile in", () => {
    assert.equal(profileGate({ is_active: true }, null), "active");
  });

  it("sends a disabled or missing profile to the sign-out link", () => {
    assert.equal(profileGate({ is_active: false }, null), "signout");
    assert.equal(profileGate(null, null), "signout");
  });

  it("throws on a failed read instead of sending an active employee to the sign-out link and back home", () => {
    assert.throws(() => profileGate(null, { message: "timeout" }), /timeout/);
  });

  it("never loops: every profile the pages send to the sign-out link is signed out there", () => {
    for (const profile of [null, { is_active: false }, { is_active: true }]) {
      if (profileGate(profile, null) === "signout") assert.equal(signoutDecision(true, profile).signOut, true);
    }
  });
});
