/**
 * Minimal protobuf writer, for tests only.
 *
 * Lets the reader be exercised against hand-crafted payloads — unknown fields,
 * unpacked repeated values, multi-byte varints — which cannot be produced by
 * asking a real indexer nicely.
 */
export class TestBinaryWriter {
  private readonly chunks: number[] = [];

  varint(value: number | bigint): this {
    let remaining = BigInt(value);
    if (remaining < 0n) remaining = BigInt.asUintN(64, remaining);

    do {
      const byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      this.chunks.push(remaining > 0n ? byte | 0x80 : byte);
    } while (remaining > 0n);

    return this;
  }

  tag(fieldNumber: number, wireType: number): this {
    return this.varint((fieldNumber << 3) | wireType);
  }

  int32Field(fieldNumber: number, value: number): this {
    return this.tag(fieldNumber, 0).varint(value);
  }

  boolField(fieldNumber: number, value: boolean): this {
    return this.tag(fieldNumber, 0).varint(value ? 1 : 0);
  }

  bytesField(fieldNumber: number, bytes: Uint8Array): this {
    this.tag(fieldNumber, 2).varint(bytes.length);
    this.chunks.push(...bytes);
    return this;
  }

  stringField(fieldNumber: number, value: string): this {
    return this.bytesField(fieldNumber, new TextEncoder().encode(value));
  }

  messageField(fieldNumber: number, build: (writer: TestBinaryWriter) => void): this {
    const nested = new TestBinaryWriter();
    build(nested);
    return this.bytesField(fieldNumber, nested.finish());
  }

  /** proto3 default encoding for `repeated int32`. */
  packedInt32Field(fieldNumber: number, values: number[]): this {
    const nested = new TestBinaryWriter();
    for (const value of values) nested.varint(value);
    return this.bytesField(fieldNumber, nested.finish());
  }

  /** The legacy encoding: one tagged varint per element. */
  unpackedInt32Field(fieldNumber: number, values: number[]): this {
    for (const value of values) this.int32Field(fieldNumber, value);
    return this;
  }

  fixed64Field(fieldNumber: number, value: number): this {
    this.tag(fieldNumber, 1);
    for (let index = 0; index < 8; index += 1) {
      this.chunks.push((value >>> (index * 8)) & 0xff);
    }
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}
