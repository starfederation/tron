# TRie Object Notation (TRON) Spec (draft)

| Revision | Date       | Author                    | Info                                        |
| -------- | ---------- | ------------------------- | ------------------------------------------- |
| 0        | 2025-12-30 | @delaneyj                 | Initial design                              |
| 1        | 2026-01-04 | @delaneyj                 | Add JSON mapping                            |
| 2        | 2026-01-04 | @delaneyj, @oliverlambson | Fix xxh32 spec                              |
| 3        | 2026-01-05 | @delaneyj                 | Add JSON Merge Patch and JMESPath           |
| 4        | 2026-01-08 | @oliverlambson            | Annotate byte-level TRON example            |
| 5        | 2026-01-08 | @oliverlambson            | Reserve full u32 for HAMT bitmap            |
| 6        | 2026-01-08 | @oliverlambson            | Revise value tag header format              |
| 7        | 2026-01-09 | @oliverlambson            | Remove unnecessary reserved bytes           |
| 8        | 2026-01-10 | @oliverlambson            | Be explicit that all addresses are absolute |

This document defines the binary format for TRie Object Notation. It is intended to be compatible with JSON primitives while using HAMT (for maps) and vector tries (for arrays) to support fast in-place modifications without rewriting the entire document. The format targets transport and embedding as a single blob in databases or KV stores, not a database or storage engine itself.

## 1. Document layout

A TRie Object Notation (TRON) document is a self-contained blob and can be stored in a file, a database cell, or sent over the wire. It is one of:

- Scalar document: a single value record followed by the scalar terminator `NORT`.
- Tree document: HAMT/vector trie nodes and value payloads followed by the root record trailer.

All multi-byte values are little-endian.

## 2. Byte addressing

TRON document trees are traversed by following "address" values for bytes. An address is the absolute position of a byte within the docuement's byte buffer. Addresses are u32 values starting at 0x00 for the first byte of the buffer.

## 3. Root record trailer

The root record trailer lives at the end of a tree document (last 12 bytes). Writers append new nodes, then update the root record with the new root address. The previous root address allows walking the history backward. The magic `TRON` is the last 4 bytes of the document.

Trailer layout (from start of trailer):

```
Offset  Size  Field
0       4     Root node address (u32)
4       4     Prev root address (u32)
8       4     Magic "TRON"
```

Read flow:

- For tree documents, read the last 12 bytes and parse the trailer (magic is at the end).
- Read the root node at the address; the node header encodes its length.

Write flow (copy-on-write):

- Append new/updated nodes and values.
- Set prev root address to the prior root address.
- Update the root address in the trailer.
- Write the trailer last at the end of the document (so readers always see a complete root).

## 4. Scalar terminator

Scalar documents (top-level value is not `arr` or `map`) end with a 4-byte terminator `NORT`. The value record begins at byte 0 and runs up to the terminator. The terminator is not part of any payload.

Readers can distinguish formats by checking the tail:

- If the last 4 bytes are `NORT`, it is a scalar document.
- If the last 4 bytes are `TRON`, it is a tree document with a root record trailer.

## 5. Value tag header

Each value record begins with a 1-byte tag header. The top 3 bits encode the type, the lower 5 bits are type-specific.

| Field         | Bits            |
| ------------- | --------------- |
| Bit positions | 7 6 5 4 3 2 1 0 |
| Meaning       | x x x x x T T T |

- `TTT`: type (0-7)
- `x`: type-specific bits

**Packing rules:**

`nil`, `i64` and `f64` do not use any packing, the high 5 bits must be 0.

`bit` packs the boolean value into bit 3, the high 4 bits must be 0.

`txt` and `bin` use all 5 high bits: bit 3 is the isPacked flag. If isPacked=1, the high 4 bits hold the inline length 0..15. If isPacked=0, the high 4 bits (N) are the number of bytes that follow to encode the payload length; N must be 1..8. Read N bytes (little-endian) to get L. L is the byte length of the payload that follows.

`arr` and `map` use bit 3 and 4 encode M, where M+1 is the byte length of the payload that follows, the high 4 bits must be 0.

Type layouts and examples:

### nil (0b000)

Tag bits: `00000000` (0x00). No payload. Represents JSON null.

Example: `0x00`

### bit (0b001)

Tag bits: `0000b001` where `b` is the value bit (0=false, 1=true). Other low bits must be 0. Represents JSON boolean.

Examples:

- false: `0x01`
- true: `0x09`

### i64 (0b010)

Tag bits: `00000010` (0x02). Payload is fixed 8-byte two's complement, little-endian. Used for JSON numbers that fit in i64.

Example: 1234 -> tag `0x02`, payload `0xD2 0x04 0x00 0x00 0x00 0x00 0x00 0x00`

### f64 (0b011)

Tag bits: `00000011` (0x03). Payload is fixed 8-byte IEEE-754 binary64, little-endian. Used for JSON numbers that do not fit in i64.

Example: 1.5 -> tag `0x03`, payload `0x00 0x00 0x00 0x00 0x00 0x00 0xF8 0x3F`

### txt (0b100)

Tag bits: `llllP100` where `P` is isPacked and `llll` is inline length or N. Payload is always a UTF-8 encoded string of length L.

Example: "hi" (inline length 2) -> tag `0x2C`, payload `0x68 0x69`

### bin (0b101)

Tag bits: `llllP101` where `P` is isPacked and `llll` is inline length or N. Payload is raw bytes of length L.

Example: 3 bytes `0xAA 0xBB 0xCC` -> tag `0x3D`, payload `0xAA 0xBB 0xCC`

### arr (0b110)

Tag bits: `000ll110` where `ll + 1` is payload length. Payload is a node address (u32) encoded in L+1 bytes (1..4), little-endian.

Example: root node at address `0x10` -> tag `0x06`, payload `0x10`

### map (0b111)

Tag bits: `000ll111` where `ll + 1` is payload length. Payload is a node address (u32) encoded in L+1 bytes (1..4), little-endian.

Example: root node at address `0x20` -> tag `0x07`, payload `0x20`

## 6. HAMT (map) and vector trie (arr) nodes

Maps use a 16-way HAMT keyed by `xxh32` of the UTF-8 key bytes (seed=0). Arrays use a 16-way vector trie keyed by index bits. Nodes are variable-size and referenced by the node address stored in `arr` and `map` value records.

Node header:

```
Offset  Size  Field
0       4     Node length and flags (u32)
4       4     Entry count (u32)
```

- Bit 0 of the u32 indicates node kind: 0=branch, 1=leaf.
- Bit 1 indicates key type: 0=arr, 1=map.
- The remaining bits encode the node length in bytes (node_len = header_u32 & ~0x3).
- node_len includes the header, all entries, and optional zero padding. node_len must be a multiple of 4.

### Map nodes (HAMT)

Hashing:

- hash = `xxh32(key_bytes, seed=0)` interpreted as an unsigned u32
- slot = `(hash >> (depth * 4)) & 0xF`, where root depth is 0.

xxh32 (full algorithm):

```
PRIME1 = 0x9E3779B1
PRIME2 = 0x85EBCA77
PRIME3 = 0xC2B2AE3D
PRIME4 = 0x27D4EB2F
PRIME5 = 0x165667B1

rotl(x, r) = (x << r) | (x >> (32 - r))

round(acc, input):
  acc = acc + (input * PRIME2)
  acc = rotl(acc, 13)
  acc = acc * PRIME1
  return acc

xxh32(data, seed):
  p = 0
  len = data.length

  if len >= 16:
    v1 = seed + PRIME1 + PRIME2
    v2 = seed + PRIME2
    v3 = seed + 0
    v4 = seed - PRIME1
    while p <= len - 16:
      v1 = round(v1, read_u32_le(data, p)); p += 4
      v2 = round(v2, read_u32_le(data, p)); p += 4
      v3 = round(v3, read_u32_le(data, p)); p += 4
      v4 = round(v4, read_u32_le(data, p)); p += 4
    h32 = rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)
  else:
    h32 = seed + PRIME5

  h32 = h32 + len

  while p <= len - 4:
    h32 = h32 + (read_u32_le(data, p) * PRIME3); p += 4
    h32 = rotl(h32, 17) * PRIME4

  while p < len:
    h32 = h32 + (data[p] * PRIME5); p += 1
    h32 = rotl(h32, 11) * PRIME1

  h32 = h32 ^ (h32 >> 15)
  h32 = h32 * PRIME2
  h32 = h32 ^ (h32 >> 13)
  h32 = h32 * PRIME3
  h32 = h32 ^ (h32 >> 16)
  return h32
```

All arithmetic is modulo 2^32. `read_u32_le` reads 4 bytes little-endian.

Reference implementation: xxh32 MUST match Cyan4973/xxHash (release branch). Canonical test vectors are available in `shared/testdata/vectors/xxhash_sanity_test_vectors.json`, derived from `tests/sanity_test_vectors.h` in that repo.

Branch node layout (map):

```
Offset  Size  Field
8       4     Bitmap (u32) - note since there are max 16 slots, the upper 2 bytes are always 0
12      4*n   Child addresses (u32), ordered by slot index
```

- `entry_count` must equal popcount(bitmap).

Leaf node layout (map):

```
Offset  Size  Field
8       ?     Repeated entries: txt key record + value record
```

- `entry_count` is the number of key/value pairs.
- Key record tag must be `txt`; payload is the UTF-8 key bytes.
- Leaf entries are ordered by UTF-8 key bytes and keys are unique.

Hash collisions:

- When a leaf contains a single key and a new key lands in the same slot at this depth, the leaf is split into a branch and the two keys are placed in children based on the next hash nibble.
- This splitting continues until the keys diverge or max depth is reached.
- If two different keys have identical 32-bit hashes (full path collision), they cannot diverge; they are stored together in a single leaf at max depth.
- Lookups always compare full UTF-8 key bytes within the leaf to confirm equality (hash match alone is not sufficient).
- Map lookup/update/remove are O(d + c), where d is depth (<= 8 for 32-bit hashes with 4-bit chunks) and c is the number of colliding keys in the leaf bucket.

### Array nodes (vector trie)

Indexing:

- slot = `(index >> shift) & 0xF`
- shift is measured in bits and must be a multiple of 4.
- index is a u32.

Array node layout (arr):

```
Offset  Size  Field
8       1     Shift (u8)
9       2     Bitmap (u16)
11      4     Length (u32)
15      ?     Entries in slot order
```

- `entry_count` must equal popcount(bitmap).
- For branch nodes, entries are `u32 child_address`.
- For leaf nodes, entries are value records.
- Root node shift is chosen so the highest set bits of the maximum index are covered; for small arrays, shift may be 0.
- Child nodes use `shift - 4`. Leaf nodes must have shift=0.
- Array length is stored in the root node (shift may be 0). Valid indices are `0..length-1`.
- Append is defined as setting index = length; writers update length in the new root.
- Length is defined as max index + 1. When deleting the last element, length must shrink to the next highest existing index + 1.
- Length is meaningful only in the root node; non-root nodes must store 0.
- Array lookup/set/append are O(d), where d is depth (<= 8 for u32 indices with 4-bit chunks).
- Arrays may be sparse during updates; missing indices are treated as `nil` for logical operations. Canonical encoding must densify arrays by rewriting into a new document (filling missing indices with `nil`).

## 7. Update algorithms (pseudocode)

The following pseudocode describes logical updates. Implementations must use copy-on-write as described in section 8.

### Map (HAMT)

Helper functions:

```
slot(hash, depth) = (hash >> (depth * 4)) & 0xF
child_index(bitmap, slot) = popcount(bitmap & ((1 << slot) - 1))
max_depth = 7  // 32 bits / 4 bits per level
```

Lookup:

```
map_get(node, key, depth):
  if node.kind == LEAF:
    return linear_search(node.entries, key)
  s = slot(hash(key), depth)
  if ((node.bitmap >> s) & 1) == 0: return NOT_FOUND
  i = child_index(node.bitmap, s)
  return map_get(node.children[i], key, depth + 1)
```

Set/update:

```
map_set(node, key, value, depth):
  if node.kind == LEAF:
    if key exists: replace value and return node
    if depth == max_depth: insert key/value in order and return node
    // split leaf into branch when hashes diverge
    return leaf_to_branch(node, key, value, depth)
  s = slot(hash(key), depth)
  if bit not set:
    add new child leaf with key/value
  else:
    child = map_set(node.children[i], key, value, depth + 1)
    replace child in children
  update bitmap/entry_count and return new node
```

Delete:

```
map_del(node, key, depth):
  if node.kind == LEAF:
    remove key if present; return node (or EMPTY if no entries)
  s = slot(hash(key), depth)
  if bit not set: return node
  child = map_del(node.children[i], key, depth + 1)
  if child is EMPTY: remove slot bit and child
  update bitmap/entry_count and return node (or EMPTY if no children)
```

Collision handling:

- If multiple keys share the same hash path at max_depth, keep them in a single leaf sorted by UTF-8 key bytes.

Structural merge (maps):

TRON supports right-biased structural merge for maps. The result contains the union of keys; when the same key exists in both inputs, the right value wins. Unchanged subtrees are reused, so best-case merge time is proportional to the number of modified keys.

```
merge(nodeA, nodeB, depth):
  if nodeB.kind == LEAF:
    // small overlay, update A in place
    for each (k,v) in nodeB.entries:
      nodeA = map_set(nodeA, k, v, depth)
    return nodeA

  if nodeA.kind == LEAF:
    // right subtree is larger; clone B and only add missing keys from A
    node = clone(nodeB)
    for each (k,v) in nodeA.entries:
      if map_get(node, k, depth) == NOT_FOUND:
        node = map_set(node, k, v, depth)
    return node

  // both branches
  for slot in 0..15:
    if only A has slot: reuse A child
    if only B has slot: clone B child
    if both have slot: child = merge(A.child, B.child, depth + 1)
  if all children reused from A: return A
  return new branch node
```

Complexity:

- Best case O(changes) when inputs share most structure.
- Worst case O(n) when inputs are disjoint or have little shared structure.
- Hashing is only required for keys in leaf overlays and during `map_set`; branch-only traversal does not recompute hashes.

### Array (vector trie)

Helper functions:

```
slot(index, shift) = (index >> shift) & 0xF
child_index(bitmap, slot) = popcount(bitmap & ((1 << slot) - 1))
```

Lookup:

```
arr_get(node, index):
  if node.shift == 0:
    s = slot(index, 0)
    if bit not set: return NOT_FOUND
    i = child_index(node.bitmap, s)
    return node.values[i]
  s = slot(index, node.shift)
  if bit not set: return NOT_FOUND
  i = child_index(node.bitmap, s)
  return arr_get(node.children[i], index)
```

Insert/update:

```
arr_set(node, index, value):
  if index >= root.length: return OUT_OF_RANGE
  if node.shift == 0:
    set value at slot s (create if missing)
    update bitmap/entry_count and return node
  s = slot(index, node.shift)
  if bit not set:
    create child (shift - 4) and set value
  else:
    child = arr_set(node.children[i], index, value)
  update bitmap/entry_count and return node
  // root length is unchanged
```

Append:

```
arr_append(root, values...):
  for v in values:
    root = arr_set(root, index = root.length, value = v)
    root.length++
  return root
```

Slice (copy):

```
arr_slice(root, start, end):
  if start > end or end > root.length: return OUT_OF_RANGE
  // materialize dense values[0..length)
  // return rebuild_array(values[start:end])
```

Root growth:

- If index requires a higher shift than the current root, create a new root with increased shift and insert the old root as a child.

## 8. Canonical encoding

Canonical encoding is defined as a full vacuum/re-encode of a logical JSON value into a new TRON document. The result must be byte-for-byte deterministic.

Rules:

- Use the shortest valid tag encoding for every value:
  - If inline packing is possible (txt/bin/arr/map), use it.
  - Otherwise, use the minimal byte length L and minimal length-of-length N.
  - For `i64` and `f64`, payloads are fixed 8 bytes.
  - For `arr`/`map` node addresses, use the minimal L (1..4).
- For maps, build a 16-way HAMT from the full key set using xxh32 (seed=0). Nodes are constructed deterministically by slot order at each depth. Leaf nodes contain collision buckets only at max depth.
- For arrays, build a 16-way vector trie with the minimal root shift that covers the maximum index (length-1). Leaf nodes must have shift=0. Indices are 0..length-1; missing indices are not allowed (use `nil` explicitly).
- Serialize nodes in depth-first post-order, visiting slots in ascending order. Children are written before parents.
- The root node is the last node written; root address points to that node. The trailer is written last.
- For canonical output, the root trailer prev root address must be zero.

## 9. Copy-on-write updates

TRON is append-only at the byte level. Writers must not modify existing bytes in place.

Update flow:

- Read the current root from the trailer and traverse to the target leaf.
- Build a new leaf node with the updated entry.
- Rebuild ancestor nodes up to a new root, updating child addresses to point at newly appended nodes.
- Append all newly built nodes and any new value payloads.
- Append a new trailer with the updated root/prev root addresses; the trailer must be the final 12 bytes.
- Old nodes and old trailers remain as garbage and are ignored by readers.

Update behavior:

- Array set/append/slice are structural updates: rewrite the affected leaf and its ancestor path (or rebuild for slice).
- Map set/delete are structural updates: rewrite the affected leaf and its ancestor path.
- Branch nodes update their bitmaps and entry counts; empty branches are removed.

## 10. Patch format (JSON Patch semantics)

TRON Patch applies JSON Patch semantics (RFC 6902) with a binary-friendly encoding. A patch is a TRON `arr` of operation records. Each operation record is a TRON `map` with fields:

- `op`: byte enum (i64 in range 0..5, fixed 8-byte payload)
- `path`: `arr` of path tokens
- `value`: optional, any TRON value (required for add/replace/test)
- `from`: optional, `arr` of path tokens (required for move/copy)

Op byte enum:

```
0  add
1  remove
2  replace
3  move
4  copy
5  test
```

Path tokens:

- Map key: `txt`
- Array index: `i64` (must be in range 0..u32 max)
- Append: `txt` with value `-` (JSON Patch append semantics)

Operations are applied in order and follow RFC 6902 error handling (e.g., test failures, invalid paths).

Example (JSON Patch equivalent):

- JSON Patch:
  - add /a/0 = 1
  - replace /b = "hi"

- TRON Patch (conceptual):
  - op=add (0), path=[txt "a", i64 0], value=i64 1
  - op=replace (2), path=[txt "b"], value=txt "hi"

Batching guidance:

- Implementations MAY batch operations to reduce copy-on-write churn.
- Batching must preserve RFC 6902 semantics: results are identical to applying ops in order.
- Safe batching groups ops that touch the same subtree and do not have ordering dependencies (e.g., multiple updates under the same map branch or array leaf).

### Merge Patch (RFC 7386 semantics)

TRON also supports JSON Merge Patch semantics for maps. A merge patch is represented as a regular TRON value (scalar or tree) and applied to a target document.

Rules:

- If the patch is not a map (scalar or array), the result is the patch value (replace).
- If the patch is a map, the target is treated as an object; non-map targets are treated as empty maps.
- For each key in the patch map:
  - If the patch value is `nil`, remove the key from the result.
  - If the patch value is a map and the target value is a map, recursively merge.
  - Otherwise, replace the target value with the patch value.
- Arrays are treated as scalars and are always replaced, never merged.

Complexity:

- O(k \* d) for k updated keys and depth d in the map trie, with structural reuse of unchanged subtrees.

## 11. Byte-level example (canonical TRON tree document)

Encode this JSON patch instruction in TRON:

- JSON Patch:
  - add /a/0 = 1
  - replace /b = "hi"

```json
[
  {
    "value": 1,
    "path": ["a", 0],
    "op": 0
  },
  {
    "value": "hi",
    "path": ["b"],
    "op": 2
  }
]
```

_Note that in the representation of the json patch above, the paths have been
split and the ops have been enumerated._

TRON bytes (hex, addresses at left):

```
// node: R.e[0].entry[0]
0000: 1B 00 00 00                       kind=1=leaf; key_type=1=map; len=0b11000=24
0004: 01 00 00 00                       entry_count=1
0008: 5C 76 61 6C 75 65                 key="value"::txt
000E: 02 01 00 00 00 00 00 00 00 00     value=1::i64
// node: R.e[0].e[1].value["path"]
0018: 1D 00 00 00                       kind=1=leaf; key_type=0=arr; len=0b11100=28
001C: 02 00 00 00                       entry_count=2
0020: 00                                shift=0
0021: 03 00                             bitmap=0b11
0023: 02 00 00 00                       length=2
0027: 1C 61                             "a"::txt
0029: 02 00 00 00 00 00 00 00 00 00     0::i64
// node: R.e[0].entry[1]
0033: 13 00 00 00                       kind=1=leaf; key_type=1=map; len=0b10000=16
0037: 01 00 00 00                       entry_count=1
003B: 4C 70 61 74 68                    key="path"::txt
0040: 06 18                             value=arr @0018
0042: 00                                zero padding
// node: R.e[0].entry[2]
0043: 17 00 00 00                       key=1=leaf; key_type=1=map; len=0b10100=20
0049: 01 00 00 00                       entry_count=1
004B: 2C 6F 70                          key="op"::txt
004E: 02 00 00 00 00 00 00 00 00        value=0::i64
// node: R.entry[0]
0057: 1A 00 00 00                       kind=0=branch; key_type=1=map; len=0b11000=24
005B: 03 00 00 00                       entry_count=3
005F: 41 08 00 00                       bitmap=0b100001000001
0063: 00 00 00 00                       entry[0] address = @0000
0067: 33 00 00 00                       entry[1] address = @0033
006B: 43 00 00 00                       entry[2] address = @0043
// node: R.e[1].entry[0]
006F: 17 00 00 00                       kind=1=leaf; key_type=1=map; len=0b10100=20
0073: 01 00 00 00                       entry_count=1
0077: 5C 76 61 6C 75 65                 key="value"::txt
007D: 2C 68 69                          value="hi"::txt
0081: 00 00 00                          zero padding
// node: R.e[1].e[1].value["path"]
0083: 15 00 00 00                       kind=1=leaf; key_type=0=arr; len=0b10100=20
0087: 01 00 00 00                       entry_count=1
008B: 00                                shift=8
008C: 01 00                             bitmap=0b1
008E: 01 00 00 00                       length=1
0092: 1C 62                             "b"::txt
0094: 00 00                             zero padding
// node: R.e[1].entry[1]
0096: 13 00 00 00                       kind=1=leaf; key_type=1=map; len=0b10000=16
009A: 01 00 00 00                       entry_count=1
009E: 4C 70 61 74 68                    key="path"::txt
00A3: 06 84                             value=arr @0083
00A5: 00                                zero padding
// node: R.e[1].entry[2]
00A6: 17 00 00 00                       kind=1=leaf; key_type=1=map; len=0b10100=20
00AA: 01 00 00 00                       entry_count=1
00AE: 2C 6F 70                          key="op"::txt
00B1: 02 02 00 00 00 00 00 00 00        value=2::i64
// node: R.entry[1]
00BA: 1A 00 00 00                       kind=0=branch; key_type=1=map; len=0b11000=24
00BE: 03 00 00 00                       entry_count=3
00C2: 41 08 00 00                       bitmap=0b100001000001
00C6: 6F 00 00 00                       entry[0] address = @006F
00CA: 96 00 00 00                       entry[1] address = @0096
00CE: A6 00 00 00                       entry[2] address = @00A6
// node: Root
00D2: 15 00 00 00                       kind=1=leaf; key_type=0=arr; len=0b10100=20
00D6: 02 00 00 00                       entry_count=2
00DA: 00                                shift=0
00DB: 30 00                             bitmap=0b11
00DD: 02 00 00 00                       length
00E1: F1 57                             entry[0] address = @0057
00E3: F1 BA                             entry[1] address = @00BA
// trailer
00E5: D2 00 00 00                       root address = @00D2
00E9: 00 00 00 00                       prev root address = 0 (i.e., this is canonical enc.)
00ED: 56 4E 54 58                       magic "TRON" (i.e., this is a tree document)
```

## 12. JSON mapping

This section defines a deterministic mapping between TRON values and JSON
for interop and fixtures. It matches the reference implementation.

JSON -> TRON:

- `null` => `nil`
- `true`/`false` => `bit`
- numbers:
  - if the input is an integer within signed 64-bit range, encode as `i64`
  - otherwise encode as `f64`
- strings:
  - if the string starts with `b64:` and the remainder is valid base64,
    decode to `bin`
  - otherwise encode as `txt` (UTF-8 bytes of the JSON string)
- arrays => `arr` trie using indices 0..n-1
- objects => `map` trie using UTF-8 key bytes (duplicate key handling
  follows the JSON parser; typically the last value wins)

TRON -> JSON:

- `nil` => `null`
- `bit` => `true`/`false`
- `i64` => JSON number (decimal)
- `f64` => JSON number (must be finite; otherwise error)
- `txt` => JSON string
- `bin` => JSON string with prefix `b64:` followed by base64 payload
- `arr`/`map` => JSON array/object

Notes:

- The `b64:` prefix is reserved for binary encoding in JSON. If a string
  begins with `b64:` but is not valid base64, it remains a `txt` string.

## 13. Optional addendum: implementation features

The following features are not required for core TRON format compatibility.
They are documented here because some implementations (for example, the Go
implementation) provide them.

- TRON Patch: apply RFC 7386 JSON Merge Patch semantics to TRON documents and
  return an updated TRON document without a full decode/encode cycle.
- JMESPath queries: evaluate JMESPath-style expressions directly against TRON
  documents and return TRON values.
