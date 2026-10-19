# das2js

Das servers typically provide data relevant to space plasma and magnetospheric
physics research.  To retrieve data, an HTTP GET request is posted to a das
server by a client program and a self-describing stream of data values covering
the requested time range, at the requested time resolution, is provided in the
response body.  This project aims to read those streams in web browsers by
compiling [das2C](https://github.com/das-developers/das2C) to WebAssembly, so
parsing and value decoding happen in C and JavaScript receives typed-array
views of the decoded values without a conversion pass.

**There is nothing usable here yet.**  What exists so far:

  * `glue/` - a small flat C interface over das2C, the wasm export surface
  * `test/` - native-build checks for the glue, requires a built das2C
  * `notes/` - design notes, including the intended division of labor

Like the other das2C bindings (das2py, das2dlm) this project pins a specific
das2C version and compiles it in, rather than tracking das2C head.  The
idiomatic layer, an ES module wrapping fetch() and typed arrays, has not been
started.  No wasm module has even been built yet; only the native test runs.

This repository was started in 2022 and promptly went dormant.  It is active
again as of October 2026, though if you need a working das client today,
das2py is the mature path and this is not yet an alternative.
