import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { grantsAll } from "../../src/lib/auth/access-permissions.ts";

describe("administration rights come from the database", () => {
  it("allows only when every required right is granted", () => {
    assert.equal(grantsAll(["users.manage", "roles.manage"], ["roles.manage", "users.manage"], null), true);
    assert.equal(grantsAll(["roles.manage"], ["roles.manage"], null), true);
  });

  it("refuses a director whose users.manage is denied personally (my_permissions leaves it out)", () => {
    assert.equal(grantsAll(["users.manage", "roles.manage"], ["roles.manage"], null), false);
    assert.equal(grantsAll(["users.manage"], [], null), false);
  });

  it("refuses when the database answer is an error or unreadable", () => {
    assert.equal(grantsAll(["roles.manage"], ["roles.manage"], { message: "network" }), false);
    assert.equal(grantsAll(["roles.manage"], null, null), false);
    assert.equal(grantsAll(["roles.manage"], "roles.manage", null), false);
  });

  it("requires nothing when no right is named (pages that only show data protected by RLS)", () => {
    assert.equal(grantsAll([], null, null), true);
  });
});

describe("every administration action names its rights", () => {
  const files = ["src/app/admin/users/actions.ts", "src/app/admin/client-access/actions.ts", "src/app/admin/roles/actions.ts"];
  for (const file of files) {
    it(`${file}: each exported action checks rights before doing anything`, () => {
      const source = readFileSync(file, "utf8");
      const actions = [...source.matchAll(/export async function (\w+)\([^)]*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*([^\n]+)/g)];
      assert.ok(actions.length > 0, "actions found");
      for (const [, name, firstStatement] of actions) {
        assert.match(firstStatement, /requireAccessManager\(\[\s*"(users|roles)\.manage"/, `${name} must call requireAccessManager with its rights first`);
      }
    });
  }

  it("invitations check both rights before the server key is used", () => {
    for (const [file, action] of [["src/app/admin/users/actions.ts", "inviteUser"], ["src/app/admin/client-access/actions.ts", "inviteExternalClient"]]) {
      const source = readFileSync(file, "utf8");
      const body = source.slice(source.indexOf(`export async function ${action}(`));
      const check = body.indexOf('requireAccessManager(["users.manage", "roles.manage"])');
      assert.ok(check >= 0, `${action} checks users.manage and roles.manage`);
      assert.ok(check < body.indexOf("createAdminClient()"), `${action} checks rights before creating the server-key client`);
    }
  });
});
