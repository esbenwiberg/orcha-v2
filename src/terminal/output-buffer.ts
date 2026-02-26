export class OutputBuffer {
  private _chunks: Buffer[] = [];
  private _totalBytes: number = 0;
  private readonly _maxBytes: number;

  constructor(maxBytes: number = 512 * 1024) {
    this._maxBytes = maxBytes;
  }

  push(chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this._chunks.push(buf);
    this._totalBytes += buf.byteLength;

    while (this._totalBytes > this._maxBytes && this._chunks.length > 0) {
      const oldest = this._chunks.shift()!;
      this._totalBytes -= oldest.byteLength;
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this._chunks);
  }

  clear(): void {
    this._chunks = [];
    this._totalBytes = 0;
  }
}
