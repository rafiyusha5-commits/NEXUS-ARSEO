// Optional Windows-friendly, isolated PostgreSQL/WASM validation. No sockets or secrets.
// PGLITE_MODULE points to an installed @electric-sql/pglite/dist/index.js outside the repo.
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = process.env.PGLITE_MODULE;
if (!modulePath) throw new Error("Set PGLITE_MODULE to a local PGlite installation");
const { PGlite } = await import(pathToFileURL(modulePath).href);
const { pgcrypto } = await import(pathToFileURL(resolve(dirname(modulePath), "contrib/pgcrypto.js")).href);
const db = new PGlite({ extensions: { pgcrypto } });
const sql = async path => {
  let text = (await readFile(resolve(root, path), "utf8")).replace(/^\\(?:set|echo)[^\n]*$/gm, "");
  for (const match of [...text.matchAll(/^\\ir\s+([^\r\n]+)$/gm)]) {
    const included = await sql(resolve(dirname(resolve(root, path)), match[1]));
    text = text.replace(match[0], () => included);
  }
  return text;
};
try {
  await db.exec(await sql("supabase/tests/supabase_stub.sql"));
  const migrations = (await readdir(resolve(root, "supabase/migrations"))).filter(n => n.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const grantsQuery = "select n.nspname,c.relname,p.privilege,has_table_privilege('service_role',c.oid,p.privilege) as allowed from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join unnest(array['select','insert','update','delete','truncate','references','trigger']) p(privilege) where n.nspname in ('public','private') and c.relkind in ('r','v','p') order by 1,2,3";
    const previousGrants = migration === "202609276300_telegram_delivery_authorization.sql" ? (await db.query(grantsQuery)).rows : null;
    if (migration === "202609276200_drive_archive_access.sql") await db.exec(await sql("supabase/tests/drive_access_cleanup.fixture.sql"));
    try { await db.exec(await sql(`supabase/migrations/${migration}`)); }
    catch (error) { console.error(`FAILED migration ${migration}: ${error.message}`); process.exitCode = 1; throw error; }
    if (previousGrants) assert.deepEqual((await db.query(grantsQuery)).rows, previousGrants, "delivery authorization never expands service_role table privileges");
  }
  for (const name of ["drive_archive_access.test.sql", "drive_catalog.test.sql", "drive_catalog_ocr.test.sql", "agent_assistant.test.sql", "agent_catalog.test.sql", "agent_drive_archive.test.sql", "agent_archivist_registry.test.sql", "telegram_reliability.test.sql", "telegram_delivery_authorization.test.sql", "inventory_operation_documents.test.sql", "shipment_calendar.test.sql", "security_audit.test.sql"]) {
    await db.exec(await sql(`supabase/tests/${name}`));
    console.log(`PASS ${name}`);
    // The legacy OCR queue test intentionally expects only its own synthetic files.
    if (name === "drive_archive_access.test.sql") await db.exec("delete from public.drive_catalog_files where file_id='Access_cleanup_doc'; delete from public.agent_runs where id='da000000-0000-4000-8000-000000000003'");
  }
  await db.exec(`insert into public.drive_catalog_files(file_id,name,folder_path,mime_type,ancestor_ids,source_modified_at,seen_run,content_status)
    values('Access_reapply_doc','Fresh','Fresh','text/plain',array['1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm'],'2026-10-11',gen_random_uuid(),'readable');
    insert into public.drive_catalog_text(file_id,source_modified_at,body) values('Access_reapply_doc','2026-10-11','Fresh safe text');`);
  await db.exec(await sql("supabase/migrations/202609276200_drive_archive_access.sql"));
  await db.exec(await sql("supabase/migrations/202609276300_telegram_delivery_authorization.sql"));
  await db.exec(`do $$begin assert (select body='Fresh safe text' from public.drive_catalog_text where file_id='Access_reapply_doc'),'reapplication preserves new text';end$$;`);
  await db.exec(await sql("supabase/tests/drive_archive_access.test.sql"));
  await db.exec(await sql("supabase/tests/telegram_delivery_authorization.test.sql"));
  console.log(`PASS all ${migrations.length} migrations; access/OCR tests; migration reapplication`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (error.detail) console.error(error.detail);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally { await db.close(); }
