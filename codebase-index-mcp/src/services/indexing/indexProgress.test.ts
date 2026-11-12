import assert from "node:assert/strict";
import test from "node:test";

import { createIndexProgress } from "./indexProgress.js";

type Frame = { progress: number; total: number | undefined; message: string };

const recorder = (): { frames: Frame[]; sink: (progress: number, total: number | undefined, message: string) => void } => {
  const frames: Frame[] = [];
  return { frames, sink: (progress, total, message) => frames.push({ progress, total, message }) };
};

test("IX-A(2): a phase change before any file total is known is sent, with no total", () => {
  const { frames, sink } = recorder();
  const p = createIndexProgress("r", sink);
  p.phase("scanning");
  assert.deepEqual(frames, [{ progress: 1, total: undefined, message: "r: scanning" }]);
  // A throttled counter update with no total is still not sent.
  p.update({ symbols: 3 });
  assert.equal(frames.length, 1);
});

test("IX-A(2): a scoped run with nothing to index reports each phase, progress strictly increasing", () => {
  const { frames, sink } = recorder();
  const p = createIndexProgress("r", sink);
  p.phase("scanning");
  p.phase("indexing");
  p.update({ totalFiles: 0, filesScanned: 0, symbols: 0 });
  p.phase("resolving calls");
  assert.deepEqual(
    frames.map((f) => f.message),
    ["r: scanning", "r: indexing", "r: resolving calls"]
  );
  assert.ok(frames.every((f) => f.total === undefined));
  assert.ok(frames.every((f, i) => i === 0 || f.progress > (frames[i - 1]?.progress ?? 0)));
});

for (const totalFiles of [1, 4]) {
  test(`IX-A(2): after pre-index ticks the file scale (${String(totalFiles)} files) starts above them, never steps back, never passes its total`, () => {
    const { frames, sink } = recorder();
    const p = createIndexProgress("r", sink);
    // The pipeline's order: scanning, then indexing before the total is known, then the total.
    p.phase("scanning");
    p.phase("indexing");
    p.update({ totalFiles, filesScanned: 0 });
    p.update({ totalFiles, filesScanned: totalFiles });
    p.phase("resolving calls");
    p.stop("done");
    const scaled = frames.filter((f) => f.total !== undefined && f.message.includes("indexing"));
    assert.ok(scaled.length >= 1, `the first "0/N" frame is sent: ${JSON.stringify(frames)}`);
    assert.equal(scaled[0]?.message, `r: indexing 0% · 0/${String(totalFiles)} files · 0 symbols`);
    assert.ok(frames.every((f) => f.total === undefined || f.progress <= f.total), JSON.stringify(frames));
    assert.ok(frames.every((f, i) => i === 0 || f.progress >= (frames[i - 1]?.progress ?? 0)), `never steps back: ${JSON.stringify(frames)}`);
    const resolving = frames.find((f) => f.message.startsWith("r: resolving calls"));
    assert.ok(resolving && resolving.progress > (scaled[0]?.progress ?? 0), JSON.stringify(frames));
  });
}
