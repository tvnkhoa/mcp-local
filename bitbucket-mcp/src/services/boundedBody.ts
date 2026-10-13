/**
 * Read at most `maxBytes` of a response body.
 *
 * `response.text()` buffers the whole body, which is fine for JSON envelopes and
 * wrong for a file or a diff that can be tens of megabytes. This reads the
 * stream chunk by chunk and cancels it once the cap is passed, so memory stays
 * bounded by the cap whatever the server sends.
 */

export type BoundedText = {
  text: string;
  /** True when the body had more than `maxBytes` bytes and the rest was not read. */
  truncated: boolean;
  /** Bytes of body actually kept (≤ maxBytes). */
  bytesRead: number;
};

export async function readCapped(response: Response, maxBytes: number): Promise<BoundedText> {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (!response.body) {
    return { text: "", truncated: false, bytesRead: 0 };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const room = limit - kept;
    if (value.byteLength > room) {
      if (room > 0) {
        chunks.push(value.subarray(0, room));
        kept += room;
      }
      truncated = true;
      // Stop the download: the remainder is never wanted.
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    kept += value.byteLength;
  }

  // `stream: true` on a cut body holds back a trailing partial UTF-8 sequence
  // instead of emitting U+FFFD for it, so a cut never invents a character.
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  if (!truncated) {
    text += decoder.decode();
  }
  return { text, truncated, bytesRead: kept };
}
