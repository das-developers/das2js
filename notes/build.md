# Building and testing das2js

## Prerequisites

* The submodule: `git submodule update --init` after a fresh clone.
  `deps/das2C` is the stream library.
* Network access for the first build.  das2C downloads and builds its own
  wasm dependencies, expat (from its GitHub releases) and FFTW (from
  fftw.org), checks each against a pinned SHA-256 and keeps them in
  `deps/das2C/deps.wasm32` until a `make distclean`.  If a download site
  is down, see the `*_URL` comments in das2C's `buildfiles/emscripten.mak`.
* emscripten via emsdk, last verified with 6.0.13, the version das2C's CI
  pins.  Install it anywhere user-writable, for example:

      git clone https://github.com/emscripten-core/emsdk.git ~/opt/emsdk
      cd ~/opt/emsdk && ./emsdk install 6.0.13 && ./emsdk activate 6.0.13

  emsdk bundles the Node that runs the tests; pass `NODE=...` to use another.
* For the browser tests: Firefox on PATH.  It runs headless with a throwaway
  profile, so a Firefox you have open is not disturbed.

## Toolchain into the shell

    source ~/opt/emsdk/emsdk_env.sh

emsdk needs Python 3.10 or newer.  Where the system `python3` is older (Rocky
9 ships 3.9, RHEL 8 3.6), bracket the line with two exports.  The second is
not a typo: `emsdk_env.sh` unsets the variable after using it, and `emcc`
needs it again.

    export EMSDK_PYTHON=/usr/bin/python3.12
    source ~/opt/emsdk/emsdk_env.sh
    export EMSDK_PYTHON=/usr/bin/python3.12

## Build

    make module

The deliverable is three files in `build.wasm32/`: `das2js.mjs` (the module
you import), `das2c.mjs` (its loader) and `das2c.wasm`.  Keep them together.

`make clean module DEBUG=yes` builds a version that keeps the C debug
information, for stepping through das2C in a browser debugger.  It is about
five times larger, so rebuild without it before deploying.

## Test

Each target builds what it needs.  ERROR lines inside a run are expected
when the run says they are intentional; the success line is the verdict.
In run order; when working only on das2js code, skip the `deps` rows.

| Command              | What it runs                                  | Success line                                      |
|----------------------|-----------------------------------------------|---------------------------------------------------|
| `make deps_test`     | das2C's own test suite as wasm under Node     | `All wasm test programs completed without errors` |
| `make test`          | the C glue test as wasm under Node            | `All FFI layer checks passed`                     |
| `make headless_test` | the module in headless Firefox, fixtures      | `All module checks passed`                        |
| `make live_test`     | same, against space.physics.uiowa.edu         | `All live checks passed`                          |
| `make local_test`    | same, against the dasFlex checkout next door  | `All live checks passed`                          |

`make deps_test` is the slow one, mostly das2C's `TestFeed`, and das2C's
own CI runs it at the pinned commit; run it when das2C is the suspect.
`make live_test` needs the network.  The headless targets take
`TEST_BROWSER=firefox`, the default and so far the only choice.

To use the pages in your own browser instead, run `make server` and load
the URL it prints; Ctrl-C stops it.  It opens an index of the test pages
and two tools:

* **Structure inspector:** give it any stream URL and it prints every
  dataset, dimension and variable as JSON, without the data values.  A
  fixture loads by default; `?url=...` bookmarks a stream.
* **Performance:** fetches a live stream (Juno Waves at Iowa by default),
  then re-parses the same bytes from memory so parser throughput shows
  separately from the network.

`make server PAGE=Perf.html` opens straight onto one page.

## Clean rebuild

    make clean       # this project's and das2C's wasm build output
    make distclean   # also das2C's downloaded dependencies

`clean` is the everyday reset, and the one to use after pulling a new das2C:
it rebuilds all of das2C's own code, which is quick.  It keeps
`deps/das2C/deps.wasm32/`, the expat and FFTW builds.  Use `distclean`
when a dependency itself is in doubt.  The next build downloads and
rebuilds them, which is several minutes, most of it compiling FFTW.

## When something fails

* The failing check names itself in the test output.
* In the browser tests, lines prefixed `firefox:` are Firefox's console, and
  das2C's log messages appear there too.  A
  `[GFX1-]: RenderCompositorSWGL failed mapping default framebuffer` line is
  headless Firefox without a GPU, not a failure.
* A link error `emcc: error: ... -Werror` after an emsdk upgrade is a new
  emscripten warning, not a code problem; see the warning flags in the
  Makefile.
