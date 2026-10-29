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

## Getting doubles out of an int64 axis

The view is free; reading it is not always.  TT2000 is the common time base
in heliophysics and das2C stores it as int64, so `values()` on a time axis
is a BigInt64Array.  Every element read from one allocates a BigInt, and a
plotting library wants Numbers.  Converting one million values in
JavaScript, measured 2026-10-27 under Node 24 on the machine above:

| approach                                              |   time |
|-------------------------------------------------------|-------:|
| `Float64Array.from(big, Number)`                      | 404 ms |
| `for` loop, `out[i] = Number(big[i])`                 |  59 ms |
| `DasVar.doubles()` (one C loop, `daswasm_ary_doubles`) |   2 ms |
| plain Float64Array copy, the floor                    |   3 ms |

So use `v.doubles({ref: 'first', scale: 1e-9})` for a time axis, which
gives seconds from the first sample as a Float64Array, fill as NaN.  The
subtraction happens in int64 before the cast; a TT2000 value in the 2020s
is about 8e17 and a double quantizes it to 128 ns, so `Number(t) -
Number(t0)` is not the same number as `Number(t - t0)`.

## Live streams in a browser

The Performance page of `make server` (or `make server PAGE=Perf.html`)
fetches a stream from a server, then re-parses the same bytes from memory
to separate the parser from the network.  Measured 2026-10-21 in headless Firefox 143 on the machine above,
against the dasFlex server at space.physics.uiowa.edu:

| stream                                  |    bytes | wall  | first record | re-parse | MB/s |
|-----------------------------------------|---------:|------:|-------------:|---------:|-----:|
| Juno Waves survey, 2 days, 86.4 s bins  |   1.2 MB | 18.9 s |       485 ms |    55 ms |   21 |
| Juno Waves burst waveforms, 1 day       |   505 MB | 37.0 s |       466 ms |   330 ms | 1460 |
| same stream, in a Firefox window        |   505 MB | 36.3 s |       506 ms |   288 ms | 1673 |

The streams measured, the burst one being the page's Hammer my browser
preset:

    https://space.physics.uiowa.edu/das/stream/source/juno/wav/survey/flex?read.time.min=2018-10-02T11%3A00&read.time.max=2018-10-04T11%3A00&bin.time.max=86.4
    https://space.physics.uiowa.edu/das/stream/source/juno/wav/burst_waveforms/flex?read.time.min=2021-07-21&read.time.max=2021-07-22

The Quick test preset asks for the same survey days from the das2py-server
at jupiter.physics.uiowa.edu instead, at 1 minute display resolution: 1.75
MB in about 0.3 s from its stream cache, which the new server lacks so far.

    https://jupiter.physics.uiowa.edu/das/server?server=dataset&dataset=Juno/WAV/Survey&start_time=2018-10-02T11:00&end_time=2018-10-04T11:00&resolution=60

Wall time is dominated by the server: the burst day took `curl` the same
36 s, so parsing inside the download is free, and a progressive display can
start drawing half a second after the request.  The burst stream is
little-endian floats, which the parser copies at memory speed; the survey
is a das2 stream with text in it.  Viewing all 126 million elements costs
about 1 ms because the views are not copies.

### Painting while it downloads

Since 2026-10-29 the page also paints each packet into a raster as it is
parsed (src/render.c), and each re-parse is followed by a parse+paint pass
from memory.  [hammer_perf.png](hammer_perf.png) is the burst run in a
Firefox window that day:

* The first pixel showed at 740 ms, 67 ms after the first record.
* Painting took 4.6 s of the 38.4 s download, so it still hides inside the
  network time.
* The painter ran at 44 M values/s.  That counts the 201.7 M values it
  painted, including the repaints for 4 rescales, not just the 126 M in
  the stream.
* Parse+paint from memory took 4.8 s, 8 times faster than the network
  delivered the stream.  Parsing alone took 0.23 s.

Memory: the parsed burst day occupied 1.5 GB of WebAssembly heap for 505 MB
of values, because arrays grow by doubling and the heap never shrinks.
The default heap limit is 2 GB, so streams much over 600 MB will not load
in one piece today.

## Download size

The three files from `make module`:

| file         |     raw | gzip -9 |
|--------------|--------:|--------:|
| `das2c.wasm` |  495 KB |  202 KB |
| `das2c.mjs`  |   19 KB |    6 KB |
| `das2js.mjs` |   47 KB |   16 KB |

The `.wasm` holds das2C, the expat XML parser, zlib, the C library and the
raster painter.  Sizes as of 2026-10-29.
A `make module DEBUG=yes` build keeps the C debug information and is about
five times larger; don't deploy that one.
