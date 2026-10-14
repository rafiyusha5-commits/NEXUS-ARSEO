import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectAll } from "../../src/lib/supabase/select-all.ts";

const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index }));

// A fake list behind an API that returns at most `cap` rows per request, as PostgREST does.
function source(all: { id: number }[], cap = 1000) {
  const calls: [number, number][] = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: all.slice(from, Math.min(to + 1, from + cap)), error: null };
  };
  return { page, calls };
}

describe("complete reference lists", () => {
  it("reads past the 1000 rows of one request", async () => {
    const list = source(rows(2500));
    const result = await selectAll(list.page);
    assert.equal(result.data?.length, 2500);
    assert.deepEqual(result.data?.map((row) => row.id).slice(998, 1002), [998, 999, 1000, 1001]);
    assert.deepEqual(list.calls, [[0, 999], [1000, 1999], [2000, 2999]]);
    assert.equal(result.truncated, false);
  });

  it("asks once for a short list and once more for a list of exactly one page", async () => {
    assert.deepEqual((await selectAll(source(rows(3)).page)).data, rows(3));
    const exact = source(rows(1000));
    assert.equal((await selectAll(exact.page)).data?.length, 1000);
    assert.deepEqual(exact.calls, [[0, 999], [1000, 1999]]);
    assert.deepEqual((await selectAll(source([]).page)).data, []);
  });

  it("returns the error of a page as a single request would", async () => {
    let call = 0;
    const result = await selectAll(async () => (++call === 2 ? { data: null, error: { message: "timeout" } } : { data: rows(1000), error: null }));
    assert.deepEqual(result, { data: null, error: { message: "timeout" }, truncated: false });
  });

  it("never exposes a partial list to imports or pages", async () => {
    const list = source(rows(2501));
    await assert.rejects(selectAll(list.page, 1000, 2500), /полный список не загружен/);
    assert.deepEqual(list.calls, [[0, 999], [1000, 1999], [2000, 2499], [2500,2500]]);
    assert.equal((await selectAll(source(rows(2500)).page, 1000, 2500)).data?.length, 2500);
    await assert.rejects(selectAll(source([]).page, 0), RangeError);
  });
});
