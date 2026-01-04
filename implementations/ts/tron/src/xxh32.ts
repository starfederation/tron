const PRIME1 = 0x9e3779b1 >>> 0;
const PRIME2 = 0x85ebca77 >>> 0;
const PRIME3 = 0xc2b2ae3d >>> 0;
const PRIME4 = 0x27d4eb2f >>> 0;
const PRIME5 = 0x165667b1 >>> 0;

const rotl32 = (value: number, count: number): number =>
  ((value << count) | (value >>> (32 - count))) >>> 0;

const round = (acc: number, input: number): number => {
  acc = (acc + Math.imul(input, PRIME2)) >>> 0;
  acc = rotl32(acc, 13);
  acc = Math.imul(acc, PRIME1) >>> 0;
  return acc;
};

const mergeRound = (acc: number, val: number): number => {
  acc ^= round(0, val);
  acc = (Math.imul(acc, PRIME1) + PRIME4) >>> 0;
  return acc;
};

const readUint32LE = (data: Uint8Array, offset: number): number =>
  (data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] << 24)) >>> 0;

export const xxh32 = (data: Uint8Array, seed = 0): number => {
  let p = 0;
  const length = data.length;
  let h32: number;

  if (length >= 16) {
    let v1 = (seed + PRIME1 + PRIME2) >>> 0;
    let v2 = (seed + PRIME2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME1) >>> 0;

    for (; p <= length - 16; p += 16) {
      v1 = round(v1, readUint32LE(data, p));
      v2 = round(v2, readUint32LE(data, p + 4));
      v3 = round(v3, readUint32LE(data, p + 8));
      v4 = round(v4, readUint32LE(data, p + 12));
    }

    h32 =
      (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>>
      0;
    h32 = mergeRound(h32, v1);
    h32 = mergeRound(h32, v2);
    h32 = mergeRound(h32, v3);
    h32 = mergeRound(h32, v4);
  } else {
    h32 = (seed + PRIME5) >>> 0;
  }

  h32 = (h32 + length) >>> 0;

  for (; p <= length - 4; p += 4) {
    h32 = (h32 + Math.imul(readUint32LE(data, p), PRIME3)) >>> 0;
    h32 = Math.imul(rotl32(h32, 17), PRIME4) >>> 0;
  }

  for (; p < length; p++) {
    h32 = (h32 + Math.imul(data[p], PRIME5)) >>> 0;
    h32 = Math.imul(rotl32(h32, 11), PRIME1) >>> 0;
  }

  h32 ^= h32 >>> 15;
  h32 = Math.imul(h32, PRIME2) >>> 0;
  h32 ^= h32 >>> 13;
  h32 = Math.imul(h32, PRIME3) >>> 0;
  h32 ^= h32 >>> 16;
  return h32 >>> 0;
};
