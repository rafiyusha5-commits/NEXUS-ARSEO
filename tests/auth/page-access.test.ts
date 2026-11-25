import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import ts from "typescript";
import { profileGate } from "../../src/lib/auth/signout.ts";

// requirePageUser (performance measurement 25.11.2026): after the Auth server confirms the user, the profile, the
// roles, the page's permission codes and the sidebar's unread counter are requested together — one round trip
// instead of three one after another. Synthetic client; every request answers only after all of them have started.
const nativeRequire = createRequire(import.meta.url);

type Call = { name: string; startedAfterUser: boolean };
function load(user: { id: string } | null, profile: Record<string, unknown>) {
  const calls: Call[] = [];
  let userConfirmed = false;
  const pending: Array<() => void> = [];
  // A request resolves only on the next "network tick", so requests started together finish together.
  const answer = <T>(name: string, value: T) => {
    calls.push({ name, startedAfterUser: userConfirmed });
    return new Promise<T>(resolve => { pending.push(() => resolve(value)); setTimeout(() => pending.splice(0).forEach(fn => fn()), 5); });
  };
  const query = (table: string) => {
    const chain = {
      select() { return chain; }, eq() { return chain; },
      maybeSingle: () => answer(table, { data: profile, error: null }),
      then: (resolve: (value: unknown) => unknown) => answer(table, { data: [{ app_roles: { id: "r", code: "director", name: "Директор" } }], error: null }).then(resolve),
    };
    return chain;
  };
  const client = {
    auth: { getUser: async () => { const result = await answer("auth.getUser", { data: { user } }); userConfirmed = true; return result; } },
    from: query,
    rpc: (name: string, args: { p_codes: string[] }) => answer(`rpc.${name}`, { data: args.p_codes.filter(code => code !== "denied.code"), error: null }),
  };
  const code = ts.transpileModule(readFileSync(new URL("../../src/lib/auth/access.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>> };
  new Function("require", "module", "exports", code)((id: string) => {
    if (id === "react") return { cache: <F>(fn: F) => fn };
    if (id === "next/navigation") return { redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } };
    if (id === "@/lib/supabase/server") return { createClient: async () => client };
    if (id === "@/lib/auth/access-permissions") return { grantsAll: () => true };
    if (id === "@/lib/auth/signout") return { profileGate };
    if (id === "@/lib/notifications/unread") return { unreadNotificationsCount: () => answer("notifications.unread", 0) };
    if (id === "@/lib/permissions") {
      return { loadPermissions: async (supabase: typeof client, codes: string[]) => {
        const { data } = await supabase.rpc("my_permissions", { p_codes: codes });
        return Object.fromEntries(codes.map(code => [code, data.includes(code)]));
      } };
    }
    return nativeRequire(id);
  }, mod, mod.exports);
  return { access: mod.exports, calls };
}

const employee = { id: "u1", is_active: true, user_type: "employee", counterparty_id: null };

describe("requirePageUser", () => {
  it("asks for the profile, roles, permissions and unread counter together, after the user is confirmed", async () => {
    const { access, calls } = load({ id: "u1" }, employee);
    const context = await access.requirePageUser(["shipments.view", "denied.code"]);
    assert.deepEqual(context.permissions, { "shipments.view": true, "denied.code": false });
    assert.deepEqual(calls.map(call => call.name).sort(), ["auth.getUser", "notifications.unread", "profiles", "rpc.my_permissions", "user_roles"]);
    assert.equal(calls[0].name, "auth.getUser", "the Auth server confirms the user first");
    assert.ok(calls.slice(1).every(call => call.startedAfterUser), "nothing is read before the user is confirmed");
    // One wave: all four started before any of them finished (each resolves on the same tick).
    assert.equal(new Set(calls.slice(1).map(call => call.startedAfterUser)).size, 1);
  });

  it("without permission codes asks for the profile, roles and the unread counter only", async () => {
    const { access, calls } = load({ id: "u1" }, employee);
    const context = await access.requirePageUser();
    assert.equal("permissions" in context, false);
    assert.deepEqual(calls.map(call => call.name).sort(), ["auth.getUser", "notifications.unread", "profiles", "user_roles"]);
  });

  it("sends a visitor without a session to the login page before reading anything", async () => {
    const { access, calls } = load(null, employee);
    await assert.rejects(access.requirePageUser(["shipments.view"]), /REDIRECT \/login/);
    assert.deepEqual(calls.map(call => call.name), ["auth.getUser"]);
  });

  it("sends a disabled employee to the sign-out link and a client representative to the portal, like requireUser", async () => {
    await assert.rejects(load({ id: "u1" }, { ...employee, is_active: false }).access.requirePageUser(["shipments.view"]), /REDIRECT \/auth\/signout/);
    await assert.rejects(load({ id: "u1" }, { ...employee, user_type: "external" }).access.requirePageUser(), /REDIRECT \/portal\/documents/);
    await assert.rejects(load({ id: "u1" }, { ...employee, user_type: "external" }).access.requireUser(), /REDIRECT \/portal\/documents/);
  });
});
