/**
 * Shaping a pipeline step log into a bounded tail.
 *
 * Its own module because the rule is subtle and was got wrong twice: once by
 * checking only the body length (which under-reports a cut when upstream honours
 * the Range) and once by reading a bare 206 as a cut (which over-reports one when
 * the requested tail is wider than the log). Keeping it here makes it testable
 * without a client, and keeps `pipelines.ts` under the file-size soft cap.
 */

/**
 * Keep at most `maxBytes` of the END of `text`.
 *
 * Cutting a byte range can land mid-character and mid-line, so when it does cut
 * the first partial line is dropped — a log tail that starts halfway through a
 * line reads as corrupt.
 */
export function tailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: dropPartialFirstLine(Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8")), truncated: true };
}

/**
 * Decide what the step log response should carry.
 *
 * `partial` is the upstream 206: the range was honoured, so `raw` is already a
 * tail even though it fits inside `maxBytes`. Reporting that as `truncated:false`
 * was a real bug — it is the common path, and the caller cannot otherwise tell
 * that the log's first line was sliced mid-sentence.
 */
export function shapeStepLog(
  raw: string,
  maxBytes: number,
  partial: boolean
): { text: string; truncated: boolean } {
  const local = tailBytes(raw, maxBytes);
  if (local.truncated) {
    return local;
  }
  return partial
    ? { text: dropPartialFirstLine(raw), truncated: true }
    : { text: raw, truncated: false };
}

/** A tail that starts mid-line reads as corrupt, so drop that fragment. */
function dropPartialFirstLine(text: string): string {
  const firstBreak = text.indexOf("\n");
  return firstBreak >= 0 ? text.slice(firstBreak + 1) : text;
}
