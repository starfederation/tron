import { xxh32 } from "./xxh32";

export type TronValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | TronValue[]
  | { [key: string]: TronValue };

export type DocType = "scalar" | "tree";

export type DecodeOptions = {
  i64?: "number" | "bigint" | "auto";
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const TRAILER_MAGIC = [0x54, 0x52, 0x4f, 0x4e]; // TRON
const SCALAR_MAGIC = [0x4e, 0x4f, 0x52, 0x54]; // NORT
const TRAILER_SIZE = 12;

enum ValueType {
  Nil = 0,
  Bit = 1,
  I64 = 2,
  F64 = 3,
  Txt = 4,
  Bin = 5,
  Arr = 6,
  Map = 7,
}

const TAG_NIL = 0x00;
const TAG_BIT_FALSE = 0x20;
const TAG_BIT_TRUE = 0x21;
const TAG_I64 = 0x40;
const TAG_F64 = 0x60;

enum NodeKind {
  Branch = 0,
  Leaf = 1,
}

enum KeyType {
  Arr = 0,
  Map = 1,
}

type EncodedValue = {
  type: ValueType;
  bool?: boolean;
  i64?: bigint;
  f64?: number;
  bytes?: Uint8Array;
  offset?: number;
  node?: MapNode | ArrayNode;
};

type MapEntry = {
  key: Uint8Array;
  value: EncodedValue;
  hash: number;
};

type MapNode = {
  kind: NodeKind;
  bitmap: number;
  entries?: MapEntry[];
  children?: MapNode[];
  bodyLen: number;
};

type ArrayEntry = {
  index: number;
  value: EncodedValue;
};

type ArrayNode = {
  kind: NodeKind;
  shift: number;
  bitmap: number;
  length: number;
  values?: EncodedValue[];
  children?: ArrayNode[];
  bodyLen: number;
};

class ByteWriter {
  private buf: Uint8Array;
  private length: number;

  constructor(initialCapacity = 0) {
    this.buf = new Uint8Array(initialCapacity);
    this.length = 0;
  }

  private ensure(additional: number): void {
    const required = this.length + additional;
    if (required <= this.buf.length) return;
    let nextCap = this.buf.length === 0 ? 64 : this.buf.length * 2;
    if (nextCap < required) nextCap = required;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  reserve(size: number): number {
    if (size < 0) throw new Error("negative reserve size");
    this.ensure(size);
    const offset = this.length;
    this.length += size;
    return offset;
  }

  view(offset: number, size: number): Uint8Array {
    return this.buf.subarray(offset, offset + size);
  }

  pushBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }

  size(): number {
    return this.length;
  }
}

const isPlainObject = (value: unknown): value is { [key: string]: TronValue } => {
  if (!value || typeof value !== "object") return false;
  if (value instanceof Uint8Array) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const typeFromTag = (tag: number): ValueType => ((tag >>> 5) & 0x07) as ValueType;

const lowBits = (tag: number): number => tag & 0x1f;

const isPacked = (tag: number): boolean => (tag & 0x10) !== 0;

const writeUint16LE = (buf: Uint8Array, offset: number, value: number): void => {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
};

const writeUint32LE = (buf: Uint8Array, offset: number, value: number): void => {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
};

const readUint16LE = (buf: Uint8Array, offset: number): number =>
  buf[offset] | (buf[offset + 1] << 8);

const readUint32LE = (buf: Uint8Array, offset: number): number =>
  (buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)) >>> 0;

const readBigInt64LE = (buf: Uint8Array, offset: number): bigint => {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  return view.getBigInt64(0, true);
};

const writeBigInt64LE = (buf: Uint8Array, offset: number, value: bigint): void => {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  view.setBigInt64(0, value, true);
};

const readFloat64LE = (buf: Uint8Array, offset: number): number => {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  return view.getFloat64(0, true);
};

const writeFloat64LE = (buf: Uint8Array, offset: number, value: number): void => {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  view.setFloat64(0, value, true);
};

const lengthBytes = (length: number): number => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("invalid length");
  }
  if (length <= 15) return 0;
  const l = BigInt(length);
  if (l <= 0xffn) return 1;
  if (l <= 0xffffn) return 2;
  if (l <= 0xffffffn) return 3;
  if (l <= 0xffffffffn) return 4;
  if (l <= 0xffffffffffn) return 5;
  if (l <= 0xffffffffffffn) return 6;
  if (l <= 0xffffffffffffffn) return 7;
  if (l <= 0xffffffffffffffffn) return 8;
  throw new Error("length too large");
};

const writeLength = (
  buf: Uint8Array,
  offset: number,
  prefix: number,
  length: number,
): number => {
  const n = lengthBytes(length);
  if (n === 0) {
    buf[offset] = (prefix | 0x10 | length) & 0xff;
    return 1;
  }
  buf[offset] = (prefix | (n & 0x0f)) & 0xff;
  let remaining = BigInt(length);
  for (let i = 0; i < n; i++) {
    buf[offset + 1 + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return 1 + n;
};

const decodeLength = (tag: number, buf: Uint8Array, offset: number): [number, number] => {
  if (isPacked(tag)) {
    return [tag & 0x0f, 0];
  }
  const n = tag & 0x0f;
  if (n < 1 || n > 8) {
    throw new Error(`invalid length-of-length: ${n}`);
  }
  if (offset + n > buf.length) {
    throw new Error("length-of-length bytes missing");
  }
  let length = 0;
  for (let i = 0; i < n; i++) {
    length += buf[offset + i] * 2 ** (8 * i);
  }
  if (!Number.isSafeInteger(length)) {
    throw new Error("length exceeds safe integer range");
  }
  return [length, n];
};

const offsetLength = (offset: number): number => {
  if (offset <= 0xff) return 1;
  if (offset <= 0xffff) return 2;
  if (offset <= 0xffffff) return 3;
  return 4;
};

const encodedBytesValueLen = (payloadLength: number): number =>
  1 + lengthBytes(payloadLength) + payloadLength;

const encodedOffsetValueLen = (offset: number): number => 1 + offsetLength(offset);

const encodedValueLen = (value: EncodedValue): number => {
  switch (value.type) {
    case ValueType.Nil:
    case ValueType.Bit:
      return 1;
    case ValueType.I64:
    case ValueType.F64:
      return 9;
    case ValueType.Txt:
    case ValueType.Bin:
      return encodedBytesValueLen(value.bytes?.length ?? 0);
    case ValueType.Arr:
    case ValueType.Map:
      return encodedOffsetValueLen(value.offset ?? 0);
    default:
      throw new Error("unknown value type");
  }
};

const writeBytesValue = (
  buf: Uint8Array,
  offset: number,
  type: ValueType,
  payload: Uint8Array,
): number => {
  const prefix = (type << 5) & 0xe0;
  const n = writeLength(buf, offset, prefix, payload.length);
  buf.set(payload, offset + n);
  return n + payload.length;
};

const writeOffsetValue = (
  buf: Uint8Array,
  offset: number,
  type: ValueType,
  valueOffset: number,
): number => {
  const len = offsetLength(valueOffset);
  const prefix = (type << 5) & 0xe0;
  const n = writeLength(buf, offset, prefix, len);
  buf[offset + n] = valueOffset & 0xff;
  if (len > 1) buf[offset + n + 1] = (valueOffset >>> 8) & 0xff;
  if (len > 2) buf[offset + n + 2] = (valueOffset >>> 16) & 0xff;
  if (len > 3) buf[offset + n + 3] = (valueOffset >>> 24) & 0xff;
  return n + len;
};

const writeValue = (buf: Uint8Array, offset: number, value: EncodedValue): number => {
  switch (value.type) {
    case ValueType.Nil:
      buf[offset] = TAG_NIL;
      return 1;
    case ValueType.Bit:
      buf[offset] = value.bool ? TAG_BIT_TRUE : TAG_BIT_FALSE;
      return 1;
    case ValueType.I64:
      buf[offset] = TAG_I64;
      writeBigInt64LE(buf, offset + 1, value.i64 ?? 0n);
      return 9;
    case ValueType.F64:
      buf[offset] = TAG_F64;
      writeFloat64LE(buf, offset + 1, value.f64 ?? 0);
      return 9;
    case ValueType.Txt:
    case ValueType.Bin:
      return writeBytesValue(buf, offset, value.type, value.bytes ?? new Uint8Array());
    case ValueType.Arr:
    case ValueType.Map:
      return writeOffsetValue(buf, offset, value.type, value.offset ?? 0);
    default:
      throw new Error("unknown value type");
  }
};

const appendNodeWithBodyLen = (
  builder: ByteWriter,
  kind: NodeKind,
  key: KeyType,
  entryCount: number,
  bodyLen: number,
): { body: Uint8Array; offset: number } => {
  if (bodyLen < 0) throw new Error("invalid body length");
  let nodeLen = 8 + bodyLen;
  const pad = (4 - (nodeLen % 4)) % 4;
  nodeLen += pad;
  if (nodeLen > 0xffffffff) throw new Error("node too large");
  if (builder.size() + nodeLen > 0xffffffff) throw new Error("document too large");
  const offset = builder.reserve(nodeLen);
  const node = builder.view(offset, nodeLen);
  const flags = (nodeLen | (kind & 0x1) | ((key & 0x1) << 1)) >>> 0;
  writeUint32LE(node, 0, flags);
  writeUint32LE(node, 4, entryCount >>> 0);
  if (pad !== 0) {
    node.fill(0, 8 + bodyLen, nodeLen);
  }
  return { body: node.subarray(8, 8 + bodyLen), offset };
};

const popcount16 = (value: number): number => {
  let x = value & 0xffff;
  x = x - ((x >>> 1) & 0x5555);
  x = (x & 0x3333) + ((x >>> 2) & 0x3333);
  x = (x + (x >>> 4)) & 0x0f0f;
  x = x + (x >>> 8);
  return x & 0x1f;
};

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

const maxDepth32 = 7;

const buildMapNode = (entries: MapEntry[], depth: number): MapNode => {
  if (entries.length === 0) {
    return { kind: NodeKind.Leaf, bitmap: 0, entries: [], bodyLen: 0 };
  }
  if (entries.length === 1) {
    const bodyLen =
      encodedBytesValueLen(entries[0].key.length) + encodedValueLen(entries[0].value);
    return { kind: NodeKind.Leaf, bitmap: 0, entries, bodyLen };
  }
  if (depth >= maxDepth32) {
    const sorted = [...entries].sort((a, b) => compareBytes(a.key, b.key));
    let bodyLen = 0;
    for (const entry of sorted) {
      bodyLen += encodedBytesValueLen(entry.key.length) + encodedValueLen(entry.value);
    }
    return { kind: NodeKind.Leaf, bitmap: 0, entries: sorted, bodyLen };
  }

  const groups: MapEntry[][] = Array.from({ length: 16 }, () => []);
  for (const entry of entries) {
    const slot = (entry.hash >>> (depth * 4)) & 0x0f;
    groups[slot].push(entry);
  }

  const activeSlots = groups.reduce((count, group) => (group.length > 0 ? count + 1 : count), 0);
  if (activeSlots === 1) {
    const slot = groups.findIndex((group) => group.length > 0);
    const child = buildMapNode(groups[slot], depth + 1);
    return {
      kind: NodeKind.Branch,
      bitmap: 1 << slot,
      children: [child],
      bodyLen: 0,
    };
  }

  const children: MapNode[] = [];
  let bitmap = 0;
  for (let slot = 0; slot < 16; slot++) {
    if (groups[slot].length === 0) continue;
    bitmap |= 1 << slot;
    children.push(buildMapNode(groups[slot], depth + 1));
  }

  return { kind: NodeKind.Branch, bitmap, children, bodyLen: 0 };
};

const resolveValueOffset = (builder: ByteWriter, value: EncodedValue): void => {
  if (value.type !== ValueType.Arr && value.type !== ValueType.Map) return;
  if (value.offset !== undefined) return;
  if (!value.node) throw new Error("missing node for offset value");
  value.offset =
    value.type === ValueType.Arr
      ? encodeArrayNode(builder, value.node as ArrayNode)
      : encodeMapNode(builder, value.node as MapNode);
};

const encodeMapNode = (builder: ByteWriter, node: MapNode): number => {
  if (node.kind === NodeKind.Leaf) {
    const entries = node.entries ?? [];
    let bodyLen = 0;
    for (const entry of entries) {
      resolveValueOffset(builder, entry.value);
      bodyLen += encodedBytesValueLen(entry.key.length) + encodedValueLen(entry.value);
    }
    const { body, offset } = appendNodeWithBodyLen(
      builder,
      NodeKind.Leaf,
      KeyType.Map,
      entries.length,
      bodyLen,
    );
    let p = 0;
    for (const entry of entries) {
      p += writeBytesValue(body, p, ValueType.Txt, entry.key);
      p += writeValue(body, p, entry.value);
    }
    return offset;
  }

  const children = node.children ?? [];
  const childOffsets = children.map((child) => encodeMapNode(builder, child));
  const bodyLen = 4 + 4 * childOffsets.length;
  const { body, offset } = appendNodeWithBodyLen(
    builder,
    NodeKind.Branch,
    KeyType.Map,
    childOffsets.length,
    bodyLen,
  );
  writeUint16LE(body, 0, node.bitmap);
  body[2] = 0;
  body[3] = 0;
  let p = 4;
  for (const childOffset of childOffsets) {
    writeUint32LE(body, p, childOffset);
    p += 4;
  }
  return offset;
};

const arrayRootShift = (length: number): number => {
  if (length === 0) return 0;
  let maxIndex = length - 1;
  let shift = 0;
  while ((maxIndex >>> shift) > 0x0f) {
    shift += 4;
  }
  return shift;
};

const buildArrayNode = (entries: ArrayEntry[], shift: number, length: number): ArrayNode => {
  if (shift % 4 !== 0) throw new Error("array node shift must be multiple of 4");
  if (entries.length === 0 && shift === 0) {
    return {
      kind: NodeKind.Leaf,
      shift: 0,
      bitmap: 0,
      length,
      values: [],
      bodyLen: 8,
    };
  }

  if (shift === 0) {
    let bitmap = 0;
    const slotValues: EncodedValue[] = new Array(16);
    for (const entry of entries) {
      const slot = entry.index & 0x0f;
      if (((bitmap >>> slot) & 1) === 1) {
        throw new Error(`duplicate index in slot ${slot}`);
      }
      bitmap |= 1 << slot;
      slotValues[slot] = entry.value;
    }
    const count = popcount16(bitmap);
    const values: EncodedValue[] = new Array(count);
    let idx = 0;
    let bodyLen = 8;
    for (let slot = 0; slot < 16; slot++) {
      if (((bitmap >>> slot) & 1) === 0) continue;
      const value = slotValues[slot];
      values[idx] = value;
      bodyLen += encodedValueLen(value);
      idx++;
    }
    return { kind: NodeKind.Leaf, shift: 0, bitmap, length, values, bodyLen };
  }

  const groups: ArrayEntry[][] = Array.from({ length: 16 }, () => []);
  for (const entry of entries) {
    const slot = (entry.index >>> shift) & 0x0f;
    groups[slot].push(entry);
  }

  const children: ArrayNode[] = [];
  let bitmap = 0;
  for (let slot = 0; slot < 16; slot++) {
    if (groups[slot].length === 0) continue;
    bitmap |= 1 << slot;
    children.push(buildArrayNode(groups[slot], shift - 4, 0));
  }

  return { kind: NodeKind.Branch, shift, bitmap, length, children, bodyLen: 0 };
};

const encodeArrayNode = (builder: ByteWriter, node: ArrayNode): number => {
  if (node.kind === NodeKind.Leaf) {
    const values = node.values ?? [];
    let bodyLen = 8;
    for (const value of values) {
      resolveValueOffset(builder, value);
      bodyLen += encodedValueLen(value);
    }
    const { body, offset } = appendNodeWithBodyLen(
      builder,
      NodeKind.Leaf,
      KeyType.Arr,
      values.length,
      bodyLen,
    );
    body[0] = node.shift;
    body[1] = 0;
    writeUint16LE(body, 2, node.bitmap);
    writeUint32LE(body, 4, node.length >>> 0);
    let p = 8;
    for (const value of values) {
      p += writeValue(body, p, value);
    }
    return offset;
  }

  const children = node.children ?? [];
  const childOffsets = children.map((child) => encodeArrayNode(builder, child));
  const bodyLen = 8 + 4 * childOffsets.length;
  const { body, offset } = appendNodeWithBodyLen(
    builder,
    NodeKind.Branch,
    KeyType.Arr,
    childOffsets.length,
    bodyLen,
  );
  body[0] = node.shift;
  body[1] = 0;
  writeUint16LE(body, 2, node.bitmap);
  writeUint32LE(body, 4, node.length >>> 0);
  let p = 8;
  for (const childOffset of childOffsets) {
    writeUint32LE(body, p, childOffset);
    p += 4;
  }
  return offset;
};

const valueFromAny = (value: TronValue): EncodedValue => {
  if (value === null) return { type: ValueType.Nil };
  if (typeof value === "boolean") return { type: ValueType.Bit, bool: value };
  if (typeof value === "string") {
    return { type: ValueType.Txt, bytes: textEncoder.encode(value) };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("number must be finite");
    }
    if (Number.isSafeInteger(value)) {
      const asBigInt = BigInt(value);
      if (asBigInt >= -(1n << 63n) && asBigInt <= (1n << 63n) - 1n) {
        return { type: ValueType.I64, i64: asBigInt };
      }
    }
    return { type: ValueType.F64, f64: value };
  }
  if (typeof value === "bigint") {
    if (value < -(1n << 63n) || value > (1n << 63n) - 1n) {
      throw new Error("bigint out of int64 range");
    }
    return { type: ValueType.I64, i64: value };
  }
  if (value instanceof Uint8Array) {
    return { type: ValueType.Bin, bytes: value };
  }
  if (Array.isArray(value)) {
    const entries: ArrayEntry[] = value.map((entry, index) => ({
      index,
      value: valueFromAny(entry),
    }));
    const length = value.length;
    const shift = arrayRootShift(length);
    const root = buildArrayNode(entries, shift, length);
    return { type: ValueType.Arr, node: root };
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      const root: MapNode = { kind: NodeKind.Leaf, bitmap: 0, entries: [], bodyLen: 0 };
      return { type: ValueType.Map, node: root };
    }
    const entries: MapEntry[] = [];
    for (const key of keys) {
      const val = valueFromAny(value[key]);
      const keyBytes = textEncoder.encode(key);
      entries.push({ key: keyBytes, value: val, hash: xxh32(keyBytes, 0) });
    }
    const root = buildMapNode(entries, 0);
    return { type: ValueType.Map, node: root };
  }

  throw new Error("unsupported value type");
};

export const encode = (value: TronValue): Uint8Array => {
  const builder = new ByteWriter();
  const root = valueFromAny(value);
  if (root.type === ValueType.Arr || root.type === ValueType.Map) {
    resolveValueOffset(builder, root);
    const trailer = new Uint8Array(TRAILER_SIZE);
    writeUint32LE(trailer, 0, root.offset ?? 0);
    writeUint32LE(trailer, 4, 0);
    trailer.set(TRAILER_MAGIC, 8);
    builder.pushBytes(trailer);
    return builder.finish();
  }

  const encoded = new Uint8Array(encodedValueLen(root));
  writeValue(encoded, 0, root);
  const out = new Uint8Array(encoded.length + 4);
  out.set(encoded, 0);
  out.set(SCALAR_MAGIC, encoded.length);
  return out;
};

const decodeValue = (
  doc: Uint8Array,
  offset: number,
  options: DecodeOptions,
): [TronValue, number] => {
  if (offset >= doc.length) throw new Error("value tag missing");
  const tag = doc[offset];
  const typ = typeFromTag(tag);

  switch (typ) {
    case ValueType.Nil:
      if (lowBits(tag) !== 0) throw new Error("nil tag has non-zero low bits");
      return [null, 1];
    case ValueType.Bit:
      if ((tag & 0x1e) !== 0) throw new Error("bit tag has invalid low bits");
      return [(tag & 0x01) === 1, 1];
    case ValueType.I64: {
      if (lowBits(tag) !== 0) throw new Error("i64 tag has non-zero low bits");
      if (offset + 9 > doc.length) throw new Error("i64 payload truncated");
      const value = readBigInt64LE(doc, offset + 1);
      const mode = options.i64 ?? "auto";
      if (mode === "bigint") {
        return [value, 9];
      }
      if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
        if (mode === "number") {
          throw new Error("i64 value exceeds safe integer range");
        }
        return [value, 9];
      }
      return [Number(value), 9];
    }
    case ValueType.F64: {
      if (lowBits(tag) !== 0) throw new Error("f64 tag has non-zero low bits");
      if (offset + 9 > doc.length) throw new Error("f64 payload truncated");
      return [readFloat64LE(doc, offset + 1), 9];
    }
    case ValueType.Txt:
    case ValueType.Bin:
    case ValueType.Arr:
    case ValueType.Map: {
      const [length, n] = decodeLength(tag, doc, offset + 1);
      const start = offset + 1 + n;
      const end = start + length;
      if (end > doc.length) throw new Error("payload too short");
      const payload = doc.subarray(start, end);
      switch (typ) {
        case ValueType.Txt:
          return [textDecoder.decode(payload), end - offset];
        case ValueType.Bin:
          return [payload.slice(), end - offset];
        case ValueType.Arr:
        case ValueType.Map: {
          if (length === 0 || length > 4) throw new Error("node offset length out of range");
          let off = 0;
          for (let i = 0; i < length; i++) {
            off |= payload[i] << (8 * i);
          }
          return [decodeTreeAtOffset(doc, off >>> 0, options), end - offset];
        }
      }
      break;
    }
    default:
      break;
  }
  throw new Error(`unknown value type ${typ}`);
};

type NodeHeader = {
  nodeLen: number;
  kind: NodeKind;
  keyType: KeyType;
  entryCount: number;
};

const readNodeHeader = (doc: Uint8Array, offset: number): NodeHeader => {
  if (offset + 8 > doc.length) throw new Error("node header too short");
  const raw = readUint32LE(doc, offset);
  const kind = (raw & 0x1) as NodeKind;
  const keyType = ((raw >>> 1) & 0x1) as KeyType;
  const nodeLen = raw & ~0x3;
  if (nodeLen < 8 || nodeLen % 4 !== 0) {
    throw new Error(`invalid node length: ${nodeLen}`);
  }
  const entryCount = readUint32LE(doc, offset + 4);
  if (offset + nodeLen > doc.length) throw new Error("node truncated");
  return { nodeLen, kind, keyType, entryCount };
};

const decodeArrayNode = (
  doc: Uint8Array,
  offset: number,
  baseIndex: number,
  out: TronValue[],
  options: DecodeOptions,
  counter: { filled: number },
): void => {
  const header = readNodeHeader(doc, offset);
  if (header.keyType !== KeyType.Arr) throw new Error("node is not an array");
  const nodeStart = offset + 8;
  if (header.nodeLen < 16) throw new Error("array node too small");
  const shift = doc[nodeStart];
  const reserved = doc[nodeStart + 1];
  if (reserved !== 0) throw new Error("array reserved must be 0");
  if (shift % 4 !== 0) throw new Error("array shift must be multiple of 4");
  const bitmap = readUint16LE(doc, nodeStart + 2);
  const entryCount = popcount16(bitmap);
  if (entryCount !== header.entryCount) throw new Error("entry_count mismatch with bitmap");

  if (header.kind === NodeKind.Leaf) {
    if (shift !== 0) throw new Error("array leaf shift must be 0");
    let p = nodeStart + 8;
    for (let slot = 0; slot < 16; slot++) {
      if (((bitmap >>> slot) & 1) === 0) continue;
      const [value, size] = decodeValue(doc, p, options);
      const index = baseIndex + slot;
      if (index >= out.length) throw new Error("array index out of bounds");
      out[index] = value;
      counter.filled++;
      p += size;
    }
    return;
  }

  let p = nodeStart + 8;
  for (let slot = 0; slot < 16; slot++) {
    if (((bitmap >>> slot) & 1) === 0) continue;
    const childOffset = readUint32LE(doc, p);
    p += 4;
    const childBase = baseIndex + slot * (1 << shift);
    decodeArrayNode(doc, childOffset, childBase, out, options, counter);
  }
};

const decodeMapNode = (
  doc: Uint8Array,
  offset: number,
  out: { [key: string]: TronValue },
  options: DecodeOptions,
): void => {
  const header = readNodeHeader(doc, offset);
  if (header.keyType !== KeyType.Map) throw new Error("node is not a map");
  const nodeStart = offset + 8;

  if (header.kind === NodeKind.Leaf) {
    let p = nodeStart;
    for (let i = 0; i < header.entryCount; i++) {
      const [keyVal, keySize] = decodeValue(doc, p, options);
      if (typeof keyVal !== "string") throw new Error("map leaf key must be txt");
      p += keySize;
      const [value, valueSize] = decodeValue(doc, p, options);
      p += valueSize;
      out[keyVal] = value;
    }
    return;
  }

  if (header.nodeLen < 12) throw new Error("map branch node too small");
  const bitmap = readUint16LE(doc, nodeStart);
  const reserved = readUint16LE(doc, nodeStart + 2);
  if (reserved !== 0) throw new Error("map branch reserved must be 0");
  const entryCount = popcount16(bitmap);
  if (entryCount !== header.entryCount) throw new Error("entry_count mismatch with bitmap");
  let p = nodeStart + 4;
  for (let slot = 0; slot < 16; slot++) {
    if (((bitmap >>> slot) & 1) === 0) continue;
    const childOffset = readUint32LE(doc, p);
    p += 4;
    decodeMapNode(doc, childOffset, out, options);
  }
};

const decodeTreeAtOffset = (
  doc: Uint8Array,
  offset: number,
  options: DecodeOptions,
): TronValue => {
  const header = readNodeHeader(doc, offset);
  if (header.keyType === KeyType.Arr) {
    const nodeStart = offset + 8;
    const length = readUint32LE(doc, nodeStart + 4);
    const out = new Array<TronValue>(length);
    const counter = { filled: 0 };
    decodeArrayNode(doc, offset, 0, out, options, counter);
    if (counter.filled !== length) {
      throw new Error("array index missing");
    }
    return out;
  }
  if (header.keyType === KeyType.Map) {
    const out: { [key: string]: TronValue } = {};
    decodeMapNode(doc, offset, out, options);
    return out;
  }
  throw new Error("unknown node type");
};

export const detectDocType = (doc: Uint8Array): DocType => {
  if (doc.length < 4) throw new Error("document too short");
  const tail = doc.subarray(doc.length - 4);
  if (
    tail[0] === SCALAR_MAGIC[0] &&
    tail[1] === SCALAR_MAGIC[1] &&
    tail[2] === SCALAR_MAGIC[2] &&
    tail[3] === SCALAR_MAGIC[3]
  ) {
    return "scalar";
  }
  if (
    tail[0] === TRAILER_MAGIC[0] &&
    tail[1] === TRAILER_MAGIC[1] &&
    tail[2] === TRAILER_MAGIC[2] &&
    tail[3] === TRAILER_MAGIC[3]
  ) {
    if (doc.length < TRAILER_SIZE) throw new Error("tree trailer too short");
    return "tree";
  }
  throw new Error("unknown document trailer");
};

export const decode = (doc: Uint8Array, options: DecodeOptions = {}): TronValue => {
  const docType = detectDocType(doc);
  if (docType === "scalar") {
    if (doc.length < 4) throw new Error("document too short");
    const payload = doc.subarray(0, doc.length - 4);
    const [value, size] = decodeValue(payload, 0, options);
    if (size !== payload.length) throw new Error("extra bytes after scalar value");
    return value;
  }

  const start = doc.length - TRAILER_SIZE;
  const rootOffset = readUint32LE(doc, start);
  const magic = doc.subarray(doc.length - 4);
  if (
    magic[0] !== TRAILER_MAGIC[0] ||
    magic[1] !== TRAILER_MAGIC[1] ||
    magic[2] !== TRAILER_MAGIC[2] ||
    magic[3] !== TRAILER_MAGIC[3]
  ) {
    throw new Error("missing TRON trailer magic");
  }
  return decodeTreeAtOffset(doc, rootOffset, options);
};
