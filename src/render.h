/* Copyright (C) 2026 Chris Piker
 *
 * This file is part of das2js, das stream utilities for browsers.
 * See the LICENSE file in the repository root for terms.
 *
 * das2js statically links das2C, which is LGPL 2.1; distributions of the
 * compiled WebAssembly module carry das2C's terms as well as these.
 */

#ifndef _das_render_h_
#define _das_render_h_

/** @file render.h Paint a raster from a das stream while it downloads.
 *
 * Paints pixels, not plots.  No axes, ticks, labels or color bar; the
 * output is an RGBA8 buffer for a canvas to blit.  Its job is to make
 * a performance test show the data arriving instead of a byte count.
 *
 * The renderer is a StreamHandler riding on a DasWasmRdr, after the
 * dataset builder.  It never feeds, owns or clears data; it reads what
 * the builder keeps.
 *
 * Kind of picture, decided once from the FIRST dataset header:
 *
 *   - Spectrogram: a coordinate dimension has axis "y".  Time across, the
 *     coordinate up, the data value colored.  Overlapping records keep
 *     the peak.  Each y bin is stretched over the pixel rows halfway to
 *     its neighbors, measured in axis space, so log axes get uniform
 *     spans.  Stretching is capped at a few pixels so real gaps stay
 *     black.
 *   - Density: no y coordinate.  Time across, the data value up, the
 *     color is log(count) of samples per pixel.  No fill-in.
 *
 * Later datasets are painted only if they have the same physical
 * dimensions as the first (DasDim_dim names, coordinate and data).
 * Others are counted in DasRender_skipped() and otherwise ignored.
 *
 * Ranges:
 *
 *   - X: always from the caller, see DasRender_setX(), before any data
 *     arrive.  It's the time range the request asked for, so the picture
 *     fills left to right and never slides.
 *   - Spectrogram Y: the union of the y coordinates seen in dataset
 *     headers.  A header that widens it repaints everything retained.
 *   - Data values (spectrogram Z, density Y): always auto-ranged.  Stream
 *     range properties are ignored; most were never tuned because the
 *     desktop tools autorange anyway.
 *       1. The first painted data set the range.
 *       2. When more than 5% of the points since the last rescale fall
 *          outside it, the range is refit.
 *       3. Once the paint has crossed 10% of the time range, the range
 *          is refit once more, which may narrow it.
 *     A refit takes the 0.1 to 99.9 percentile span, padded.  Spectrogram
 *     pixels hold raw values, so a Z refit only changes the colorize pass.
 *     A density refit moves points between rows, so everything retained
 *     is repainted.
 *   - Log or linear per axis from the dimension's "scaleType" property,
 *     else the stream's "<axis>ScaleType" (das3 streams keep it there;
 *     the das2 upconverter moves it onto the dimension).
 *
 * Fill values and NaN are never painted and never count toward range
 * decisions; neither do values <= 0 on a log axis.
 *
 * Lifetime rules, all hazards found in the browser:
 *
 *   - The renderer touches datasets only inside stream callbacks.
 *     Colorize and the read-out calls work from its own grid, so they're
 *     safe after the stream is freed.
 *   - The reader holds a pointer into the renderer.  Free the reader
 *     first (or at least stop feeding it) before del_DasRender().
 *   - DasRender_colorize() lends a pointer into the wasm heap.  A later
 *     feed may grow the heap and detach any JS view of it, so make a new
 *     view each frame; never cache it.
 */

#include "wasm.h"

#ifdef __cplusplus
extern "C" {
#endif

/** @addtogroup wasm
 * @{
 */

/** Renderer kinds reported by DasRender_kind() */
#define DASRENDER_NONE     0   /**< No dataset header seen yet */
#define DASRENDER_SPECTRO  1   /**< Colored values over time and a y coord */
#define DASRENDER_DENSITY  2   /**< Sample counts over time and value */
#define DASRENDER_UNUSABLE -1  /**< First dataset can't be painted, see
                                    DasRender_note() */

/** Paints an RGBA raster from datasets as they arrive.
 * @class DasRender
 */
typedef struct das_render DasRender;

/** Create a renderer with a blank (opaque black) image.
 *
 * The pixel grid and the RGBA output are allocated here, once.  Painting
 * never allocates image memory afterwards.
 *
 * @param nWidth  Image width in pixels, 16 to 8192
 * @param nHeight Image height in pixels, 16 to 8192
 * @returns a new renderer, or NULL (see daswasm_lastError)
 * @memberof DasRender
 */
DAS_WASM_API DasRender* new_DasRender(int nWidth, int nHeight);

/** Set the time range the image covers.
 *
 * Call before the first data packet is fed; afterwards it's refused.
 * Without a range nothing is painted.
 *
 * @param sBeg Start time, any form das2C parses, normally ISO 8601 UTC
 * @param sEnd End time, exclusive
 * @returns 0 or a positive error code
 * @memberof DasRender
 */
DAS_WASM_API int DasRender_setX(DasRender* pThis, const char* sBeg, const char* sEnd);

/** Replace the color map.
 *
 * Built in default: sampled from the color bar of the das2 desktop
 * spectrogram tools, deep blue for low through white to dark red for
 * high.  Index 0 is the lowest value; empty pixels are always opaque
 * black and don't use the map.
 *
 * @param pRgba 256 entries of 4 bytes each, R G B A; copied
 * @returns 0 or a positive error code
 * @memberof DasRender
 */
DAS_WASM_API int DasRender_setMap(DasRender* pThis, const ubyte* pRgba);

/** Start painting what this reader reads.
 *
 * Call before the first DasWasmRdr_feed(), since the renderer must see
 * the dataset headers.  One reader per renderer.
 *
 * @returns 0 or a positive error code
 * @memberof DasRender
 */
DAS_WASM_API int DasRender_attach(DasRender* pThis, DasWasmRdr* pRdr);

/** What kind of picture this is, one of the DASRENDER_ values */
DAS_WASM_API int DasRender_kind(const DasRender* pThis);

/** Build the RGBA image from the current grid.
 *
 * Meant for a display timer, not every chunk.  Density needs this pass
 * anyway because the log(count) scale moves as counts climb.  Cheap: one
 * pass over width x height.
 *
 * @returns pointer to width * height * 4 bytes, row 0 at the TOP, owned
 *          by the renderer.  Re-view each frame, see the file notes.
 * @memberof DasRender
 */
DAS_WASM_API const ubyte* DasRender_colorize(DasRender* pThis);

/** Nonzero if anything was painted since the last colorize.  Lets the
 * display timer skip a frame with nothing new. */
DAS_WASM_API int DasRender_dirty(const DasRender* pThis);

/** Milliseconds spent painting, including repaints, since creation.
 *
 * A sum of one interval per packet.  Browsers coarsen their clocks (to
 * 1 ms in some configurations) and a packet often paints faster than
 * that, so single intervals are mostly rounding; the sum over thousands of
 * packets averages out, a sum over a handful does not. */
DAS_WASM_API double DasRender_paintMs(const DasRender* pThis);

/** Values painted since creation, repaints included, so that
 * values / paintMs is the painter's rate.  Fill, values outside the time
 * range and values a log axis can't show are not counted.  A double
 * because a long waveform day passes 2^32. */
DAS_WASM_API double DasRender_values(const DasRender* pThis);

/** Number of times auto-ranging or a widened y coordinate forced a
 * repaint. */
DAS_WASM_API int DasRender_rescales(const DasRender* pThis);

/** Datasets ignored because their dimensions didn't match the first */
DAS_WASM_API int DasRender_skipped(const DasRender* pThis);

/** Why the picture is unusable or the last dataset was skipped, for the
 * page to show; "" if nothing went wrong.
 *
 * Renderer trouble never fails the stream read: the callbacks always let
 * parsing continue, and the reason lands here instead of in the das2C
 * error log. */
DAS_WASM_API const char* DasRender_note(const DasRender* pThis);

/** Current range of the vertical axis or the color axis.
 *
 * For a page caption ("10 Hz to 40 MHz, log"); this is not an axis
 * labeler.
 *
 * @param bColor 0 for vertical, 1 for color (spectrograms only)
 * @param bMax   0 for the minimum, 1 for the maximum
 * @returns the value in the dimension's units, or NaN if not yet known
 * @memberof DasRender
 */
DAS_WASM_API double DasRender_range(const DasRender* pThis, int bColor, int bMax);

/** Nonzero if the vertical (bColor 0) or color (bColor 1) axis is log */
DAS_WASM_API int DasRender_isLog(const DasRender* pThis, int bColor);

/** Units string for the vertical or color axis, "" if not yet known */
DAS_WASM_API const char* DasRender_units(const DasRender* pThis, int bColor);

/** Free the renderer.  Free or stop feeding the attached reader first. */
DAS_WASM_API void del_DasRender(DasRender* pThis);

/** @} */

#ifdef __cplusplus
}
#endif

#endif /* _das_render_h_ */
