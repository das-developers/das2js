/* Copyright (C) 2026 Chris Piker
 *
 * This file is part of das2js, das stream utilities for browsers.
 * See the LICENSE file in the repository root for terms.
 *
 * das2js statically links das2C, which is LGPL 2.1; distributions of the
 * compiled WebAssembly module carry das2C's terms as well as these.
 */

#ifndef _das_wasm_h_
#define _das_wasm_h_

/** @file wasm.h A flat C ABI over the das stream reader and data model for
 * foreign function interfaces, WebAssembly/JavaScript first among them.
 *
 * The das2C object model leans on macros, enums, structure members and
 * variadic helpers that a foreign runtime can't reach.  Everything here is a
 * plain function over pointers, integers, doubles and UTF-8 strings, which
 * is exactly what emscripten's cwrap/ccall marshal without help (and what
 * python ctypes, or any other FFI, can consume unaided).
 *
 * The intended JavaScript flow:
 *
 *   1. daswasm_init("myapp") once per runtime.
 *   2. new_DasWasmRdr() per stream download.
 *   3. fetch() the stream; for each chunk copy it into scratch heap space
 *      and call DasWasmRdr_feed().  Datasets grow as packets arrive, so the
 *      stream from DasWasmRdr_stream() may be walked mid-download for
 *      progressive display.
 *   4. DasWasmRdr_end() at EOF, then walk: stream -> datasets -> dims ->
 *      variables.
 *   5. For bulk values take the zero-copy route when a variable is array
 *      backed (daswasm_var_ary), falling back to daswasm_var_qube for
 *      computed variables and ragged data.  Wrap the returned pointer in a
 *      JS TypedArray view over the wasm heap; nothing is converted per
 *      value.
 *
 * Browser caveat that can't be fixed here: growing the wasm heap detaches
 * existing TypedArray views.  Create views after the stream completes and
 * re-create them after any call that may allocate.
 *
 * Ownership rules, uniform by prefix:
 *   - daswasm_var_ary() lends a pointer, never free it.
 *   - daswasm_var_qube() allocates, release with daswasm_ary_free().
 *   - daswasm_ary_times() allocates, release with daswasm_free().
 *   - Everything reachable from DasWasmRdr_stream() belongs to the reader
 *     unless DasWasmRdr_take() detached it.
 *
 * Nothing here is wasm-specific; the file compiles on every platform so the
 * contract is testable natively (see test/TestWasm.c).
 */

#include <das3/io.h>
#include <das3/builder.h>
#include <das3/dataset.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Under emscripten every public symbol here must survive dead code
 * elimination even though nothing in C calls it */
#ifdef __EMSCRIPTEN__
#define DAS_WASM_API EMSCRIPTEN_KEEPALIVE
#else
#define DAS_WASM_API DAS_API
#endif

/** @defgroup wasm FFI
 * Flat C ABI over stream reading and the dataset model for wasm/FFI use
 */

/** @addtogroup wasm
 * @{
 */

/** One-call library setup for foreign runtimes.
 *
 * Wraps das_init() with the fixed choices an FFI caller needs: errors
 * return instead of exiting (retrieve text via daswasm_lastError) and the
 * log rides at warning level.
 *
 * @param sProgName The name to use in error and log messages
 */
DAS_WASM_API void daswasm_init(const char* sProgName);

/** The text of the most recent das2C error, or an empty string. */
DAS_WASM_API const char* daswasm_lastError(void);

/** The shape sentinel meaning an index is ragged (varies with prior
 * indices).  Appears in daswasm_ds_shapeAt, daswasm_var_shapeAt and
 * daswasm_ary_shapeAt results.  All sentinels are negative; any value
 * greater than this one is a real extent. */
DAS_WASM_API int daswasm_idxRagged(void);

/** The shape sentinel meaning a variable does not vary along an index. */
DAS_WASM_API int daswasm_idxUnused(void);

/** The shape sentinel meaning a variable has no extent of its own along an
 * index and borrows the dataset's.  Seen on sequences and other computed
 * variables that run along a ragged index: the offset of a variable length
 * waveform has as many values per record as the waveform does. */
DAS_WASM_API int daswasm_idxBorrow(void);

/* ************************************************************************ */
/** Stream reader context: a feed-mode DasIO coupled to a DasDsBldr, plus
 * capture of out-of-band progress and exception packets, so a foreign
 * caller needs no callback plumbing at all -- push bytes, poll state.
 *
 * @extends DasIO
 * @class DasWasmRdr
 */
typedef struct das_wasm_rdr DasWasmRdr;

/** Create a stream reader context.
 *
 * The reader always up-converts das2 streams to the das3 data model, so a
 * foreign caller only ever sees DasDs datasets.
 *
 * @returns a new reader on the heap, or NULL (see daswasm_lastError)
 * @memberof DasWasmRdr
 */
DAS_WASM_API DasWasmRdr* new_DasWasmRdr(void);

/** Push a chunk of stream bytes into the reader.
 *
 * Chunks may be any size down to a single byte.  Complete packets are
 * parsed and folded into the dataset model before the call returns.
 *
 * @returns 0 (DAS_OKAY) or a positive error code.  Errors latch: once a
 *          stream is bad every further call reports the failure.
 * @memberof DasWasmRdr
 */
DAS_WASM_API int DasWasmRdr_feed(DasWasmRdr* pThis, const ubyte* pData, int nLen);

/** Signal end of input.
 *
 * @returns 0 (DAS_OKAY) if the stream ended on a packet boundary, a
 *          positive error code otherwise.
 * @memberof DasWasmRdr
 */
DAS_WASM_API int DasWasmRdr_end(DasWasmRdr* pThis);

/** The stream under construction (datasets, global properties).
 *
 * Valid as soon as the stream header has been fed and remains owned by the
 * reader unless DasWasmRdr_take() is called.
 * @memberof DasWasmRdr
 */
DAS_WASM_API DasStream* DasWasmRdr_stream(DasWasmRdr* pThis);

/** Take ownership of the stream away from the reader.
 *
 * After this call deleting the reader leaves the stream and all of its
 * datasets alive; release them later with daswasm_stream_free().
 * @memberof DasWasmRdr
 */
DAS_WASM_API DasStream* DasWasmRdr_take(DasWasmRdr* pThis);

/** Task progress gathered from stream comment packets, in the producer's
 * arbitrary units, or -1 if the producer never said.  Divide by
 * DasWasmRdr_taskSize() for a fraction.
 * @memberof DasWasmRdr
 */
DAS_WASM_API int DasWasmRdr_progress(const DasWasmRdr* pThis);

/** Task size gathered from stream comment packets, or -1.
 * @memberof DasWasmRdr
 */
DAS_WASM_API int DasWasmRdr_taskSize(const DasWasmRdr* pThis);

/** The text of the last in-stream exception packet, or an empty string.
 *
 * In-band exceptions (NoDataInInterval, server errors) are data about the
 * query, not parse failures; the parser keeps going.  Anything caught here
 * is usually what a user interface should display.
 * @memberof DasWasmRdr
 */
DAS_WASM_API const char* DasWasmRdr_exception(const DasWasmRdr* pThis);

/** Free the reader, the parser, and (unless taken) the stream.
 * @memberof DasWasmRdr
 */
DAS_WASM_API void del_DasWasmRdr(DasWasmRdr* pThis);

/** Free a stream previously detached with DasWasmRdr_take() */
DAS_WASM_API void daswasm_stream_free(DasStream* pSd);

/* ************************************************************************ */
/* Tree walk: stream -> dataset -> dimension -> variable.
 *
 * All returned pointers are borrowed from the stream.  A DasDs, DasDim or
 * DasStream pointer may also be passed to the daswasm_desc_* property
 * functions below; they are all descriptors. */

/** Number of datasets in the stream */
DAS_WASM_API int daswasm_strm_dsCount(DasStream* pSd);

/** The i-th dataset of a stream, NULL if out of range */
DAS_WASM_API DasDs* daswasm_strm_dsAt(DasStream* pSd, int i);

/** Number of properties attached to a descriptor (stream, ds or dim) */
DAS_WASM_API int daswasm_desc_propCount(const DasDesc* pDesc);

/** Name of the i-th property, NULL if out of range */
DAS_WASM_API const char* daswasm_desc_propName(const DasDesc* pDesc, int i);

/** Value of the i-th property as a UTF-8 string, NULL if out of range */
DAS_WASM_API const char* daswasm_desc_propValue(const DasDesc* pDesc, int i);

/** das3 type name of the i-th property ("string", "datetime", ...) */
DAS_WASM_API const char* daswasm_desc_propType(const DasDesc* pDesc, int i);

/** Dataset id string */
DAS_WASM_API const char* daswasm_ds_id(const DasDs* pDs);

/** Dataset join-group string */
DAS_WASM_API const char* daswasm_ds_group(const DasDs* pDs);

/** Number of whole-dataset (bulk) indices */
DAS_WASM_API int daswasm_ds_rank(const DasDs* pDs);

/** Extent of the i-th bulk index: a count, or the ragged sentinel.  The
 * first index is the stream-append direction and grows as packets arrive;
 * it is 0 for a dataset whose header has landed but whose data has not,
 * which is routine mid-stream and permanent when a producer declares a
 * packet type it never emits (das2C examples/ex08, packet id 06). */
DAS_WASM_API int daswasm_ds_shapeAt(const DasDs* pDs, int i);

/** Number of physical dimensions.  bCoord != 0 counts coordinate
 * dimensions, bCoord == 0 counts data dimensions. */
DAS_WASM_API int daswasm_ds_dimCount(const DasDs* pDs, int bCoord);

/** The i-th coordinate (bCoord != 0) or data (bCoord == 0) dimension */
DAS_WASM_API DasDim* daswasm_ds_dimAt(DasDs* pDs, int i, int bCoord);

/** Dimension id string ("time", "frequency", "B_mag", ...) */
DAS_WASM_API const char* daswasm_dim_id(const DasDim* pDim);

/** Non-zero if this is a coordinate dimension */
DAS_WASM_API int daswasm_dim_isCoord(const DasDim* pDim);

/** Number of variables in a dimension */
DAS_WASM_API int daswasm_dim_varCount(const DasDim* pDim);

/** The i-th variable of a dimension, NULL if out of range */
DAS_WASM_API DasVar* daswasm_dim_varAt(DasDim* pDim, int i);

/** The role of the i-th variable ("center", "min", "max", "reference", ...) */
DAS_WASM_API const char* daswasm_dim_roleAt(DasDim* pDim, int i);

/* ************************************************************************ */
/* Variables: dataset-shaped views of values */

/** The units string for a variable, "" for dimensionless */
DAS_WASM_API const char* daswasm_var_units(const DasVar* pVar);

/** The storage element type name, exactly as das_vt_toStr() prints it:
 * "ubyte", "byte", "ushort", "short", "uint", "int", "ulong", "long",
 * "float", "double", "das_time", "char*" (text), or "ubyte*" (byte runs).
 * Composite variables (vectors, matrices, complex values) report the type
 * of one storage element; their geometry is in the intrinsic shape and
 * their component names come from daswasm_var_compSym(). */
DAS_WASM_API const char* daswasm_var_valType(const DasVar* pVar);

/** Extent of a variable along the i-th BULK dataset index: a count (0 for
 * no records yet), the ragged sentinel, the borrow sentinel, or the unused
 * sentinel where the variable repeats (broadcasts) along that index.  i
 * runs to daswasm_ds_rank(). */
DAS_WASM_API int daswasm_var_shapeAt(const DasVar* pVar, int i);

/** Number of intrinsic (per-record internal) indices: 0 for scalars, 1 for
 * vectors and strings, more for matrices etc. */
DAS_WASM_API int daswasm_var_intrRank(const DasVar* pVar);

/** Extent of the i-th intrinsic index (3 for a 3-vector), or the ragged
 * sentinel for variable length items such as text */
DAS_WASM_API int daswasm_var_intrShapeAt(const DasVar* pVar, int i);

/** Component symbol of the i-th intrinsic component of a vector variable
 * ("x","y","z","r",...), NULL if not a vector or out of range */
DAS_WASM_API const char* daswasm_var_compSym(const DasVar* pVar, int i);

/** Non-zero if values convert to doubles (numeric or time elements) */
DAS_WASM_API int daswasm_var_isNumeric(const DasVar* pVar);

/** The backing array of a variable, or NULL for computed variables
 * (sequences, operations).
 *
 * This is the zero-copy path: the pointer from daswasm_ary_data() on the
 * result aims directly at the decoded stream values in the wasm heap.  The
 * array belongs to the dataset, do NOT pass it to daswasm_ary_free().
 * @memberof DasVar
 */
DAS_WASM_API DasAry* daswasm_var_ary(DasVar* pVar);

/** Every value of a variable as a newly allocated rectangular array.
 *
 * The universal fallback: works for computed variables and squares off
 * ragged data with fill (see DasVar_materializeQube for the fine print,
 * including why variable length blobs are refused).  One copy is made.
 * Free the result with daswasm_ary_free().
 *
 * Fails for a variable that BORROWS an extent (see daswasm_idxBorrow);
 * such a variable has no shape of its own to square off to, so use
 * daswasm_var_qubeLike() with a donor.
 *
 * @returns a new DasAry owning its memory, or NULL on error
 * @memberof DasVar
 */
DAS_WASM_API DasAry* daswasm_var_qube(DasVar* pVar);

/** daswasm_var_qube() wearing another variable's shape.
 *
 * The offset sequence of a variable length waveform runs along the
 * waveform's ragged index with no extent of its own; the waveform
 * variable is the donor that says how many offsets each record needs.
 * Any variable of the same dataset with a settled extent along the
 * borrowed index will do.  pShapeFrom NULL is daswasm_var_qube().
 *
 * @returns a new DasAry owning its memory, or NULL on error
 * @memberof DasVar
 */
DAS_WASM_API DasAry* daswasm_var_qubeLike(DasVar* pVar, const DasVar* pShapeFrom);

/* ************************************************************************ */
/* Arrays: the actual bytes */

/** Element type name of an array, see daswasm_var_valType */
DAS_WASM_API const char* daswasm_ary_valType(const DasAry* pAry);

/** Bytes per element.  With the type name this selects the TypedArray
 * flavor: ("float",4) -> Float32Array, ("double",8) -> Float64Array,
 * ("long",8) -> BigInt64Array, etc. */
DAS_WASM_API int daswasm_ary_valSize(const DasAry* pAry);

/** Number of array indices (may exceed the variable's intrinsic rank by
 * one, the record index) */
DAS_WASM_API int daswasm_ary_rank(const DasAry* pAry);

/** Extent of the i-th array index, or the ragged sentinel */
DAS_WASM_API int daswasm_ary_shapeAt(const DasAry* pAry, int i);

/** Total number of elements in the array (ragged safe) */
DAS_WASM_API int daswasm_ary_size(const DasAry* pAry);

/** Pointer to the first element of the contiguous element store.
 *
 * daswasm_ary_size() elements of daswasm_ary_valSize() bytes follow in
 * C index order.  For "text" and "byteseq" arrays the elements are
 * internal pointers; use daswasm_ary_textAt() instead.
 *
 * @returns the element pointer, or NULL for an empty array (which is not
 *          an error: check daswasm_ary_size() first)
 * @memberof DasAry
 */
DAS_WASM_API const ubyte* daswasm_ary_data(DasAry* pAry);

/** The i-th string of a "text" array (flat index), NULL if out of range */
DAS_WASM_API const char* daswasm_ary_textAt(DasAry* pAry, int i);

/* Partial-index access, for ragged arrays.
 *
 * The flat daswasm_ary_data() view is only navigable when every index has
 * a fixed extent.  A ragged array (variable length waveforms, utf8 strings
 * stored as byte runs, a differing number of items per record) needs the
 * extent of each sub-array looked up as the walk descends.  These take a
 * PARTIAL location: the first nLoc indices, nLoc from 0 to rank - 1, and
 * answer for the sub-array underneath.  Text variables use this path: a
 * "char*" variable is usually backed by a "ubyte" array one rank higher,
 * whose last index runs over the bytes of each string. */

/** Extent of the next index below a partial location.  Equals
 * daswasm_ary_shapeAt(nLoc) unless that index is ragged.  -1 on error. */
DAS_WASM_API int daswasm_ary_lengthAt(const DasAry* pAry, const int* pLoc, int nLoc);

/** Total elements in the sub-array at a partial location; the number of
 * elements daswasm_ary_dataAt() points to.  -1 on error. */
DAS_WASM_API int daswasm_ary_sizeAt(DasAry* pAry, const int* pLoc, int nLoc);

/** Pointer to the first element of the (contiguous) sub-array at a partial
 * location, NULL if empty or out of range.  Zero-copy like
 * daswasm_ary_data(), of which it is the generalization: nLoc = 0 gives the
 * same answer. */
DAS_WASM_API const ubyte* daswasm_ary_dataAt(DasAry* pAry, const int* pLoc, int nLoc);

/** Convert a "time" element array to doubles.
 *
 * Handy only for text-encoded streams; binary das3 streams keep time as
 * numeric elements which flow through the zero-copy path untouched.
 *
 * @returns a newly allocated array of daswasm_ary_size() doubles holding
 *          seconds since 1958-01-01 ignoring leap seconds (das2C internal
 *          time, see dt_ttime), or NULL if the array does not hold time
 *          elements.  Free with daswasm_free().
 * @memberof DasAry
 */
DAS_WASM_API double* daswasm_ary_times(DasAry* pAry);

/** Release an array obtained from daswasm_var_qube() */
DAS_WASM_API void daswasm_ary_free(DasAry* pAry);

/** Release a buffer obtained from daswasm_ary_times() */
DAS_WASM_API void daswasm_free(void* pBuf);

/** @} */

#ifdef __cplusplus
}
#endif

#endif /* _das_wasm_h_ */
