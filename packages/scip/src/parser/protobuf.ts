/**
 * A minimal protobuf wire-format reader.
 *
 * SCIP is distributed as a protobuf payload. Rather than pull in a code
 * generator and ship generated classes through the codebase, this reader
 * decodes the handful of messages SCIP defines and the result is immediately
 * normalised into our own types (see `scip-index.ts`). Nothing outside
 * `packages/scip/src/parser` ever sees a wire-level value.
 *
 * Only the two wire types SCIP uses are supported directly (varint and
 * length-delimited); the rest are skipped correctly so that a newer indexer
 * emitting unknown fields never breaks parsing.
 */

export const WireType = {
  Varint: 0,
  Fixed64: 1,
  LengthDelimited: 2,
  StartGroup: 3,
  EndGroup: 4,
  Fixed32: 5,
} as const;

export type WireTypeValue = (typeof WireType)[keyof typeof WireType];

export interface FieldTag {
  fieldNumber: number;
  wireType: WireTypeValue;
}

export class ProtobufParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = 'ProtobufParseError';
  }
}

const textDecoder = new TextDecoder('utf-8', { fatal: false });

export class BinaryReader {
  private cursor: number;
  private readonly end: number;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
    end: number = bytes.length,
  ) {
    this.cursor = start;
    this.end = end;
  }

  get offset(): number {
    return this.cursor;
  }

  hasMore(): boolean {
    return this.cursor < this.end;
  }

  /**
   * Reads a base-128 varint. Values up to 7 bytes are accumulated with plain
   * number arithmetic; longer encodings (which is how negative int32/int64 are
   * transmitted) fall back to BigInt so the sign survives.
   */
  private readVarintRaw(): bigint {
    let shift = 0;
    let smallResult = 0;
    let bigResult = 0n;
    let usingBig = false;

    for (let index = 0; index < 10; index += 1) {
      if (this.cursor >= this.end) {
        throw new ProtobufParseError('unexpected end of buffer reading varint', this.cursor);
      }
      const byte = this.bytes[this.cursor] as number;
      this.cursor += 1;

      if (!usingBig && shift >= 49) {
        usingBig = true;
        bigResult = BigInt(smallResult);
      }

      if (usingBig) {
        bigResult |= BigInt(byte & 0x7f) << BigInt(shift);
      } else {
        smallResult += (byte & 0x7f) * 2 ** shift;
      }

      shift += 7;

      if ((byte & 0x80) === 0) {
        return usingBig ? BigInt.asUintN(64, bigResult) : BigInt(smallResult);
      }
    }

    throw new ProtobufParseError('varint longer than 10 bytes', this.cursor);
  }

  readUint32(): number {
    return Number(BigInt.asUintN(32, this.readVarintRaw()));
  }

  readInt32(): number {
    return Number(BigInt.asIntN(32, this.readVarintRaw()));
  }

  readInt64AsNumber(): number {
    return Number(BigInt.asIntN(64, this.readVarintRaw()));
  }

  readBool(): boolean {
    return this.readVarintRaw() !== 0n;
  }

  readTag(): FieldTag {
    const key = this.readUint32();
    const fieldNumber = key >>> 3;
    const wireType = (key & 0b111) as WireTypeValue;
    if (fieldNumber === 0) {
      throw new ProtobufParseError('field number 0 is invalid', this.cursor);
    }
    return { fieldNumber, wireType };
  }

  private readLength(): number {
    const length = Number(this.readVarintRaw());
    if (length < 0 || this.cursor + length > this.end) {
      throw new ProtobufParseError(`length-delimited field overruns buffer (${length})`, this.cursor);
    }
    return length;
  }

  readBytes(): Uint8Array {
    const length = this.readLength();
    const slice = this.bytes.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return slice;
  }

  readString(): string {
    return textDecoder.decode(this.readBytes());
  }

  /** Returns a reader scoped to a nested message's bytes. */
  readMessage(): BinaryReader {
    const length = this.readLength();
    const reader = new BinaryReader(this.bytes, this.cursor, this.cursor + length);
    this.cursor += length;
    return reader;
  }

  /**
   * Reads `repeated int32` written either packed (proto3 default) or as
   * individual varints (what some older writers emit).
   */
  readPackedInt32(wireType: WireTypeValue, into: number[]): void {
    if (wireType === WireType.LengthDelimited) {
      const nested = this.readMessage();
      while (nested.hasMore()) {
        into.push(nested.readInt32());
      }
      return;
    }
    into.push(this.readInt32());
  }

  /** Advances past a field whose contents we do not care about. */
  skipField(wireType: WireTypeValue): void {
    switch (wireType) {
      case WireType.Varint:
        this.readVarintRaw();
        return;
      case WireType.Fixed64:
        this.cursor += 8;
        return;
      case WireType.LengthDelimited:
        this.readBytes();
        return;
      case WireType.Fixed32:
        this.cursor += 4;
        return;
      case WireType.StartGroup:
      case WireType.EndGroup:
        throw new ProtobufParseError('groups are not supported', this.cursor);
      default:
        throw new ProtobufParseError(`unknown wire type ${String(wireType)}`, this.cursor);
    }
  }
}
