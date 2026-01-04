import { decode, detectDocType, encode, fromJSON, toJSON } from "../src/index";

const roundtrip = (value: unknown) => decode(encode(value as never));

const expectBytesEqual = (a: Uint8Array, b: Uint8Array) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i]).toBe(b[i]);
  }
};

describe("tron encode/decode", () => {
  test("scalars", () => {
    expect(roundtrip(null)).toBeNull();
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
    expect(roundtrip(42)).toBe(42);
    expect(roundtrip(3.5)).toBe(3.5);
    expect(roundtrip("hello")).toBe("hello");
  });

  test("binary", () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const decoded = roundtrip(bytes) as Uint8Array;
    expect(decoded).toBeInstanceOf(Uint8Array);
    expectBytesEqual(decoded, bytes);
  });

  test("arrays and maps", () => {
    const value = {
      a: [1, 2, 3],
      b: { nested: true, items: ["x", "y"] },
      c: null,
    };
    expect(roundtrip(value)).toEqual(value);
  });

  test("empty array and map", () => {
    expect(roundtrip([])).toEqual([]);
    expect(roundtrip({})).toEqual({});
  });

  test("i64 as bigint", () => {
    const value = 123n;
    const encoded = encode(value);
    const decoded = decode(encoded, { i64: "bigint" });
    expect(decoded).toBe(123n);
  });

  test("i64 decode modes", () => {
    const safe = 9007199254740991n;
    const unsafe = 9007199254740993n;

    const safeDoc = encode(safe);
    const unsafeDoc = encode(unsafe);

    expect(decode(safeDoc)).toBe(Number(safe));
    expect(decode(unsafeDoc)).toBe(unsafe);

    expect(() => decode(unsafeDoc, { i64: "number" })).toThrow(
      "i64 value exceeds safe integer range",
    );

    expect(decode(safeDoc, { i64: "bigint" })).toBe(safe);
    expect(decode(unsafeDoc, { i64: "bigint" })).toBe(unsafe);
  });

  test("detect doc type", () => {
    expect(detectDocType(encode(1))).toBe("scalar");
    expect(detectDocType(encode([1, 2, 3]))).toBe("tree");
  });

  test("json roundtrip with b64 bin", () => {
    const json = JSON.stringify({ bin: "b64:AQID", text: "hi", nums: [1, 2, 3] });
    const doc = fromJSON(json);
    const decoded = decode(doc);
    expect(decoded).toHaveProperty("bin");
    const bin = (decoded as { bin: Uint8Array }).bin;
    expect(bin).toBeInstanceOf(Uint8Array);
    expectBytesEqual(bin, new Uint8Array([1, 2, 3]));

    const out = toJSON(doc);
    const parsed = JSON.parse(out) as { bin: string; text: string; nums: number[] };
    expect(parsed.bin).toBe("b64:AQID");
    expect(parsed.text).toBe("hi");
    expect(parsed.nums).toEqual([1, 2, 3]);
  });
});
