# Building and testing das2js

A full pass, in the order worth running it.  Everything starts from the das2js
checkout.  Status: 2026-10-19, before the ES module exists; what gets tested
is the C glue compiled to WebAssembly plus das2C's own suite on that target.

## Prerequisites

* Submodules checked out: `git submodule update --init` after a fresh clone.
  `deps/das2C` is the stream library, `deps/expat` its XML parser (emscripten
  ships a zlib port but no expat port).
* emscripten via emsdk, any recent release (6.0.12 at the time of writing).
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

## 1. Toolchain into the shell

The second export is not a typo: `emsdk_env.sh` reads `EMSDK_PYTHON` to run
itself and then unsets it, while `emcc` needs it again.

    cd /path/to/das2js
    export EMSDK_PYTHON=/usr/bin/python3.12
    source /path/to/emsdk/emsdk_env.sh
    export EMSDK_PYTHON=/usr/bin/python3.12
    emcc --version | head -1      # emcc (Emscripten gcc/clang-like replacement ...) 6.0.12

If the version check dies with a Python SyntaxError, the first export did not
take.  On a host whose `python3` is already 3.8 or newer, skip both exports.

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

## 5. The native side

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

## 6. Reading the diffs

    git -C deps/das2C status --short
    git -C deps/das2C diff
    git status --short
    git diff

## When something fails

Steps 3 and 4 print the test program's own output, so a failing check names
itself.  Step 3 failing at link with `emcc: error: ... -Werror` is a new
emscripten warning; the two already waived are listed in the Makefile.  Step 4
is `make -C deps/das2C EMSCRIPTEN=yes ... test` underneath, and make stops at
the first failing program; run that program by hand from `deps/das2C` to see
everything it printed:

    cd deps/das2C && $EMSDK_NODE build.wasm32/TestTT2000.js
