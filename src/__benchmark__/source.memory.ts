import type { Source } from '../source.js';

export class SourceMemory implements Source {
  url: URL;
  data: ArrayBuffer;

  static toArrayBuffer(buf: Buffer | Uint8Array | ArrayBuffer): ArrayBuffer {
    if (buf instanceof ArrayBuffer) return buf;
    const buffer = buf.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error('SharedArrayBuffer is not supported');
    }
    if (buf.byteLength === buffer.byteLength) return buffer;
    return buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  constructor(bytes: Buffer | Uint8Array | ArrayBuffer) {
    this.url = new URL('memory://fake-file');
    this.data = SourceMemory.toArrayBuffer(bytes);
  }

  async fetch(offset: number, length?: number): Promise<ArrayBuffer> {
    // console.log('Fetch', offset, length);
    if (offset < 0) offset = this.data.byteLength + offset;
    return this.data.slice(offset, length == null ? undefined : offset + length);
  }
}
