import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type sql from "mssql";

import { runBounded } from "./queryRunner.js";

/**
 * The two bounds, on a fake `Request`.
 *
 * `timeoutMs` did nothing at all before this: `mssql` has no per-request timeout, so the
 * `request.timeout = …` it used assigned a property the driver never reads. A query asked to
 * finish in 2s ran for 17s and returned normally. Nothing caught it because nothing here could run
 * without a database — this fake is what makes both bounds testable in CI.
 */

/** A `Request` that emits `count` rows at `intervalMs`, and settles when cancelled or done. */
function fakeRequest(count: number, intervalMs: number) {
  const emitter = new EventEmitter() as EventEmitter & {
    stream: boolean;
    arrayRowMode: boolean;
    cancel: () => void;
    cancelled: boolean;
  };
  emitter.stream = false;
  emitter.arrayRowMode = false;
  emitter.cancelled = false;
  emitter.cancel = () => {
    emitter.cancelled = true;
  };

  const start = () =>
    new Promise<sql.IResult<unknown>>((resolve, reject) => {
      emitter.emit("recordset", [{ name: "n", type: { name: "int" } }]);
      let sent = 0;
      const tick = setInterval(() => {
        if (emitter.cancelled) {
          clearInterval(tick);
          // What the driver does: the in-flight statement rejects with `Canceled.`
          reject(Object.assign(new Error("Canceled."), { code: "ECANCEL" }));
          return;
        }
        if (sent >= count) {
          clearInterval(tick);
          resolve({ recordsets: [], recordset: undefined, output: {}, rowsAffected: [count] } as unknown as sql.IResult<unknown>);
          return;
        }
        sent += 1;
        emitter.emit("row", [sent]);
      }, intervalMs);
    });

  return { request: emitter as unknown as sql.Request, start, emitter };
}

test("the row cap truncates, and says so without claiming a timeout", async () => {
  const { request, start } = fakeRequest(50, 1);
  const result = await runBounded(request, start, { maxRows: 5, timeoutMs: 10_000 });
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false, "a row cap is not a timeout");
  assert.equal(result.recordsets[0]?.rows.length, 5);
});

test("the timeout cancels, returns the rows already read, and says which bound it hit", async () => {
  // 200 rows at 2ms each is ~400ms of work; the budget is 60ms.
  const { request, start } = fakeRequest(200, 2);
  const result = await runBounded(request, start, { maxRows: 10_000, timeoutMs: 60 });
  assert.equal(result.timedOut, true);
  assert.equal(result.truncated, false, "timing out is not hitting the row cap");
  assert.ok((result.recordsets[0]?.rows.length ?? 0) > 0, "partial rows must survive the cancel");
  assert.ok(result.elapsedMs < 350, `expected to stop near the budget, took ${String(result.elapsedMs)}ms`);
});

test("a query that finishes inside its budget reports neither flag", async () => {
  const { request, start } = fakeRequest(3, 1);
  const result = await runBounded(request, start, { maxRows: 100, timeoutMs: 5_000 });
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.recordsets[0]?.rows.length, 3);
});

test("a genuine failure is still thrown, not disguised as a cancellation", async () => {
  const { request } = fakeRequest(0, 1);
  await assert.rejects(
    runBounded(request, () => Promise.reject(new Error("Invalid object name 'dbo.Nope'.")), {
      maxRows: 10,
      timeoutMs: 5_000
    }),
    /Invalid object name/
  );
});

test("the timer is cleared, so a fast query leaves nothing pending", async () => {
  // A leaked timer would keep the process alive; node:test fails the run if handles remain.
  const { request, start } = fakeRequest(1, 1);
  await runBounded(request, start, { maxRows: 10, timeoutMs: 30_000 });
});
