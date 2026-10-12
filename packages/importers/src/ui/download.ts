/**
 * A `BlobPart` for bytes (copied only when they do not sit on a plain `ArrayBuffer`). Exported
 * files are saved through `ctx.services.fileSaver`: a download in browsers, the native save dialog
 * in the desktop app.
 */
export function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}
