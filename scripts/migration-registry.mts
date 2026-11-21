/**
 * The migration registry of a database, private.applied_migrations (audit 2026-11-11, K3; 202611210600).
 *
 * Record migrations — prints SQL to run in the same session that applied them, or after a schema reconciliation:
 *   node --disable-warning=ExperimentalWarning scripts/migration-registry.mts record \
 *     --method applied|reconciled --by "<who>" [--from <first.sql>] [--until <last.sql>] [--note "<why>"]
 *
 * Compare a database with the repository — given the output of
 *   psql -At -F "<TAB>" -c "select name, sha256 from private.applied_migrations order by name"
 * prints the migrations not yet recorded and those recorded with another file content:
 *   node --disable-warning=ExperimentalWarning scripts/migration-registry.mts pending <registry.tsv>
 *
 * The file hash is SHA-256 of the file with line endings normalised to LF (as stored in Git).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIGRATION_NAME = /^[0-9]{12}_[a-z0-9_]+\.sql$/;
export type Migration = { name: string; sha256: string };

export function fileSha256(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function readMigrations(directory: string): Migration[] {
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => {
    if (!MIGRATION_NAME.test(name)) throw new Error(`Имя миграции не по правилу: ${name}`);
    return { name, sha256: fileSha256(readFileSync(join(directory, name), "utf8")) };
  });
}

/** The migrations from `from` to `until` inclusive, by name; unknown bounds are refused. */
export function selectRange(migrations: readonly Migration[], from?: string, until?: string): Migration[] {
  for (const bound of [from, until]) {
    if (bound && !migrations.some((item) => item.name === bound)) throw new Error(`Нет миграции ${bound}`);
  }
  return migrations.filter((item) => (!from || item.name >= from) && (!until || item.name <= until));
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** One transaction; a migration already recorded is left as it is (a repeated run adds nothing). */
export function recordSql(migrations: readonly Migration[], method: "applied" | "reconciled", by: string, note?: string): string {
  if (!migrations.length) throw new Error("Нет миграций для записи");
  if (by.trim().length < 2) throw new Error("Укажите, кто записывает миграции (--by)");
  const rows = migrations.map((item) =>
    `  (${literal(item.name)}, ${literal(item.sha256)}, ${literal(method)}, ${literal(by.trim())}, ${note ? literal(note) : "null"})`);
  return [
    "begin;",
    "insert into private.applied_migrations(name, sha256, method, recorded_by, note) values",
    rows.join(",\n"),
    "on conflict (name) do nothing;",
    "commit;",
    "",
  ].join("\n");
}

export type Pending = { pending: string[]; changed: string[]; unknown: string[] };

/** Repository migrations missing from the registry, recorded with another content, or recorded but not in the repository. */
export function comparePending(migrations: readonly Migration[], registryTsv: string): Pending {
  const recorded = new Map<string, string>();
  for (const line of registryTsv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, sha256] = line.split("\t");
    if (!name || !MIGRATION_NAME.test(name) || !/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw new Error(`Не строка реестра: ${line}`);
    recorded.set(name, sha256);
  }
  const known = new Set(migrations.map((item) => item.name));
  return {
    pending: migrations.filter((item) => !recorded.has(item.name)).map((item) => item.name),
    changed: migrations.filter((item) => recorded.has(item.name) && recorded.get(item.name) !== item.sha256).map((item) => item.name),
    unknown: [...recorded.keys()].filter((name) => !known.has(name)).sort(),
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [command, ...args] = process.argv.slice(2);
  try {
    const migrations = readMigrations(join(root, "supabase/migrations"));
    if (command === "record") {
      const method = option(args, "--method");
      if (method !== "applied" && method !== "reconciled") throw new Error("--method: applied или reconciled");
      process.stdout.write(recordSql(selectRange(migrations, option(args, "--from"), option(args, "--until")), method,
        option(args, "--by") ?? "", option(args, "--note")));
    } else if (command === "pending" && args[0]) {
      const result = comparePending(migrations, readFileSync(args[0], "utf8"));
      const show = (title: string, items: string[]) => { console.log(`${title}: ${items.length}`); for (const item of items) console.log(`  ${item}`); };
      show("Не записаны в реестре (не применены или не сверены)", result.pending);
      show("Записаны с другим содержимым файла", result.changed);
      show("Записаны, но нет в репозитории", result.unknown);
      process.exit(result.changed.length || result.unknown.length ? 1 : 0);
    } else {
      throw new Error("Команды: record --method applied|reconciled --by <кто> [--from] [--until] [--note]; pending <реестр.tsv>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
