# Performance

How fast das2js turns stream bytes into typed arrays, and what it costs to
load.  Short version: binary das streams parse far faster than any network
delivers them; text streams full of numbers are much slower, so ask servers
for binary.

## Parse throughput

Each stream was already in memory and fed to the parser in 64 KB chunks, the
size `fetch()` typically delivers, with datasets built as it went.  Network
time is not included.  Measured 2026-10-19 under Node 24 on a 6-core x86_64
Linux machine; browsers run the same WebAssembly but were not timed, so treat
these as indicative.

| example stream (das2C `examples/`)               | format      |  MB/s |
|--------------------------------------------------|-------------|------:|
| e-POP auroral arcs (`ex27_..._blob.d3b`)         | das3 binary |   490 |
| Juno Waves waveforms (`ex18_juno_waves_wfrm.d3b`) | das3 binary |   118 |
| Voyager PWS spectra (`ex05_vgr_pws_sa_peaks.d2s`) | das2 binary |   110 |
| vectors (`ex17_vector_noframe.d3b`)              | das3 binary |    58 |
| Polar MFE (`ex01_polar_mfe.d2s`)                 | das2 binary |    48 |
| ISEE RAPID (`ex24_isee_rapid_rank1.d3b`)         | das3 binary |    40 |
| e-POP auroral arcs, as text (`.d3t`)             | das3 text   |   218 |
| Juno Waves HFR (`ex10_juno_waves_hfrh.d2t`)      | das2 text   |    13 |
| ISEE RAPID, as text (`.d3t`)                     | das3 text   |     5 |
| sounder XYZ (`ex12_sounder_xyz.d3t`)             | das3 text   |     5 |
| Cassini RPWS survey (`ex08_..._survey.d2t`)      | das2 text   |   4.5 |

Binary streams run at 40 to 490 MB/s, within 1.3x to 2.3x of the same C
compiled natively.

Text streams that are mostly decimal numbers drop to about 5 MB/s.  The cost
is converting each number from text, which is slow in WebAssembly in a way it
is not natively.  Text streams whose bulk is not numbers, like the e-POP
one, are much less affected.

**Use binary.**  dasFlex servers send das3 binary by default
(`format.serial=binary`), and das2 servers send binary unless asked for text.

Once parsed, numeric values are not converted again: `DasVar.values()`
returns a TypedArray view over the parsed data in its stored type
(Float32Array, BigInt64Array for TT2000 times, and so on), not a copy.

## Download size

The three files from `make module`:

| file         |     raw | gzip -9 |
|--------------|--------:|--------:|
| `das2c.wasm` |  453 KB |  183 KB |
| `das2c.mjs`  |   26 KB |    7 KB |
| `das2js.mjs` |   31 KB |   11 KB |

The `.wasm` holds das2C, the expat XML parser, zlib and the C library.
A `make module DEBUG=yes` build keeps the C debug information and is about
five times larger; don't deploy that one.
