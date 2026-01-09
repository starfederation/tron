# TRON Memory Layout

## Recap

**TRON** (TRie Object Notation) is a binary format designed to be
JSON-compatible while using:

- **HAMT (Hash Array Mapped Trie)** for maps/objects with fast copy-on-write
  updates
- **Vector Trie** for arrays with efficient structural sharing
- **Append-only writes** with historical root tracking

Key properties:

- Canonical encoding (same logical value = same bytes)
- Random access without full document decoding
- Stream-friendly (read nodes on-demand)
- Self-contained blob suitable for transport or database storage

---

## Document Types

The full memory byte array is called a document, it's either scalar or a tree.
To distinguish between them, the trailing four bytes contain different "magic"
values:

| Type   | Magic (last 4 bytes) | Use Case                        |
| ------ | -------------------- | ------------------------------- |
| Scalar | `NORT` (0x4E4F5254)  | Single primitive value          |
| Tree   | `TRON` (0x54524F4E)  | Documents containing arr or map |

---

## Scalar Documents

### Format

```
byte0 ... byteN-4  byteN-3  byteN-2  byteN-1  byteN
                   0x4e     0x4f     0x52     0x54
│               │  │'N'      'O'      'R'      'T'│
└──┬────────────┘  └────────┬─────────────────────┘
   └─ value record          └─ magic trailer
```

Minimum size: 5 bytes (nil value + magic)

**Example:** scalar `nil`

```
00 4E 4F 52 54
│  └──────────── "NORT" magic
└─────────────── nil value record (0b00000000)
```

**Example:** scalar `"hi"`

```
2C 68 69 4E 4F 52 54
│        └──────────── "NORT" magic
└───────────────────── txt value record
│  └──┴─────────────── - "hi" UTF-8 bytes
└───────────────────── - txt value tag (packed, len=2)
                         → 0x2c = 0b00101100
                                    └─┬┘│└┬┘
                                      │ │ └─ txt
                                      │ └─ packed
                                      └─ len=2
```

---

## Tree Documents

### Trailer Layout (last 12 bytes)

Tree documents have a longer trailer, they still end in 4 magic bytes but they
also include offsets required to be able to walk the tree:

| Offset | Size | Field                         |
| ------ | ---- | ----------------------------- |
| 0      | 4    | Root node offset (u32 LE)     |
| 4      | 4    | Previous root offset (u32 LE) |
| 8      | 4    | Magic `TRON`                  |

The trailer enables:

- **Copy-on-write updates**: append new nodes, update root pointer
- **History tracking**: previous root offsets form a linked list

### Format

```
byte0 ... byteN-4  byteN-11  byteN-10  byteN-9  byteN-8  byteN-7  byteN-6  byteN-5  byteN-4  byteN-3  byteN-2  byteN-1  byteN
                                                                                             0x54     0x52     0x4f     0x4e
                                                                                              'T'      'R'      'O'      'N'
└───────┬───────┘  └─────────────────┬────────────────┘ └────────────────┬────────────────┘  └───────────────┬──────────────┘
node data section             root node offset                prev. root node offset                   magic trailer
```

Minimum size: 20 bytes (empty map leaf: 8-byte node + 12-byte trailer).
Array nodes require additional fields (shift, bitmap, length), so minimum array
document is 28 bytes.

---

## Value Records

All values start with a 1-byte tag header:

```
Bit layout: 7 6 5 4 3 2 1 0
            x x x x x T T T
            └───┬───┘ └─┬─┘
       Type-specific   Type
                       (0-7)
```

### Value Types

| Type | Bits       | Description                             | Payload                                                   |
| ---- | ---------- | --------------------------------------- | --------------------------------------------------------- |
| nil  | `00000000` | JSON null                               | No bytes (tag header tells us all we need)                |
| bit  | `0000B001` | Boolean (true/false)                    | No bytes (true/false value packed in bit 3 of tag header) |
| i64  | `00000010` | Signed 64-bit int                       | 8 bytes, little-endian                                    |
| f64  | `00000011` | IEEE-754 64-bit float (a.k.a. "double") | 8 bytes, little-endian                                    |
| txt  | `LLLLP100` | UTF-8 string                            | N (1-8) bytes for L (if P=0 because L>15) + L UTF-8 bytes |
| bin  | `LLLLP101` | Raw bytes                               | N (1-8) bytes for L (if P=0 because L>15) + L raw bytes   |
| arr  | `000MM110` | Array node offset (u32)                 | M+1 bytes, little-endian                                  |
| map  | `000MM111` | Map node offset (u32)                   | M+1 bytes, little-endian                                  |

### Length Encoding (txt, bin)

```
Tag header byte:
  LLLL P TTT
  │    └──── isPacked flag (bit 4)
  └────── if isPacked: length (L); else: length byte count (N)
```

- **Packed** (`P=1`): High 4 bits hold inline length (0-15)
- **Unpacked** (`P=0`): High 4 bits = N (1-8), followed by N bytes encoding length L (little-endian)

### Examples

```
nil:            0x00
false:          0x01
true:           0x09
i64(42):        0x02 2A 00 00 00 00 00 00 00
f64(1.5):       0x03 00 00 00 00 00 00 F8 3F
txt "ab":       0x2C 61 62                     (packed len=2)
txt (long):     0x14 20 <32 bytes...>          (unpacked, 1-byte len=32)
bin 0xDDEEFF:   0x3D DD EE FF                  (packed len=3)
bin (long):     0x25 00 01 <256 bytes...>      (unpacked, 2-byte len=256)
arr:            0x06 00                        arr w/ offset 0
map:            0x16 00 00 00 01               map w/ offset 16,777,216
```

### Examples showing arr/map length

```
arr w/ offset 0 (len = L+1 = 0+1 = 1)
00000110 00000000

arr w/ offset 256 (len = L+1 = 1+1 = 2)
00001110 00000000 00000001

arr w/ offset 65,536 (len = L+1 = 1+2 = 3)
00010110 00000000 00000000 00000001

arr w/ offset 16,777,216 (len = L+1 = 1+3 = 4)
00011110 00000000 00000000 00000000 00000001

arr w/ offset 4,294,967,296 (len = L+1 = 1+3 = 4)
00011110 11111111 11111111 11111111 11111111
```

---

## Node Layout

All nodes share an 8-byte header:

| Offset | Size | Field                     |
| ------ | ---- | ------------------------- |
| 0      | 4    | Length and flags (u32 LE) |
| 4      | 4    | Entry count (u32 LE)      |

```
Length and flags
  byte3    byte2    byte1    byte0       ← note bytes in reverse order because little-endian
  LLLLLLLL LLLLLLLL LLLLLLLL LLLLLLTK
  └──┬────────────────────────────┘│└─ Kind (0=branch, 1=leaf)
     │                             └─ Key type (0=arr, 1=map)
     └─ node_len = LLLLLLLL LLLLLLLL LLLLLLLL LLLLLL00 (= header & 0xFFFFFFFC = header & ~0x3)
        (note since lowest 2 bits always 0, must be multiple of 4)

Entry count
  byte7    byte6    byte5    byte4
  XXXXXXXX XXXXXXXX XXXXXXXX XXXXXXXX
  └────────────────┬────────────────┘
                   └─ entry_count
```

Extract length: `node_len = header_u32 & ~0x3`

**Important invariants:**

- `node_len` includes header, entries, and zero padding (must be multiple of 4)
- `entry_count` must equal `popcount(bitmap)` for branch nodes

---

## Map Nodes (HAMT)

Maps use a Hash Array Mapped Trie with xxh32 hashing (see spec for full algorithm).

### Hash Slot Calculation

```
hash = xxh32(key_bytes, seed=0)
slot = (hash >> (depth * 4)) & 0xF
       └─────────┬─────────┘ └─┬─┘
                 │             └─ mask to only bottom byte
                 └─ move depth byte to the bottom
```

Each level consumes 4 bits of the hash. With 32-bit hashes and 4-bit chunks,
depths range from 0 (root) to 7 (max), giving 8 possible levels. When writing,
you only go down to the level of the first non-collision.

### Branch Node Layout

| Offset | Size   | Field                                                             |
| ------ | ------ | ----------------------------------------------------------------- |
| 0      | 8      | Node header                                                       |
| 8      | 4      | Bitmap (u32 LE) - slots present (note upper 2 bytes are always 0) |
| 12     | 4 \* n | Child offsets (u32 LE each)                                       |

```
Branch node:
  Header
    ...

  Bitmap
    byte11   byte10    byte9    byte8
    00000000 00000000  XXXXXXXX XXXXXXXX
    └───────┬───────┘  └───────┬───────┘
        always 0           16 slots

  Child offsets
    byte15   byte14   byte13   byte12    byte19   byte18   byte17   byte16    ...
    XXXXXXXX XXXXXXXX XXXXXXXX XXXXXXXX  XXXXXXXX XXXXXXXX XXXXXXXX XXXXXXXX  ...
    └────────────────┬────────────────┘  └────────────────┬────────────────┘
               child 0 offset                       child 1 offset            ...
```

Where `n = popcount(bitmap)`

Child index: `popcount(bitmap & ((1 << slot) - 1))`

### Leaf Node Layout

| Offset | Size | Field                            |
| ------ | ---- | -------------------------------- |
| 0      | 8    | Node header                      |
| 8      | var  | Entries: [txt key] + [value] ... |

```
Leaf node:
  Header
    ...

  Entries
    byte8    byte9    ... byteN     byteN+1   byteN+2 ... byteM     byteM+1    ...
    KKKKKKKK KKKKKKKK ... KKKKKKKK  VVVVVVVV VVVVVVVV ... VVVVVVVV  KKKKKKKK   ...
    └──────────────┬───/─────────┘  └──────────────┬───/─────────┘  └────┬──
                 key0                           value0                 key1    ...
           (txt value record)             (any value record)
```

- Entries sorted by UTF-8 key bytes
- Keys are unique within a leaf
- Lookups must compare full key bytes (hash match alone is insufficient)

### Hash Collisions

When two keys hash to the same slot at a given depth, the leaf is split into a
branch and keys are placed in children based on the next hash nibble. This
continues until keys diverge or max depth (7) is reached. Keys with identical
32-bit hashes are stored together in a single leaf at max depth.

### Example: Map Branch

```
Offset 0x00:
  0C 00 00 00    node_len=12, branch, map
  02 00 00 00    entry_count=2
  03 00 00 00    bitmap=0x0003 (slots 0,1 occupied)
  20 00 00 00    child[0] offset
  40 00 00 00    child[1] offset
```

### Example: Map Leaf

```
Offset 0x00:
  13 00 00 00                   node_len=19, leaf, map
  01 00 00 00                   entry_count=1
  2C 61                         txt "a" (packed len=1)
  02 2A 00 00 00 00 00 00 00    i64(42)
```

---

## Array Nodes (Vector Trie)

Arrays use a Vector Trie indexed by element position.

### Index Slot Calculation

```
slot = (index >> shift) & 0xF
       └──────┬───────┘ └─┬─┘
              │           └─ mask to only bottom byte
              └─ move the relevant byte of the index to the bottom byte
```

The root shift is chosen so `max_index >> shift <= 0xF`. Each depth down from
the root, the shift is decreased by 4.

### Branch Node Layout

| Offset | Size   | Field                       |
| ------ | ------ | --------------------------- |
| 0      | 8      | Node header                 |
| 8      | 1      | Shift (u8)                  |
| 9      | 2      | Bitmap (u16 LE)             |
| 11     | 4      | Length (u32 LE)             |
| 15     | 4 \* n | Child offsets (u32 LE each) |

### Leaf Node Layout

| Offset | Size | Field                       |
| ------ | ---- | --------------------------- |
| 0      | 8    | Node header                 |
| 8      | 1    | Shift (must be 0)           |
| 9      | 2    | Bitmap (u16 LE)             |
| 11     | 4    | Length (u32 LE)             |
| 15     | var  | Value records in slot order |

**Length field:** Only meaningful in the root node (stores array length, valid
indices are `0..length-1`). Non-root nodes must store 0.

### Example: Array Leaf

```
Offset 0x00:
  1D 00 00 00                   node_len=28, leaf, arr
  02 00 00 00                   entry_count=2
  00                            shift=0
  03 00                         bitmap=0x0003 (indices 0,1)
  02 00 00 00                   length=2
  02 01 00 00 00 00 00 00 00    i64(1) at index 0
  02 02 00 00 00 00 00 00 00    i64(2) at index 1
```

---

## Full Document Example

This section shows the complete memory layout of a tree document representing:

```json
{
  "name": "alice",
  "scores": [10, 20]
}
```

### Logical Structure

```
                    ┌─────────────────────────────────┐
                    │         Map Root (Branch)       │
                    │         bitmap: 0x0022          │
                    │       (0b00000000 00100010)     │
                    │                     │   │       │
                    │    slots occupied:  5   1       │
                    └───────────┬───────────┬─────────┘
                                │           │
              ┌─────────────────┘           └─────────────────┐
              ▼                                               ▼
┌─────────────────────────────┐             ┌─────────────────────────────┐
│      Map Leaf (slot 1)      │             │      Map Leaf (slot 5)      │
│      "name" → "alice"       │             │      "scores" → arr @0x00   │
└─────────────────────────────┘             └──────────────┬──────────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │        Array Leaf           │
                                            │     [0] → 10, [1] → 20      │
                                            └─────────────────────────────┘
```

### Memory Layout (read bottom to top)

```
Offset    Contents
───────────────────────────────────────────────────────────────────────────────

0x00      ┌───────────────────────────────────────────────────────────────────┐
          │                        Array Leaf Node                            │
          │  1D 00 00 00                 :  node_len=28, flags=01 (leaf, arr) │
          │  02 00 00 00                 :  entry_count=2                     │
          │  00                          :  shift=0                           │
          │  03 00                       :  bitmap=0x0003 (slots 0,1)         │
          │  02 00 00 00                 :  length=2                          │
          │  02 0A 00 00 00 00 00 00 00  :  i64(10)                           │
          │  02 14 00 00 00 00 00 00 00  :  i64(20)                           │
0x22      ├───────────────────────────────────────────────────────────────────┤
          │                   Map Leaf Node ("scores")                        │
          │  14 00 00 00           :  node_len=20, flags=03 (leaf, map)       │
          │  01 00 00 00           :  entry_count=1                           │
          │  6C 73 63 6F 72 65 73  :  txt "scores" (packed len=6)             │
          │  06 00                 :  arr ref (packed 1-byte offset=0x00)     │
          │  00 00                 :  padding to 4-byte boundary              │
0x34      ├───────────────────────────────────────────────────────────────────┤
          │                    Map Leaf Node ("name")                         │
          │  14 00 00 00        :  node_len=20, flags=03 (leaf, map)          │
          │  01 00 00 00        :  entry_count=1                              │
          │  4C 6E 61 6D 65     :  txt "name" (packed len=4)                  │
          │  5C 61 6C 69 63 65  :  txt "alice" (packed len=5)                 │
          │  00                 :  padding to 4-byte boundary                 │
0x49      ├───────────────────────────────────────────────────────────────────┤
          │                      Map Branch Node (Root)                       │
          │  14 00 00 00  :  node_len=20, flags=02 (branch, map)              │
          │  02 00 00 00  :  entry_count=2                                    │
          │  22 00 00 00  :  bitmap=0x0022 (slots 1,5)                        │
          │  34 00 00 00  :  child[0] → 0x34 (slot 1 offset: "name" leaf)     │
          │  22 00 00 00  :  child[1] → 0x22 (slot 5 offset: "scores" leaf)   │
0x5D      ├───────────────────────────────────────────────────────────────────┤
          │                           Trailer                                 │
          │  44 00 00 00  :  root_offset=0x49                                 │
          │  00 00 00 00  :  prev_root_offset=0 (no history)                  │
          │  54 52 4F 4E  :  magic "TRON"                                     │
0x68      └───────────────────────────────────────────────────────────────────┘

Total: 104 bytes (0x68)
```

### Traversal: Looking up `scores[1]`

```
┌──────────┐    read trailer     ┌─────────────┐
│  Start   │ ─────────────────▶  │ root = 0x44 │
└──────────┘                     └──────┬──────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 1. Hash "scores": xxh32("scores") = 0x12348765             │
        │    slot = (hash >> 0) & 0xF = 5                            │
        │    bitmap 0x0022; slot 5                                   │
        │      → child index = popcount(bitmap & ((1 << slot) - 1))  │
        │                    = popcount(0x0022 & ((1 << 5) - 1))     │
        │                    = popcount(0x0022 & 0x1f)               │
        │                    = popcount(0x2)                         │
        │                    = popcount(0b10)                        │
        │      ∴ child index = 1                                     │
        │    Follow child[1] → offset 0x22                           │
        └────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 2. At Map Leaf 0x22: scan entries for key "scores"         │
        │    Found!                                                  │
        │    Value = arr ref @ offset 0x00                           │
        └────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 3. At Array Leaf 0x00: looking for index 1                 │
        │      → slot = (index >> shift) & 0xF                       │
        │             = (1 >> 0) & 0xF                               │
        │      ∴ slot = 1                                            │
        │    bitmap 0x0003 has slot 1                                │
        │      → value index = popcount(0x0003 & 0x1)                │
        │                    = popcount(0b00000011 & 0b1)            │
        │                    = popcount(0b00000001)                  │
        │                    = 1                                     │
        │    Read value[1] → i64(20)                                 │
        └────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                                ┌──────────────┐
                                │  Result: 20  │
                                └──────────────┘
```

### After Updating `scores[0]` to `99`

```diff
  {
    "name": "alice",
-   "scores": [10, 20]
+   "scores": [99, 20]
  }
```

```
Before (100 bytes):
┌────────────┬────────────┬───────────┬────────────┬─────────┐
│ ArrLeaf    │ MapLeaf    │ MapLeaf   │ MapBranch  │ Trailer │
│ [10,20]    │ "scores"   │ "name"    │ (root)     │         │
│ @0x00      │ @0x22      │ @0x34     │ @0x49      │         │
└────────────┴────────────┴───────────┴────────────┴─────────┘
                                       root=0x49

After (180 bytes):
┌────────────┬────────────┬───────────┬────────────┬─────────┬────────────┬────────────┬────────────┬──────────┐
│ ArrLeaf    │ MapLeaf    │ MapLeaf   │ MapBranch  │ Trailer │ ArrLeaf'   │ MapLeaf'   │ MapBranch' │ Trailer' │
│ [10,20]    │ "scores"   │ "name"    │ (old root) │ T-1     │ [99,20]    │ "scores"   │ (new root) │ T0       │
│ @0x00      │ @0x22      │ @0x34     │ @0x49      │         │ @0x68      │ @0x8a      │ @0x9c      │          │
│ (hist)     │ (hist)     │           │ (hist)     │         │            │            │            │          │
└────────────┴────────────┴───────────┴────────────┴─────────┴────────────┴────────────┴────────────┴──────────┘
 ▲                         ▲                                  │            │            │
 │                         │                                  │            │            │
 │                         └──────────────────────────────────│────────────│────────────┘
 │                           (reused: "name" leaf unchanged)  │            │  child[0]=0x34
 │                                                            │            │  child[1]=0x8a
 │                                                            │            │
 │                                                            │            └─ points to new "scores" leaf
 └────────────────────────────────────────────────────────────│───────────────────────────────────────────────
   (historical: reachable via prev chain)                     └─ arr ref now points to 0x64

                                                               root=0x9c
                                                               prev=0x49
```

Note:

- The `"name"` leaf at 0x34 is **reused** (structural sharing)
- Old nodes at 0x00, 0x22, 0x49 are **historical** (reachable via `prev` for
  time travel)
- The old trailer T-1 is findable at `prev_root + node_len` (see History
  Traversal)

---

## Copy-on-Write Updates

When modifying a tree document:

1. Read current root from trailer
2. Traverse to target node
3. Build new node with updated content
4. Rebuild ancestor nodes with new child offsets
5. Append all new nodes to end of data
6. Write new trailer with updated root offset

Old data remains in the file. Readers of the current version ignore it
(following only the current root pointer), but historical versions remain
accessible via the `prev` chain (see History Traversal).

```
Before:
┌─────────────────┬──────────┐
│ Node A → Node B │ Trailer  │
└─────────────────┴──────────┘
                   root=A

After updating B:
┌─────────────────┬──────────┬────────────┬──────────┐
│ Node A → Node B │ (old)    │ A' → B'    │ Trailer  │
└─────────────────┴──────────┴────────────┴──────────┘
                                           root=A'
                                           prev=A
```

---

## History Traversal

The root node is always immediately followed by its trailer. This holds for both
canonical documents (depth-first post-order serialization) and copy-on-write
updates (append-only constraint forces children to be written before parents, so
root is always last before trailer).

This means you can traverse the full history chain by finding each trailer at
`root_offset + node_len`.

### Algorithm

```
history_walk(document):
  trailer = read_trailer(document)  // last 12 bytes

  while trailer.prev_root_offset != 0:
    // Read the previous root node header to get its length
    prev_root = read_node_header(trailer.prev_root_offset)
    node_len = prev_root.header & ~0x3

    // The previous trailer immediately follows that root node
    prev_trailer_offset = trailer.prev_root_offset + node_len
    trailer = read_trailer_at(prev_trailer_offset)

    yield trailer  // or process historical state
```

### Example: Three Versions Deep

```
┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│ nodes   │ Root-2  │ T-2     │ nodes   │ Root-1  │ T-1     │ nodes   │ Root0   │ T0      │
│         │ @0x10   │         │         │ @0x40   │         │         │ @0x80   │         │
└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
                    │                   │                                        │
                    │                   │         Current trailer (end of file) ─┘
                    │                   │         root=0x80, prev=0x40
                    │                   │
                    │                   └─ Found at 0x40 + node_len(Root-1)
                    │                      root=0x40, prev=0x10
                    │
                    └─ Found at 0x10 + node_len(Root-2)
                       root=0x10, prev=0 (end of history)
```

### Traversal Walkthrough

```
┌─────────────────────────────────────────────────────────┐
│ 1. Read T0 from end of file                             │
│    root=0x80, prev=0x40                                 │
└─────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────┐
│ 2. Read node header at 0x40 → node_len = 20             │
│    T-1 is at 0x40 + 20 = 0x54                           │
│    Read T-1: root=0x40, prev=0x10                       │
└─────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Read node header at 0x10 → node_len = 16             │
│    T-2 is at 0x10 + 16 = 0x20                           │
│    Read T-2: root=0x10, prev=0 (stop - no more history) │
└─────────────────────────────────────────────────────────┘
```

This enables full version history without external indexes - the history chain
is embedded in the document itself.

---

## Complexity

| Operation     | Map (HAMT) | Array (Vector Trie) |
| ------------- | ---------- | ------------------- |
| Lookup        | O(d + c)   | O(d)                |
| Insert/Update | O(d + c)   | O(d)                |
| Delete        | O(d + c)   | O(d)                |

Where:

- `d` = tree depth (depths 0-7, so max 8 levels for 32-bit hash/index with
  nibble/4-bit chunks)
- `c` = collision count (same hash, different keys)

---

## Quick reference

```
Document
  Scalar
    [Value] [NORT]

  Tree
    [Nodes...] [Trailer]
                ├─ root_offset_u32
                ├─ prev_offset_u32
                └─ "TRON"

Node (map/arr)
   [Header] [Type-specific data...]
    ├─ length + flags (u32)
    └─ entry_count (u32)

Value
   [Tag 1B] [Payload...]
    └─ xxxxxTTT
       type + encoding
```
