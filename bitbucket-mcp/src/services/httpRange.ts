/**
 * HTTP range plumbing for this server's one ranged request: a pipeline step log.
 *
 * Extracted from the client so `bitbucketClient.ts` stays under the file-size
 * soft cap, and because deciding "was this body a cut?" is a self-contained rule
 * worth testing on its own — it was got wrong once already.
 */

/** One HTTP attempt's outcome. `contentRange` is only set on a ranged response. */
export interface HttpOutcome {
  status: number;
  body: string;
  contentRange: string | null;
}

/**
 * The first byte offset a `Content-Range` describes, or 0 when there is none.
 *
 * `bytes 8033-9032/9033` -> 8033 (a real cut). `bytes 0-9032/9033` -> 0 (the
 * whole representation, returned because the suffix range was wider than it).
 */
export function rangeStartOffset(contentRange: string | null): number {
  if (!contentRange) {
    return 0;
  }
  const match = /^\s*bytes\s+(\d+)-/i.exec(contentRange);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}
