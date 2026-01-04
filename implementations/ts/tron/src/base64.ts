const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const lookup = (() => {
  const table = new Int16Array(128);
  table.fill(-1);
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
})();

export const encodeBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const trip = (b1 << 16) | (b2 << 8) | b3;

    out += alphabet[(trip >>> 18) & 0x3f];
    out += alphabet[(trip >>> 12) & 0x3f];
    out += i + 1 < bytes.length ? alphabet[(trip >>> 6) & 0x3f] : "=";
    out += i + 2 < bytes.length ? alphabet[trip & 0x3f] : "=";
  }
  return out;
};

export const decodeBase64 = (input: string): Uint8Array | null => {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || code === 32) return null;
  }

  let cleaned = input;
  const remainder = cleaned.length % 4;
  if (remainder === 1) return null;
  if (remainder === 2) cleaned += "==";
  if (remainder === 3) cleaned += "=";

  let pad = 0;
  if (cleaned.endsWith("==")) pad = 2;
  else if (cleaned.endsWith("=")) pad = 1;

  const outLen = (cleaned.length / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  for (let i = 0; i < cleaned.length; i += 4) {
    const c1 = cleaned.charCodeAt(i);
    const c2 = cleaned.charCodeAt(i + 1);
    const c3 = cleaned.charCodeAt(i + 2);
    const c4 = cleaned.charCodeAt(i + 3);

    if (c1 === 61 || c2 === 61) return null;

    const v1 = c1 < 128 ? lookup[c1] : -1;
    const v2 = c2 < 128 ? lookup[c2] : -1;
    if (v1 < 0 || v2 < 0) return null;

    const isPad3 = c3 === 61;
    const isPad4 = c4 === 61;
    if (isPad3 && !isPad4) return null;

    const v3 = isPad3 ? 0 : c3 < 128 ? lookup[c3] : -1;
    const v4 = isPad4 ? 0 : c4 < 128 ? lookup[c4] : -1;
    if (v3 < 0 || v4 < 0) return null;

    const trip = (v1 << 18) | (v2 << 12) | (v3 << 6) | v4;

    if (outIdx < outLen) out[outIdx++] = (trip >>> 16) & 0xff;
    if (!isPad3 && outIdx < outLen) out[outIdx++] = (trip >>> 8) & 0xff;
    if (!isPad4 && outIdx < outLen) out[outIdx++] = trip & 0xff;
  }

  return out;
};
