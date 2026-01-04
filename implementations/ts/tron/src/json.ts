import { decode, encode } from "./codec";
import type { DecodeOptions, TronValue } from "./codec";
import { decodeBase64, encodeBase64 } from "./base64";

const textDecoder = new TextDecoder();

const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

const parseJSONValue = (value: unknown): TronValue => {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.startsWith("b64:")) {
      const decoded = decodeBase64(value.slice(4));
      if (decoded) return decoded;
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("json number must be finite");
    if (Number.isInteger(value)) {
      const asBigInt = BigInt(value);
      if (asBigInt >= MIN_I64 && asBigInt <= MAX_I64) {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => parseJSONValue(entry));
  }
  if (value && typeof value === "object") {
    const out: { [key: string]: TronValue } = {};
    for (const key of Object.keys(value)) {
      out[key] = parseJSONValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error("unsupported json value");
};

const stringifyJSONValue = (value: TronValue): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("number must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    return JSON.stringify(`b64:${encodeBase64(value)}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyJSONValue(entry)).join(",")}]`;
  }
  const keys = Object.keys(value);
  const parts = keys.map((key) => {
    const encodedKey = JSON.stringify(key);
    const encodedValue = stringifyJSONValue((value as Record<string, TronValue>)[key]);
    return `${encodedKey}:${encodedValue}`;
  });
  return `{${parts.join(",")}}`;
};

export const fromJSON = (input: string | Uint8Array): Uint8Array => {
  const jsonText = typeof input === "string" ? input : textDecoder.decode(input);
  const parsed = JSON.parse(jsonText) as unknown;
  const value = parseJSONValue(parsed);
  return encode(value);
};

export const toJSON = (doc: Uint8Array, options: DecodeOptions = {}): string => {
  const decodeOptions: DecodeOptions = { i64: options.i64 ?? "auto" };
  const value = decode(doc, decodeOptions);
  return stringifyJSONValue(value);
};
