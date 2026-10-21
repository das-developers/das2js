# Building and testing das2js

A full pass, in the order worth running it.  Everything starts from the das2js
checkout.  Status: 2026-10-20.  What gets tested: the C glue natively and as
WebAssembly, das2C's own suite on wasm32, the ES module under headless
Firefox against fixtures, and the same against a live dasFlex server.

## Prerequisites

* Submodules checked out: `git submodule update --init` after a fresh clone.
  `deps/das2C` is the stream library, `deps/expat` its XML parser (emscripten
  ships a zlib port but no expat port).
* emscripten via emsdk.  Verified green with 3.1.63 and 6.0.12; anything in
  between should do.
  Install it anywhere user-writable, for example:

      git clone https://github.com/emscripten-core/emsdk.git ~/opt/emsdk
      cd ~/opt/emsdk && ./emsdk install 6.0.12 && ./emsdk activate 6.0.12

  emsdk's wrapper scripts need Python 3.8 or newer.  On a host whose `python3`
  is older (RHEL 8 ships 3.6) name a newer interpreter in `EMSDK_PYTHON`, see
  step 1.
* Node to run the output.  emsdk bundles one and the env script exports its
  path as `EMSDK_NODE`, which the Makefiles use.  Pass `NODE=...` to use
  another.
* For the native side only: gcc plus the usual das2C dev libraries (fftw3,
  expat, openssl, zlib).
* For the browser tests: Firefox on PATH.  The runner starts it headless with
  a throwaway profile under `./tmp`, so a running Firefox session is not
  disturbed.  Nothing else; the runner is node's http module.

## 1. Toolchain into the shell

On a host whose `python3` is 3.8 or newer this is one line:

    source /path/to/emsdk/emsdk_env.sh
    emcc --version | head -1      # emcc (Emscripten gcc/clang-like replacement ...) 3.1.63

On a host with an older system python (RHEL 8) bracket it with two exports.
The second is not a typo: `emsdk_env.sh` reads `EMSDK_PYTHON` to run itself
and then unsets it, while `emcc` needs it again.

    export EMSDK_PYTHON=/usr/bin/python3.12
    source /path/to/emsdk/emsdk_env.sh
    export EMSDK_PYTHON=/usr/bin/python3.12

If the version check dies with a Python SyntaxError, the first export did not
take.

## 2. Start from nothing (optional)

The honest test of the build is a clean one.  Neither target needs the
toolchain.

    make clean
    make -C deps/das2C EMSCRIPTEN=yes distclean

## 3. The glue test as WebAssembly under Node

Builds `libexpat.a` for wasm32, cross-compiles the das2C archive
(`deps/das2C/build.wasm32/libdas3.a`), links `test/TestWasm.c` against both
and runs it under Node.  About a minute from clean.  The run ends with

    INFO: All FFI layer checks passed

Command:

    make wasm

## 4. das2C's regression suite as WebAssembly

Eighteen of das2C's test programs compiled to Node scripts and run over every
stream fixture.  Several minutes, nearly all of it in TestFeed, which re-feeds
every fixture one byte at a time to hit every packet boundary; that is call
overhead, not parse speed (see performance.md for the real numbers).  Ends
with

    INFO: All wasm test programs completed without errors

Command:

    make wasm_test

The programs that need sockets, credentials or SPICE are not in the list; see
the header of `deps/das2C/buildfiles/Emscripten.mak` for what is excluded from
the archive and why.

## 5. The browser module under headless Firefox

Links the deliverable, `build.wasm32/das2c.wasm` with its loader `das2c.mjs`
and the hand-written `das2js.mjs` beside them, then serves `build.wasm32/`,
`test/browser/` and the das2C checkout over a local port and loads
`test/browser/TestModule.html` in Firefox.  The page walks the same fixtures
as TestWasm through the module, posts its lines back, and the runner exits
with the page's verdict.  About ten seconds.  Ends with

    INFO: All module checks passed
    INFO: page reported success

Command:

    make browser

`make module` alone just builds.  To poke at the page by hand,
`node test/browser/run.mjs --keep` prints the URL it is serving; open it in a
normal browser while the runner waits (90 s), or run any static server over
the repository root and open `test/browser/TestModule.html` yourself, with
`/build/` mapped to `build.wasm32/`.

## 6. The live server

Same runner, `test/browser/TestLive.html`: fetches two hours of Juno Waves
survey spectra from space.physics.uiowa.edu (anonymous for data older than
six months, CORS enabled) and checks the datasets, then provokes a 400 and
checks it surfaces as a DasError.  Needs the network and the server.

    make live

A WARNING about missing exception text is expected until that server sends
CORS headers on error replies; see notes/design.md.

## 7. The native side

Confirms the `DAS_NO_NETWORK` / `DAS_NO_DFT` guards and any das2C fixes cost
the gcc build nothing.  The archive, utilities and test programs land in
`deps/das2C/build./`, then the full native suite runs, then the native glue
test.

    make -C deps/das2C -j6 build
    make -C deps/das2C test      # All core test programs completed without errors
    make test                    # native TestWasm: All FFI layer checks passed

Use these targets, not paths under `build./`.  That directory name carries a
trailing dot and the rules are spelled with a double slash, so
`make build./something` matches no rule and quietly runs whatever stale binary
is there.

## 8. Reading the diffs

    git -C deps/das2C status --short
    git -C deps/das2C diff
    git status --short
    git diff

## When something fails

Steps 3 through 6 print the test program's own output, so a failing check
names itself.  In the browser steps, lines prefixed `firefox:` are Firefox's
own console; das2C's log goes there too (as `console.error`), which is where a
parse error's text appears if the page never gets to report.  Step 3 failing at link with `emcc: error: ... -Werror` is a new
emscripten warning; the two already waived are listed in the Makefile.  Step 4
is `make -C deps/das2C EMSCRIPTEN=yes ... test` underneath, and make stops at
the first failing program; run that program by hand from `deps/das2C` to see
everything it printed:

    cd deps/das2C && $EMSDK_NODE build.wasm32/TestTT2000.js
