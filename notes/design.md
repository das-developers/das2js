# das2js design notes

Status: 2026-10-19.  Decisions from the das2C planning sessions that led to
this project's revival; recorded here so they don't live only in one
person's head (or one AI session's memory).

## Division of labor with das2C

das2C provides the mechanisms, das2js owns everything JavaScript-shaped:

* das2C: the push-mode stream parser (`DasIO_feed`, in das2C as of commit
  92ade6f), the `__EMSCRIPTEN__` portability defines, and eventually an
  `Emscripten.mak` that cross-compiles `libdas3.a` only -- the same role
  `Android.mak` plays.  No wasm export markup lives in das2C.
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
