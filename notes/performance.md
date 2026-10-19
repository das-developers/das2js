# Parse throughput, native vs wasm

Measured 2026-10-19 on the first working wasm build, to answer "did we lose
the speed that was the point of doing this in C?"  Short answer: no for
binary streams, and text streams have one identifiable libc cost.

## Method

The browser path, nothing else: each fixture read fully into memory, then
pushed through the glue's `DasWasmRdr_feed` in 64 KB chunks (a typical
fetch() chunk) with the dataset builder attached, ten passes, no file I/O in
the timed region.  Native is gcc -O2 on the same machine (6 core x86_64, RHEL
8); wasm is emcc -O2 run under Node 24.  The harness source is a 60 line C
file; rebuild it from this description if needed, it is not kept.

## Results, MB/s

| fixture                        | kind        |  native |   wasm | ratio |
|--------------------------------|-------------|--------:|-------:|------:|
| ex27_epop_fai_mgf_blob.d3b     | das3 binary |     849 |    493 |  1.7x |
| ex18_juno_waves_wfrm.d3b       | das3 binary |     277 |    118 |  2.3x |
| ex17_vector_noframe.d3b        | das3 binary |      81 |     58 |  1.4x |
| ex24_isee_rapid_rank1.d3b      | das3 binary |      53 |     40 |  1.3x |
| ex05_vgr_pws_sa_peaks.d2s      | das2 binary |     163 |    110 |  1.5x |
| ex01_polar_mfe.d2s             | das2 binary |      62 |     48 |  1.3x |
| ex27_epop_fai_mgf_blob.d3t     | das3 text   |     354 |    218 |  1.6x |
| ex10_juno_waves_hfrh.d2t       | das2 text   |      25 |     13 |  1.9x |
| ex24_isee_rapid_rank1.d3t      | das3 text   |       9 |      5 |  1.8x |
| ex12_sounder_xyz.d3t           | das3 text   |      28 |      5 |  5.6x |
| ex08_cassini_rpws_survey.d2t   | das2 text   |      24 |    4.5 |  5.3x |

Binary streams run at 1.3x to 2.3x native, the usual WebAssembly tax, and at
40 to 490 MB/s they outrun any network the browser will see.  `-O3` and
`-flto` on the archive changed nothing outside noise (checked), so the build
stays at `-O2`.  Module size is about 450 KB of wasm for das2C plus expat
plus zlib plus libc.

## Why text streams fall off a cliff

A CPU profile of the ex08 run (recipe below) puts 80 percent of the time in
musl's `__floatscan`, `fmodl`, `__addtf3`, `__multf3` and `__extenddftf2`.
That is libc's text-to-float conversion, reached through the per-value
`sscanf` calls in `das_value_fromStr` (value.c), which the text decoder's
`_convert_n_store_text` (codec.c) makes once per value, and musl implements
it in `long double`.  On wasm32
`long double` is 128-bit IEEE quad with no hardware behind it, so every
decimal number costs a handful of software quad-precision operations.  glibc
on x86_64 takes a different route and `long double` is an x87 register, so the
native build never shows this.  The two text fixtures with the mild ratio are
dominated by something other than numbers (strings, small packets).

Consequences:

* Nothing to do in das2js.  Ask servers for binary (dasFlex's das3 default is
  already `format.serial=binary`; das2 servers send binary unless asked for
  text) and the problem does not arise.
* A real das2C improvement is available if text throughput ever matters: a
  hand-rolled decimal parser for the common case in the text decoder, falling
  back to strtod for the hard cases.  It would help native too, where 24 MB/s
  for text is also mostly libc overhead.  Parked, not started.

## Per-call overhead

Feeding one byte at a time (what `TestFeed` does to exercise every packet
boundary) runs at 35 MB/s native and 6.6 MB/s wasm on a 100 KB binary stream.
The gap is call overhead, not parsing, and chunks that small never occur in
practice.  It is why `make wasm_test` takes minutes; it is not a throughput
signal.

## Profiling recipe

Link the program of interest with `--profiling-funcs` so wasm function names
survive, run it under Node's sampler, and sum self time per frame:

    emcc -O2 --profiling-funcs ... -o prog.js
    node --cpu-prof --cpu-prof-dir=prof prog.js args...
    # prof/*.cpuprofile is JSON: nodes[].callFrame.functionName, samples[],
    # timeDeltas[]; a dozen lines of python sum timeDeltas per functionName.

Compiler-rt soft-float names (`__addtf3`, `__multf3`, `__extenddftf2`,
`fmodl`) mean long double; `__floatscan` is musl's strtod core.
