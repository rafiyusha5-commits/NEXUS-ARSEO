import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { comparePending, fileSha256, readMigrations, recordSql, selectRange } from "../../scripts/migration-registry.mts";

const sha = (char: string) => char.repeat(64);
const migrations = [
  { name: "202611190100_a.sql", sha256: sha("a") },
  { name: "202611190200_b.sql", sha256: sha("b") },
  { name: "202611210500_c.sql", sha256: sha("c") },
];

describe("migration registry (K3)", () => {
  it("hashes a file the same with CRLF and LF line endings", () => {
    assert.equal(fileSha256("begin;\r\ncommit;\r\n"), fileSha256("begin;\ncommit;\n"));
    assert.match(fileSha256("x"), /^[0-9a-f]{64}$/);
  });

  it("reads every repository migration with a valid name", () => {
    const all = readMigrations(join(import.meta.dirname, "../../supabase/migrations"));
    assert.ok(all.length > 100);
    assert.ok(all.some((item) => item.name === "202611210600_migration_registry.sql"));
    assert.deepEqual(all.map((item) => item.name), [...all.map((item) => item.name)].sort());
  });

  it("selects a range by name and refuses unknown bounds", () => {
    assert.deepEqual(selectRange(migrations, undefined, "202611190200_b.sql").map((item) => item.name), ["202611190100_a.sql", "202611190200_b.sql"]);
    assert.deepEqual(selectRange(migrations, "202611190200_b.sql").map((item) => item.name), ["202611190200_b.sql", "202611210500_c.sql"]);
    assert.throws(() => selectRange(migrations, undefined, "202611200000_x.sql"), /Нет миграции/);
  });

  it("prints one idempotent insert with quoted values", () => {
    const sql = recordSql(migrations.slice(0, 1), "reconciled", "Owner's agent", "Сверка 21.11");
    assert.match(sql, /^begin;\ninsert into private\.applied_migrations/);
    assert.match(sql, /'Owner''s agent'/);
    assert.match(sql, /on conflict \(name\) do nothing;\ncommit;\n$/);
    assert.throws(() => recordSql([], "applied", "x y"), /Нет миграций/);
    assert.throws(() => recordSql(migrations, "applied", " "), /--by/);
  });

  it("finds pending, changed and unknown migrations", () => {
    const registry = `202611190100_a.sql\t${sha("a")}\n202611190200_b.sql\t${sha("f")}\n202611150000_old.sql\t${sha("d")}\n`;
    assert.deepEqual(comparePending(migrations, registry), {
      pending: ["202611210500_c.sql"], changed: ["202611190200_b.sql"], unknown: ["202611150000_old.sql"],
    });
    assert.throws(() => comparePending(migrations, "not a row"), /Не строка реестра/);
  });
});
