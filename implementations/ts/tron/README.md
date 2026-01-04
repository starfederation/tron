# TRON TypeScript implementation

This package provides a TypeScript implementation of the TRON encoder/decoder
that works in browser, Bun, and Deno. It uses `Uint8Array` directly and avoids
Node-specific APIs.

## Install/use

Import from source (repo local):

```ts
import { encode, decode, detectDocType, fromJSON, toJSON } from "./src/index";
```

## API

- `encode(value: TronValue): Uint8Array`
- `decode(doc: Uint8Array, options?: DecodeOptions): TronValue`
- `detectDocType(doc: Uint8Array): "scalar" | "tree"`
- `fromJSON(input: string | Uint8Array): Uint8Array`
- `toJSON(doc: Uint8Array, options?: DecodeOptions): string`

`TronValue` supports: `null`, `boolean`, `number`, `bigint`, `string`, `Uint8Array`, arrays, and objects.

### i64 decoding

`DecodeOptions.i64` controls how i64 values are returned:

- `"auto"` (default): number if safe, bigint otherwise
- `"number"`: number only (throws if unsafe)
- `"bigint"`: bigint only

## JSON mapping

The JSON helpers follow the spec and Go behavior:

- `bin` values are encoded as JSON strings with `b64:` prefix.
- If a JSON string starts with `b64:` and the remainder is valid base64,
  it decodes to `bin`; otherwise it remains `txt`.

Note: `fromJSON`/`toJSON` use `atob`/`btoa` for base64 and therefore require
an environment that provides them (browser, Bun, Deno).

## Tests

```sh
bun test
```

## Bundle size

Bundle size depends on tree-shaking. Import only `encode`/`decode` if you want
minimal output. Measurements are taken with esbuild (ESM, minified, ES2020)
and brotli.
