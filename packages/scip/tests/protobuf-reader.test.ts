import { describe, expect, it } from 'vitest';
import { BinaryReader, ProtobufParseError, WireType, parseScipIndex } from '@ckg/scip';
import { TestBinaryWriter } from './helpers/protobuf-writer.js';

describe('BinaryReader', () => {
  it('reads single- and multi-byte varints exactly', () => {
    for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 2 ** 31 - 1]) {
      const reader = new BinaryReader(new TestBinaryWriter().varint(value).finish());
      expect(reader.readUint32()).toBe(value);
    }
  });

  it('sign-extends negative int32 sent as a 10-byte varint', () => {
    const reader = new BinaryReader(new TestBinaryWriter().varint(-7).finish());
    expect(reader.readInt32()).toBe(-7);
  });

  it('decodes UTF-8 strings, including multi-byte characters', () => {
    const reader = new BinaryReader(new TestBinaryWriter().stringField(1, 'héllo → 世界').finish());
    reader.readTag();
    expect(reader.readString()).toBe('héllo → 世界');
  });

  it('skips fields of every wire type it does not consume', () => {
    const bytes = new TestBinaryWriter()
      .int32Field(1, 42)
      .fixed64Field(2, 9)
      .stringField(3, 'ignored')
      .int32Field(4, 7)
      .finish();

    const reader = new BinaryReader(bytes);
    const seen: Array<[number, number]> = [];

    while (reader.hasMore()) {
      const { fieldNumber, wireType } = reader.readTag();
      if (fieldNumber === 1 || fieldNumber === 4) {
        seen.push([fieldNumber, reader.readInt32()]);
        continue;
      }
      reader.skipField(wireType);
    }

    expect(seen).toEqual([
      [1, 42],
      [4, 7],
    ]);
  });

  it('reads repeated int32 whether packed or unpacked', () => {
    for (const build of [
      (writer: TestBinaryWriter) => writer.packedInt32Field(1, [4, 8, 15]),
      (writer: TestBinaryWriter) => writer.unpackedInt32Field(1, [4, 8, 15]),
    ]) {
      const writer = new TestBinaryWriter();
      build(writer);
      const reader = new BinaryReader(writer.finish());

      const values: number[] = [];
      while (reader.hasMore()) {
        const { wireType } = reader.readTag();
        reader.readPackedInt32(wireType, values);
      }

      expect(values).toEqual([4, 8, 15]);
    }
  });

  it('refuses a length that runs past the end of the buffer', () => {
    // Field 1, length-delimited, claiming 200 bytes but carrying none.
    const bytes = Uint8Array.from([0x0a, 0xc8, 0x01]);
    const reader = new BinaryReader(bytes);
    reader.readTag();

    expect(() => reader.readBytes()).toThrow(ProtobufParseError);
  });

  it('exposes the wire types SCIP uses', () => {
    expect(WireType.Varint).toBe(0);
    expect(WireType.LengthDelimited).toBe(2);
  });
});

describe('parseScipIndex', () => {
  it('tolerates unknown fields from a newer indexer', () => {
    const bytes = new TestBinaryWriter()
      .messageField(1, (metadata) => {
        metadata.stringField(3, 'file:///repo');
        metadata.messageField(2, (tool) => {
          tool.stringField(1, 'scip-future');
          tool.stringField(2, '9.9.9');
        });
        // A field this parser has never heard of.
        metadata.stringField(99, 'something new');
      })
      .messageField(2, (document) => {
        document.stringField(1, 'src/a.ts');
        document.stringField(4, 'TypeScript');
        document.int32Field(77, 5);
      })
      .finish();

    const index = parseScipIndex(bytes);

    expect(index.metadata.toolInfo).toEqual({ name: 'scip-future', version: '9.9.9' });
    expect(index.documents).toHaveLength(1);
    expect(index.documents[0]?.relativePath).toBe('src/a.ts');
  });

  it('never surfaces document source text', () => {
    const bytes = new TestBinaryWriter()
      .messageField(2, (document) => {
        document.stringField(1, 'src/secret.ts');
        // Field 5 is Document.text — the file's full contents.
        document.stringField(5, 'const apiKey = "sk-live-do-not-store";');
      })
      .finish();

    const index = parseScipIndex(bytes);
    const document = index.documents[0];

    expect(document?.relativePath).toBe('src/secret.ts');
    expect(JSON.stringify(document)).not.toContain('sk-live');
  });

  it('accepts a three-element range as a single-line span', () => {
    const bytes = new TestBinaryWriter()
      .messageField(2, (document) => {
        document.stringField(1, 'src/a.ts');
        document.messageField(2, (occurrence) => {
          occurrence.packedInt32Field(1, [10, 4, 12]);
          occurrence.stringField(2, 'local 1');
          occurrence.int32Field(3, 1);
        });
      })
      .finish();

    expect(parseScipIndex(bytes).documents[0]?.occurrences[0]).toMatchObject({
      startLine: 10,
      startCharacter: 4,
      endLine: 10,
      endCharacter: 12,
      isDefinition: true,
    });
  });

  it('orders documents deterministically regardless of input order', () => {
    const build = (paths: string[]): Uint8Array => {
      const writer = new TestBinaryWriter();
      for (const relativePath of paths) {
        writer.messageField(2, (document) => document.stringField(1, relativePath));
      }
      return writer.finish();
    };

    const forwards = parseScipIndex(build(['a.ts', 'b.ts', 'c.ts']));
    const backwards = parseScipIndex(build(['c.ts', 'a.ts', 'b.ts']));

    expect(forwards.documents.map((d) => d.relativePath)).toEqual(
      backwards.documents.map((d) => d.relativePath),
    );
  });
});
