# das2js design notes

Status: 2026-10-19.  Decisions from the das2C planning sessions that led to
this project's revival; recorded here so they don't live only in one
person's head (or one AI session's memory).

## Division of labor with das2C

das2C provides the mechanisms, das2js owns everything JavaScript-shaped:

* das2C: the push-mode stream parser (`DasIO_feed`, in das2C as of commit
  92ade6f), the `__EMSCRIPTEN__` portability defines, and
  `buildfiles/Emscripten.mak`, selected by `make EMSCRIPTEN=yes`, which
  cross-compiles `libdas3.a` only.  Two feature macros defined there and
  nowhere else, `DAS_NO_NETWORK` and `DAS_NO_DFT`, compile out the socket and
  SSL stream modes and the FFTW setup; `http.c`, `credentials.c`, `node.c`,
  `dft.c`, `cli.c` and `send.c` stay out of the archive.  No wasm export
  markup lives in das2C.
* das2js: the flat C glue in `glue/` (the wasm export surface), the
  emscripten link step with its exports list and flags, the ES module, and
  packaging.

Like das2py and das2dlm, this project statically pins a das2C version and
compiles it in.  No shared libraries, no dynamic FFI: a *.wasm module is a
sealed artifact, which is the point.  Dynamic bindings (python ctypes
style) against a drifting library are how downstream projects break.

## The glue layer

`glue/wasm.h` is a flat projection of the das2C dataset model: every
function takes and returns only pointers, integers, doubles and UTF-8
strings, which emscripten's cwrap marshals without help.  `DasWasmRdr`
couples the feed parser to the dataset builder so no C function pointers
ever cross into JavaScript: push bytes in, poll state, walk the results.
Bulk values go out zero-copy where a variable is array-backed
(`daswasm_var_ary` + `daswasm_ary_data`) with `daswasm_var_qube` as the
materializing fallback.  See the header comments for ownership rules.

## The ES module (not started)

One hand-written module, no framework: fetch() -> ReadableStream ->
`DasWasmRdr_feed` loop, a small credentials cache keyed by host and realm
(Basic auth via a script-set Authorization header; browsers no longer show
native auth dialogs for cross-origin fetches), and typed-array view
construction from the glue's type/size/shape answers.  Views must be
created only after a load completes: growing the wasm heap detaches them.

## Server-side findings (2026-10)

Anonymous dasFlex endpoints already send `Access-Control-Allow-Origin: *`,
so public data works from browsers today.  Authenticated endpoints do not:
the 401 responses carry no CORS headers and an OPTIONS preflight returns
500, so a browser can neither complete nor even diagnose an authenticated
request.  Fixing that is Apache configuration on the dasFlex side: answer
OPTIONS without authentication, allow the Authorization header, and emit
CORS headers on error responses too (`Header always set`).

## Decisions of 2026-10-18

* Expat is pinned as a second submodule (`deps/expat`, libexpat R_2_8_5) and
  compiled with emcc from a hand-written `buildfiles/expat_config.h`, since
  emscripten ships a zlib port but no expat port.  das2C's emscripten build
  takes the header location through `EXPAT_INC`, the same shape as its
  `CSPICE_INC` and `CDF_INC`, so das2C never learns where expat lives.
* FFTW is out of the first wasm build but expected back: spectrograms computed
  in C are a planned strength, so `dft.c` sits behind a `DFT=yes` switch in
  `Emscripten.mak` rather than being dropped from the source list.
* Rendering is out of scope.  das2js hands typed arrays and metadata to the
  existing JavaScript plotting libraries in the shapes they consume; it does
  not plot.
* Catalog navigation is in scope.  A tree view over the das federated catalog,
  using the try-and-fallback path walk from das2C's `node.c` (also
  reimplemented in dasFlex's `d3form.py`), is a GUI component das2js should
  provide.  It is JavaScript, not wasm: JSON and fetch are native there, which
  is the real reason `node.c` stays out of the archive.
* Browser testing is headless Firefox with a throwaway profile, driven by a
  small node runner that serves the build over HTTP and collects results the
  test page posts back.  Firefox only on the development machine.
* Four das2C bugs surfaced on the first wasm build and were fixed on the
  `feature/emscripten` branch.  `DasAry_append` returned `false` from a
  pointer-returning function.  The float to 64-bit integer range checks in
  `value.c` compared against `INT64_MAX`/`UINT64_MAX`, which round up to the
  next power of two as doubles and so let an overflowing value through.  And
  the loop in `tt2000.c` that builds the us2000 leap-second table from an
  external `CDF_LEAPSECONDSTABLE` file never advanced its write index and
  counted pairs where the consumer expects doubles, so most of that table was
  uninitialized memory; natively the garbage happened to produce a 2 second
  round-trip error inside the test's 10 second tolerance, under wasm it was
  11 seconds; the test's tolerance is now 10 us.  And `das_value_fromStr`
  read 64-bit integers from text with `sscanf("%Lu")`/`"%Ld"` on hosts whose
  `long` is 32 bits.  glibc takes `L` as a synonym for `ll`; musl, the libc
  under emscripten, parses the digits, reports success and stores nothing, so
  every text-encoded int64 in a stream would have come back as stale buffer
  contents.  It now uses `SCNu64`/`SCNd64`, as property.c already did.  None
  of the four is wasm-specific; the second compiler, the different heap and
  the different libc simply made them visible.
* Two more das2C findings were written up in the upstream checkout's
  `co_notes/` rather than fixed here, since neither is wasm-specific and both
  are design calls: `DasDsBldr` refuses das2 streams that redefine a packet
  id (`builder_packet_reuse.md`), and us2000/TT2000 conversions disagree by
  9 s for all instants before 1972 (`pre1972_us2k_tt2k_roundtrip.md`).
