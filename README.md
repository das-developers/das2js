# das2js

Das servers typically provide data relevant to space plasma and magnetospheric
physics research.  To retrieve data, an HTTP GET request is posted to a das
server by a client program and a self-describing stream of data values covering
the requested time range, at the requested time resolution, is provided in the
response body.  This project aims to read those streams in web browsers by
compiling [das2C](https://github.com/das-developers/das2C) to WebAssembly, so
parsing and value decoding happen in C and JavaScript receives typed-array
views of the decoded values without a conversion pass.

**Early days, but it runs.**  `make module` produces a three-file ES module
in `build.wasm32/` (`das2js.mjs`, `das2c.mjs`, `das2c.wasm`) that fetches a
das stream, parses it as it arrives, and hands back TypedArray views of the
decoded values, int64 and all.  It has read real data from a public dasFlex
server in Firefox.  No package, no minified build, no catalog browser, no
plotting; see `notes/design.md` for what is planned.  Layout:

  * `src/` - the hand-written ES module, one file
  * `glue/` - a small flat C interface over das2C, the wasm export surface
  * `test/` - the glue test (native and wasm under node) and the browser
    tests (headless Firefox via a node runner)
  * `deps/` - das2C and expat, pinned as git submodules and compiled in
  * `buildfiles/` - the hand-written expat configuration for wasm32
  * `notes/` - design decisions, build recipe, measurements

Like the other das2C bindings (das2py, das2dlm) this project pins a specific
das2C version and compiles it in, rather than tracking das2C head.
`notes/build.md` walks through the toolchain setup and a full test pass;
`git submodule update --init` fetches the pinned sources.

This repository was started in 2022 and promptly went dormant.  It is active
again as of October 2026, though if you need a working das client today,
das2py is the mature path and this is not yet an alternative.
