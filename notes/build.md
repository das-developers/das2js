# Building and testing das2js

## Prerequisites

* The submodules: `git submodule update --init` after a fresh clone.
  `deps/das2C` is the stream library, `deps/expat` its XML parser.
* emscripten via emsdk, last verified with 3.1.63 (6.0.12 has also worked).
  Install it anywhere user-writable, for example:

      git clone https://github.com/emscripten-core/emsdk.git ~/opt/emsdk
      cd ~/opt/emsdk && ./emsdk install 3.1.63 && ./emsdk activate 3.1.63

  emsdk bundles the Node that runs the tests; pass `NODE=...` to use another.
* For the browser tests: Firefox on PATH.  It runs headless with a throwaway
  profile, so a Firefox you have open is not disturbed.
* For the native test only: gcc and the das2C dev libraries (fftw3, expat,
  openssl, zlib).

## Toolchain into the shell

    source ~/opt/emsdk/emsdk_env.sh

emsdk needs Python 3.8 or newer.  Where the system `python3` is older (RHEL 8
ships 3.6), bracket the line with two exports.  The second is not a typo:
`emsdk_env.sh` unsets the variable after using it, and `emcc` needs it again.

    export EMSDK_PYTHON=/usr/bin/python3.12
    source ~/opt/emsdk/emsdk_env.sh
    export EMSDK_PYTHON=/usr/bin/python3.12

## Build

    make module

The deliverable is three files in `build.wasm32/`: `das2js.mjs` (the module
you import), `das2c.mjs` (its loader) and `das2c.wasm`.  Keep them together.

## Test

Each target builds what it needs.  ERROR lines inside a run are expected
when the run says they are intentional; the success line is the verdict.

| Command          | What it runs                               | Success line                                       |
|------------------|--------------------------------------------|----------------------------------------------------|
| `make wasm`      | the C glue test as wasm under Node, ~1 min | `All FFI layer checks passed`                      |
| `make browser`   | the module in headless Firefox, fixtures   | `All module checks passed`                         |
| `make live`      | same, against space.physics.uiowa.edu      | `All live checks passed`                           |
| `make wasm_test` | das2C's own test suite as wasm, slow       | `All wasm test programs completed without errors`  |
| `make test`      | the C glue test natively                   | `All FFI layer checks passed`                      |

`make live` needs the network.  `make wasm_test` takes several minutes;
nearly all of it is a test that feeds every fixture one byte at a time.

To open the test page in your own browser instead, run `make serve` and load
the URL it prints; Ctrl-C stops it.

## Clean rebuild

After pulling a new das2C, or when in doubt:

    make clean
    make -C deps/das2C EMSCRIPTEN=yes distclean
    make -C deps/das2C distclean

All three are needed: the native das2C library is only rebuilt when missing,
so `make test` would otherwise pass against a stale one.

## When something fails

* The failing check names itself in the test output.
* In the browser tests, lines prefixed `firefox:` are Firefox's console, and
  das2C's log messages appear there too.  A
  `[GFX1-]: RenderCompositorSWGL failed mapping default framebuffer` line is
  headless Firefox without a GPU, not a failure.
* A link error `emcc: error: ... -Werror` after an emsdk upgrade is a new
  emscripten warning, not a code problem; see the warning flags in the
  Makefile.
