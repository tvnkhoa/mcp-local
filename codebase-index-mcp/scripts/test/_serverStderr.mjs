/**
 * _serverStderr.mjs — drain the server's stderr without throwing away its dying words.
 *
 * Every harness here spawns `dist/index.js` with `stderr: "pipe"`, and a piped stream that nobody
 * reads is a real failure mode on Windows: the OS buffer fills at 64 KB and the server blocks
 * mid-write. MCP-ISSUE-049 demonstrated that end to end in this repo. Two patterns grew up in
 * response, and **both lose information**:
 *
 *   - 7 harnesses drain nothing at all, so they are still exposed to the block.
 *   - 6 call `transport.stderr?.resume()`, which unblocks the pipe by DISCARDING every byte.
 *
 * The second is why the open "Connection closed" item has stayed undiagnosed. When the server dies,
 * Node writes the stack trace to stderr — and `resume()` throws it away, so the harness reports a
 * transport error with no cause attached. Six consecutive suite runs were spent hunting it and the
 * one that reproduced yielded nothing readable, in a harness that was "correctly" drained.
 *
 * So: always drain, keep the tail in memory, and print it when the process is about to exit
 * non-zero. Never blocks, never silent. `SHOW_SERVER_STDERR=1` streams it live instead.
 *
 *   import { attachServerStderr } from "./_serverStderr.mjs";
 *   attachServerStderr(transport);
 */

const TAIL_BYTES = 64 * 1024;

export function attachServerStderr(transport, label = "server") {
  const stream = transport?.stderr;
  if (!stream) return;

  let tail = "";
  const live = Boolean(process.env.SHOW_SERVER_STDERR);

  stream.on("data", (chunk) => {
    const text = chunk.toString();
    if (live) process.stderr.write(text);
    tail = (tail + text).slice(-TAIL_BYTES);
  });
  // A stream error must not be what takes the harness down.
  stream.on("error", () => {});

  process.on("exit", (code) => {
    if (code === 0 || live || tail.trim() === "") return;
    process.stderr.write(`\n--- ${label} stderr (last ${Math.min(tail.length, TAIL_BYTES)} bytes before exit ${code}) ---\n`);
    process.stderr.write(tail.endsWith("\n") ? tail : tail + "\n");
    process.stderr.write(`--- end ${label} stderr ---\n`);
  });
}
