import { readFile, stat } from 'fs/promises';
import type { Source } from '../source.js';

export class TestFileSource implements Source {
  url: URL;
  data: Promise<Buffer>;

  constructor(fileName: URL) {
    this.url = fileName;
    this.data = readFile(this.url);
  }

  async fetch(offset: number, length: number): Promise<ArrayBuffer> {
    const fileData = await this.data;
    const buffer = fileData.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error('SharedArrayBuffer is not supported');
    }
    return buffer.slice(fileData.byteOffset + offset, fileData.byteOffset + offset + length);
  }

  get size(): Promise<number> {
    return Promise.resolve()
      .then(() => stat(this.url))
      .then((f) => f.size);
  }
}
