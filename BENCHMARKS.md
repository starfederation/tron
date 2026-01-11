# TRON Benchmark Specification

This document specifies the benchmark suite for TRON implementations. Following
this specification ensures consistent, comparable benchmarks across different
language implementations.

## What is TRON?

TRON is a binary serialization format designed for **lazy access** - you can navigate
directly to nested values without parsing the entire document. It uses structural
sharing for efficient copy-on-write updates: modifying a value only creates new nodes
along the modified path while reusing unmodified subtrees by reference.

### Key Concepts

| Term                   | Definition                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------- |
| **Lazy access**        | Reading only the parts of a document you need, without parsing the entire structure |
| **Structural sharing** | Reusing unchanged subtrees by address reference instead of copying                  |
| **Root footer**        | Metadata at the end of a TRON document containing the root node address             |
| **String interning**   | Caching string-to-bytes conversions and pre-computing hashes for reuse              |

---

## Overview

| Category                | Benchmark      | Operation                            |
| ----------------------- | -------------- | ------------------------------------ |
| **Single-Field Access** | TRONAccessOne  | Navigate to 1 nested value (lazy)    |
|                         | JSONAccessOne  | Parse entire document + navigate     |
|                         | CBORAccessOne  | Parse entire document + navigate     |
| **Multi-Field Access**  | TRONAccessMany | Navigate to N values (lazy, N times) |
|                         | JSONAccessMany | Parse once + navigate N times        |
|                         | CBORAccessMany | Parse once + navigate N times        |
| **Encode**              | TRONEncodeWarm | Encode with cached strings/hashes    |
|                         | TRONEncodeCold | Encode without caches (cold start)   |
|                         | JSONEncode     | Encode to JSON                       |
|                         | CBOREncode     | Encode to CBOR                       |
| **Full Traversal**      | TRONClone      | Clone all nodes to new document      |
|                         | JSONRoundtrip  | Parse + re-encode                    |
|                         | CBORRoundtrip  | Parse + re-encode                    |
| **Modify**              | TRONModify     | Copy-on-write update                 |
|                         | JSONModify     | Parse + modify + encode              |
|                         | CBORModify     | Parse + modify + encode              |

### Metrics

All benchmarks report:

| Metric                | Unit            | Notes                      |
| --------------------- | --------------- | -------------------------- |
| Time per operation    | nanoseconds     | Primary metric             |
| Operations per second | ops/sec         | Derived from time          |
| Allocations           | count and bytes | Where language supports it |

**Throughput note**: Bytes/second is only meaningful for benchmarks that process
the full document. For single-field access, ops/sec is the relevant metric since
you're not "processing" the entire document.

---

## Test Data

### Primary: `geojson_large.json`

**Location**: `shared/testdata/geojson_large.json`

A GeoJSON FeatureCollection with 6 features (Point, LineString, Polygon,
MultiPoint, MultiLineString, MultiPolygon):

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "Trailhead", "elevation": 1200, "status": "open" },
      "geometry": { "type": "Point", "coordinates": [-122.420679, 37.772537] }
    },
    ...
  ]
}
```

### Encoded Sizes

| Format | Size    | Ratio           |
| ------ | ------- | --------------- |
| JSON   | ~2.1 KB | 1.0x (baseline) |
| CBOR   | ~1.1 KB | 0.5x            |
| TRON   | ~2.6 KB | 1.2x            |

TRON is larger due to structural overhead (HAMT nodes, addresses). This overhead
enables lazy access and structural sharing.

### Scaling Recommendations

Implementations SHOULD include benchmarks at multiple document sizes to reveal
scaling characteristics:

| Size            | Purpose                                            |
| --------------- | -------------------------------------------------- |
| ~2 KB (primary) | Baseline, fits in L1 cache                         |
| ~100 KB         | Typical API response size                          |
| ~1 MB           | Large document, reveals memory/allocation patterns |

Generate larger test data by replicating features or using separate test files.

### Setup

Before benchmarking, prepare:

| Input         | Preparation                                                     |
| ------------- | --------------------------------------------------------------- |
| JSON bytes    | Raw file contents                                               |
| TRON bytes    | JSON converted to TRON                                          |
| CBOR bytes    | JSON encoded as CBOR                                            |
| Parsed object | JSON parsed to native types (see [Native Types](#native-types)) |

---

## Benchmarks

### Single-Field Access

Measures the cost of reading one deeply nested value.

**Path**: `features[0].geometry.coordinates[0]` → `-122.420679`

```
root
 └─ ["features"]
     └─ [0]
         └─ ["geometry"]
             └─ ["coordinates"]
                 └─ [0]  → result
```

#### TRONAccessOne

1. Parse root footer (8 bytes)
2. Navigate path by following node addresses
3. Return coordinate value

**What this measures**: Lazy access - TRON reads only the nodes along the path,
not the entire document.

#### JSONAccessOne / CBORAccessOne

1. Parse entire document into native objects
2. Navigate to path
3. Return coordinate value

**What this measures**: Full parse cost + navigation. The parse dominates;
navigation through in-memory objects is fast.

**Key insight**: This benchmark compares different workloads by design. TRON's
advantage grows with document size since it reads O(depth) nodes while JSON/CBOR
parse O(n) nodes.

---

### Multi-Field Access

Measures performance when reading multiple scattered values from one document.

**Paths** (N=5):

1. `features[0].properties.name` → "Trailhead"
2. `features[0].geometry.coordinates[0]` → -122.420679
3. `features[2].properties.elevation` → 1050
4. `features[4].geometry.type` → "MultiLineString"
5. `type` → "FeatureCollection"

#### TRONAccessMany

1. Parse root footer once
2. For each path: navigate and read value
3. Return all values

**What this measures**: Amortized lazy access. Each path requires separate
navigation from root.

#### JSONAccessMany / CBORAccessMany

1. Parse entire document once
2. For each path: navigate in-memory structure
3. Return all values

**What this measures**: Parse once, navigate many. JSON/CBOR amortize parse cost
across multiple accesses.

**Key insight**: As N increases, JSON/CBOR's single parse becomes more efficient
relative to TRON's repeated navigation. This benchmark reveals the crossover point.

Implementations SHOULD test with N = 1, 5, 10, 20 to characterize scaling.

---

### Encode

Measures serializing an in-memory object to bytes.

#### TRONEncodeWarm

1. Reuse output buffer (reset, don't reallocate)
2. Encode pre-internalized object to TRON
3. Finalize with root footer

**String interning** (pre-benchmark setup):

- Cache: string value → UTF-8 bytes
- Cache: map key → XXH32 hash

**What this measures**: Steady-state encoding with warm caches, simulating
applications that encode similar structures repeatedly.

#### TRONEncodeCold

1. Reuse output buffer (reset, don't reallocate)
2. Encode object without caches:
   - Convert strings to UTF-8 on each iteration
   - Compute XXH32 hashes on each iteration
3. Finalize with root footer

**What this measures**: Cold-start encoding cost. This is the fair comparison
against JSON/CBOR, which don't use string caching.

#### JSONEncode / CBOREncode

1. Encode pre-parsed object to bytes

**Note**: Use standard library encoders without custom optimizations for fair
comparison with TRONEncodeCold.

---

### Full Traversal

Measures processing every node in a document.

**Important**: These benchmarks are NOT equivalent operations:

| Format    | Operation                             | Transformations   |
| --------- | ------------------------------------- | ----------------- |
| JSON/CBOR | Parse → native objects → serialize    | 2 (bytes↔objects) |
| TRON      | Traverse nodes → copy to new document | 1 (bytes→bytes)   |

TRON has no intermediate "native object" representation - the binary format IS
the working format. We force full traversal by cloning to measure the cost of
visiting every node.

#### TRONClone

1. Parse root footer
2. Recursively clone all nodes to new builder:
   - Maps: clone each key-value pair
   - Arrays: clone each element
   - Scalars: copy value
3. Finalize new document

#### JSONRoundtrip / CBORRoundtrip

1. Parse bytes into native objects
2. Encode back to bytes

---

### Modify

Measures read-modify-write with a single field change.

**Change**: `features[0].properties.elevation`: `1200` → `1500`

#### TRONModify

```
BEFORE                           AFTER
──────                           ─────
root ──────────────────────────→ root' (NEW)
 ├─ type: "FeatureCollection"     ├─ type ←────────────────── (reused)
 └─ features ─────────────────→   └─ features' (NEW)
     ├─ [0] ──────────────────→       ├─ [0]' (NEW)
     │   ├─ properties ───────→       │   ├─ properties' (NEW, elevation=1500)
     │   └─ geometry ─────────────→   │   └─ geometry ←─────── (reused)
     └─ [1..5] ───────────────────→   └─ [1..5] ←───────────── (reused)
```

1. Parse root footer
2. Navigate to `features[0].properties.elevation`
3. Create new nodes for modified path only:
   - New `properties` map with `elevation = 1500` (int64)
   - New `features[0]` with updated properties, same geometry address
   - New `features` array with updated [0], same [1..5] addresses
   - New root with updated features, same type address
4. Finalize document (optionally store previous root for versioning)

**What this measures**: Structural sharing efficiency. Only O(depth) new nodes
are created; unmodified subtrees are referenced by address.

#### JSONModify / CBORModify

1. Parse entire document into native objects
2. Navigate to `["features"][0]["properties"]`
3. Set `["elevation"]` = 1500 (float64 for JSON, int64 for CBOR)
4. Encode entire document back to bytes

**What this measures**: Full parse + full encode cost for a single-field change.

---

## Implementation Guidelines

### Native Types

Use these types for "native map/array" structures:

| Language   | Map Type                                        | Array Type          |
| ---------- | ----------------------------------------------- | ------------------- |
| Go         | `map[string]any`                                | `[]any`             |
| Rust       | `serde_json::Value` or `HashMap<String, Value>` | `Vec<Value>`        |
| Python     | `dict`                                          | `list`              |
| JavaScript | Plain object (as from `JSON.parse`)             | `Array`             |
| Java       | `LinkedHashMap<String, Object>`                 | `ArrayList<Object>` |

### Buffer Reuse

TRON encode benchmarks reuse output buffers to isolate encoding performance
from allocation overhead. JSON/CBOR encoders typically allocate fresh buffers;
use each library's default behavior for fair comparison.

### CBOR Configuration

Configure CBOR decoders to use string keys (not interface/any keys) for
consistent comparison with JSON.

### Preventing Dead Code Elimination

| Language   | Technique                                                              |
| ---------- | ---------------------------------------------------------------------- |
| Go         | Assign to package-level `var sink T`; call `runtime.KeepAlive(result)` |
| Rust       | `std::hint::black_box(result)` or `criterion::black_box`               |
| Java       | JMH `Blackhole.consume(result)`                                        |
| JavaScript | Assign to `globalThis._result = result`                                |
| Python     | Assign to module-level variable (CPython doesn't optimize away)        |

### JIT Warmup

For JIT-compiled languages, warm up before measurement:

| Language         | Warmup                                       |
| ---------------- | -------------------------------------------- |
| Java             | Use JMH with default warmup (10+ iterations) |
| JavaScript       | Run 1000+ warmup iterations before timing    |
| Go               | `testing.B` handles this automatically       |
| Rust (release)   | No warmup needed                             |
| Python (CPython) | No warmup needed                             |

### Allocation Tracking

| Language   | Method                     | Notes                         |
| ---------- | -------------------------- | ----------------------------- |
| Go         | `testing.B.ReportAllocs()` | Built-in                      |
| Rust       | Custom allocator or `dhat` | Requires setup                |
| Java       | JMH allocation profiler    | GC complicates measurement    |
| Python     | `tracemalloc`              | High overhead; optional       |
| JavaScript | Not reliably available     | Report heap delta if possible |

---

## Appendix: JMESPath Benchmarks

TRON implementations often include JMESPath for querying documents. These
benchmarks measure expression parsing and evaluation performance.

**Location**: `shared/testdata/jmespath/benchmarks.json`

### Types

- **parse**: Compile expression only (empty input `{}`)
- **full**: Compile + evaluate against test data

### Naming

Format: `JMESPath/{type}/g{group}-{name}`

Examples: `JMESPath/full/g0-simple-field`, `JMESPath/parse/g2-field-50`

### Group 0: Basic Navigation

Input: `{"b": true, "c": {"d": true}, "a": {"b": {"c": ...16 levels... {"p": true}}}}`

| Name            | Expression                              | Type |
| --------------- | --------------------------------------- | ---- |
| simple-field    | `b`                                     | full |
| simple-subexpr  | `c.d`                                   | full |
| deep-field      | `a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p`       | full |
| deep-field-miss | `a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s` | full |
| simple-or       | `not_there \|\| b`                      | full |

### Group 1: Complex Operations

Input: `{"a": 0, "b": 1, ... "z": 25}` (26 keys)

| Name       | Expression Pattern               | Type |
| ---------- | -------------------------------- | ---- |
| deep-ands  | `a && b && ... && z`             | full |
| deep-ors   | `z \|\| y \|\| ... \|\| a`       | full |
| sum-list   | `sum([z, y, ..., a])`            | full |
| nested-sum | `sum([z, sum([y, sum([...])])])` | full |
| multi-list | `[z, y, ..., a]`                 | full |

### Group 2: Parser Stress

Input: `{}` (parse-only)

| Name           | Expression Pattern              | Type  |
| -------------- | ------------------------------- | ----- |
| field-50       | `j49.j48...j0` (50 fields)      | parse |
| pipe-50        | `j49\|j48\|...\|j0` (50 pipes)  | parse |
| index-50       | `[49][48]...[0]` (50 indices)   | parse |
| long-string    | 208-char raw string literal     | parse |
| projection-104 | `a[*].b[*]...z[*]` (104 levels) | parse |
| filter         | `foo[?bar > baz][?qux > baz]`   | parse |

See `shared/testdata/jmespath/benchmarks.json` for exact expressions.
