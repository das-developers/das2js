/* Copyright (C) 2026 Chris Piker
 *
 * This file is part of das2js, das stream utilities for browsers.
 * See the LICENSE file in the repository root for terms.
 */

/* das2js: read das streams in the browser.
 *
 * This module is the idiomatic JavaScript face of das2C compiled to
 * WebAssembly.  The layering, bottom to top:
 *
 *   das2c.wasm    das2C + expat + the flat C glue from glue/wasm.c
 *   das2c.mjs     emscripten's generated loader.  Exports one factory
 *                 function which fetches and instantiates the .wasm and
 *                 resolves to the "Module" object: the heap views, the
 *                 cwrap() marshaller, and every exported C function with a
 *                 leading underscore (_daswasm_init, ...).
 *   das2js.mjs    this file.  Wraps those C functions in classes that hold
 *                 the C pointers for you and hand back TypedArrays.
 *
 * Why so much C and so little JS?  Stream parsing and value decoding stay in
 * C where das2C already does them.  The decoded values sit in the wasm heap,
 * which from JavaScript is one big ArrayBuffer.  A TypedArray view over a
 * slice of that buffer costs nothing per element, so a million doubles reach
 * a plotting library without ever being touched by JavaScript code.  That is
 * the whole performance argument, and it is why value types are preserved
 * exactly (int64 stays int64 in a BigInt64Array) rather than flattened to
 * JavaScript numbers on the way out.
 *
 * One hazard follows from that design and is worth understanding up front.
 * The wasm heap can GROW while a stream is being parsed (ALLOW_MEMORY_GROWTH
 * at link time).  Growing means a new, larger ArrayBuffer replaces the old
 * one, and every TypedArray view over the old buffer becomes detached: zero
 * length, silently.  So: views are created on demand by DasVar.values(), never
 * cached here, and callers should take them after a load completes and not
 * hold them across another load.  If you must keep values, copy them
 * (TypedArray.prototype.slice) and the copy is yours forever.
 */

import createDas3Module from './das2c.mjs';

/* ************************************************************************ */
/* Value type mapping
 *
 * The C side names element types with das2C's own vocabulary; see
 * daswasm_var_valType() in glue/wasm.h.  Each numeric one has exactly one
 * TypedArray flavor.  "das_time" is a broken-down calendar struct, "char*"
 * and "ubyte*" are internal pointers to variable length items; none of those
 * three can be viewed directly and DasVar.values() handles them separately. */
const TYPED_ARRAYS = {
	'ubyte':  Uint8Array,
	'byte':   Int8Array,
	'ushort': Uint16Array,
	'short':  Int16Array,
	'uint':   Uint32Array,
	'int':    Int32Array,
	'ulong':  BigUint64Array,
	'long':   BigInt64Array,
	'float':  Float32Array,
	'double': Float64Array,
};

const UTF8 = new TextDecoder('utf-8');

/* ************************************************************************ */

/** Load the WebAssembly module and initialize the library.
 *
 * Call once per page (or worker) and keep the result; every other object in
 * this module is created through it.
 *
 * @param {object} [opts]
 * @param {string} [opts.progName='das2js'] Name das2C uses in log and error
 *        messages
 * @param {function} [opts.locateFile] Passed through to emscripten.  By
 *        default the .wasm is fetched from beside das2c.mjs; give a
 *        function (path, prefix) => url to put it elsewhere.
 * @returns {Promise<DasRuntime>}
 */
export async function load(opts = {})
{
	const emOpts = {};
	if(opts.locateFile) emOpts.locateFile = opts.locateFile;

	const m = await createDas3Module(emOpts);
	return new DasRuntime(m, opts.progName || 'das2js');
}

/** The library handle: owns the wasm instance and creates readers.
 *
 * Make ONE per page or per worker and keep it.  Each instance is a separate
 * WebAssembly instantiation with its own heap (two megabytes before any data
 * arrives), and handles from one runtime are meaningless to another.  It is
 * not a connection: one runtime serves any number of servers and streams.
 *
 * Also the place where the C functions are wrapped.  cwrap(name, ret, args)
 * returns a JavaScript function that converts arguments ('string' means
 * copy a JS string into the heap as UTF-8 for the duration of the call,
 * 'number' covers ints, doubles AND pointers, which are just 32-bit ints
 * in wasm32) and converts the return value back.  Functions that return C
 * strings get 'string' and come back as JS strings; a NULL pointer becomes
 * the empty string, so this module checks counts before asking for names.
 */
export class DasRuntime {
	#m;      /* the emscripten Module object */
	#c;      /* the cwrapped C functions, by their C names */

	constructor(m, progName)
	{
		this.#m = m;

		const w = (name, ret, args) => m.cwrap(name, ret, args);
		const N = 'number', S = 'string';
		this.#c = {
			init:          w('daswasm_init', null, [S]),
			lastError:     w('daswasm_lastError', S, []),
			idxRagged:     w('daswasm_idxRagged', N, []),
			idxUnused:     w('daswasm_idxUnused', N, []),
			idxBorrow:     w('daswasm_idxBorrow', N, []),

			newRdr:        w('new_DasWasmRdr', N, []),
			feed:          w('DasWasmRdr_feed', N, [N, N, N]),
			end:           w('DasWasmRdr_end', N, [N]),
			rdrStream:     w('DasWasmRdr_stream', N, [N]),
			rdrTake:       w('DasWasmRdr_take', N, [N]),
			rdrProgress:   w('DasWasmRdr_progress', N, [N]),
			rdrTaskSize:   w('DasWasmRdr_taskSize', N, [N]),
			rdrException:  w('DasWasmRdr_exception', S, [N]),
			delRdr:        w('del_DasWasmRdr', null, [N]),
			streamFree:    w('daswasm_stream_free', null, [N]),

			strmDsCount:   w('daswasm_strm_dsCount', N, [N]),
			strmDsAt:      w('daswasm_strm_dsAt', N, [N, N]),
			propCount:     w('daswasm_desc_propCount', N, [N]),
			propName:      w('daswasm_desc_propName', S, [N, N]),
			propValue:     w('daswasm_desc_propValue', S, [N, N]),
			propType:      w('daswasm_desc_propType', S, [N, N]),

			dsId:          w('daswasm_ds_id', S, [N]),
			dsGroup:       w('daswasm_ds_group', S, [N]),
			dsRank:        w('daswasm_ds_rank', N, [N]),
			dsShapeAt:     w('daswasm_ds_shapeAt', N, [N, N]),
			dsDimCount:    w('daswasm_ds_dimCount', N, [N, N]),
			dsDimAt:       w('daswasm_ds_dimAt', N, [N, N, N]),

			dimId:         w('daswasm_dim_id', S, [N]),
			dimIsCoord:    w('daswasm_dim_isCoord', N, [N]),
			dimVarCount:   w('daswasm_dim_varCount', N, [N]),
			dimVarAt:      w('daswasm_dim_varAt', N, [N, N]),
			dimRoleAt:     w('daswasm_dim_roleAt', S, [N, N]),

			varUnits:      w('daswasm_var_units', S, [N]),
			varValType:    w('daswasm_var_valType', S, [N]),
			varShapeAt:    w('daswasm_var_shapeAt', N, [N, N]),
			varIntrRank:   w('daswasm_var_intrRank', N, [N]),
			varIntrShapeAt:w('daswasm_var_intrShapeAt', N, [N, N]),
			varCompSym:    w('daswasm_var_compSym', S, [N, N]),
			varIsNumeric:  w('daswasm_var_isNumeric', N, [N]),
			varAry:        w('daswasm_var_ary', N, [N]),
			varQube:       w('daswasm_var_qubeLike', N, [N, N]),

			aryValType:    w('daswasm_ary_valType', S, [N]),
			aryValSize:    w('daswasm_ary_valSize', N, [N]),
			aryRank:       w('daswasm_ary_rank', N, [N]),
			aryShapeAt:    w('daswasm_ary_shapeAt', N, [N, N]),
			arySize:       w('daswasm_ary_size', N, [N]),
			aryData:       w('daswasm_ary_data', N, [N]),
			aryTextAt:     w('daswasm_ary_textAt', S, [N, N]),
			aryLengthAt:   w('daswasm_ary_lengthAt', N, [N, N, N]),
			arySizeAt:     w('daswasm_ary_sizeAt', N, [N, N, N]),
			aryDataAt:     w('daswasm_ary_dataAt', N, [N, N, N]),
			aryTimes:      w('daswasm_ary_times', N, [N]),
			aryFree:       w('daswasm_ary_free', null, [N]),
			free:          w('daswasm_free', null, [N]),
		};

		this.#c.init(progName);

		/* The shape sentinels are C constants; fetch them once rather than
		 * hard-coding numbers that das2C is free to change.  All are
		 * negative, so (n > RAGGED) reads as "a real extent". */
		this.RAGGED = this.#c.idxRagged();
		this.BORROW = this.#c.idxBorrow();
		this.UNUSED = this.#c.idxUnused();

		/* Partial-index calls take a C int array.  das2C arrays have at most
		 * 8 indices, so one 32-byte scratch buffer serves every call. */
		this.#loc = m._malloc(8 * 4);
	}
	#loc;

	/* Copy a JavaScript index list into the scratch buffer and return its
	 * heap address.  HEAP32 is indexed in 4-byte units, hence the >> 2. */
	_loc(loc)
	{
		if(loc.length > 8) throw new RangeError('index list longer than 8');
		this.#m.HEAP32.set(loc, this.#loc >> 2);
		return this.#loc;
	}

	/* Internal accessors for the sibling classes in this file.  JavaScript
	 * has no "package private", so these are plain methods; the leading
	 * underscore is the convention for "not part of the public contract". */
	_c(){ return this.#c; }
	_m(){ return this.#m; }

	/** The most recent das2C error message, or '' */
	lastError(){ return this.#c.lastError(); }

	/** A push-mode stream reader, for feeding bytes you obtained yourself */
	newReader(){ return new DasReader(this); }

	/** Fetch a URL and parse the response body as a das stream.
	 *
	 * This is the common path and shows the intended use of DasReader: the
	 * response body is a ReadableStream of Uint8Array chunks (whatever size
	 * the network layer delivers), each is pushed into the parser as it
	 * arrives, and complete packets are folded into datasets right away.
	 * The datasets are therefore readable mid-download through the onChunk
	 * callback, which is how a progress meter or progressive plot works.
	 *
	 * @param {string|URL|Request} url
	 * @param {object} [opts]
	 * @param {AbortSignal} [opts.signal] Cancels the fetch
	 * @param {object} [opts.headers] Extra request headers (Authorization...)
	 * @param {function} [opts.onChunk] Called as (reader, bytesSoFar) after
	 *        every chunk is parsed.  The reader's stream() may be walked.
	 * @returns {Promise<DasStream>} the completed stream, which the caller
	 *        owns: call DasStream.free() when done with it
	 * @throws {DasError} on HTTP failure or parse failure
	 */
	async fetchStream(url, opts = {})
	{
		const init = {};
		if(opts.signal) init.signal = opts.signal;
		if(opts.headers) init.headers = opts.headers;

		/* fetch() rejects with a bare TypeError for everything the browser
		 * refuses to show a script: no network, bad TLS, and above all a
		 * cross-origin response without Access-Control-Allow-Origin.  das
		 * servers that send that header on 200 but not on error responses
		 * produce exactly this on a bad query, so say so. */
		let resp;
		try{ resp = await fetch(url, init); }
		catch(e){
			if(e.name === 'AbortError') throw e;
			throw new DasError(`fetch failed for ${url}: ${e.message}.  Across origins this `
				+ `usually means the response lacked CORS headers; servers often omit them `
				+ `on error status replies, hiding the real message.`);
		}
		if(!resp.ok)
			throw new DasError(`HTTP ${resp.status} ${resp.statusText} for ${url}`,
			                    await this.#errorBody(resp));

		const rdr = this.newReader();
		let nBytes = 0;
		try{
			const body = resp.body.getReader();
			for(;;){
				const {done, value} = await body.read();
				if(done) break;
				rdr.feed(value);
				nBytes += value.length;
				if(opts.onChunk) opts.onChunk(rdr, nBytes);
			}
			rdr.end();
			return rdr.take();
		}
		finally{
			/* DasReader.free() frees the stream too unless take() succeeded, so
			 * this is correct on both the success and the throw path */
			rdr.free();
		}
	}

	/* das servers answer a bad query with an HTTP error status AND a tiny das
	 * stream whose only packet is an <exception>, with the message a user
	 * needs to see ("Invalid query...", "No data in interval").  Feed that
	 * body through a throwaway reader to get the message out; if the body is
	 * not a das stream at all (an Apache error page), return its first line. */
	async #errorBody(resp)
	{
		let bytes;
		try{ bytes = new Uint8Array(await resp.arrayBuffer()); }
		catch(e){ return ''; }
		if(bytes.length === 0) return '';

		const rdr = this.newReader();
		try{
			rdr.feed(bytes);
			rdr.end();
			return rdr.exception;
		}
		catch(e){
			return UTF8.decode(bytes.subarray(0, 200)).split('\n')[0];
		}
		finally{ rdr.free(); }
	}
}

/** Thrown for parse failures and HTTP errors.  The das2C message, if any,
 * is in .message; a server's in-band exception text (NoDataInInterval and
 * friends) rides along in .exception. */
export class DasError extends Error {
	constructor(msg, exception = '')
	{
		super(msg);
		this.name = 'DasError';
		this.exception = exception;
	}
}

/* ************************************************************************ */

/** Push-mode stream reader.
 *
 * Wraps a DasWasmRdr (glue/wasm.h), itself a das2C feed-mode DasIO coupled
 * to a dataset builder.  Bytes go in through feed(), end() closes, and the
 * datasets accumulate in stream().  Nothing here cares where the bytes came
 * from: fetch(), a File picked by the user, a WebSocket, a test fixture.
 */
export class DasReader {
	#d;          /* the DasRuntime handle */
	#p;          /* DasWasmRdr* */
	#buf = 0;    /* scratch heap buffer that chunks are copied into */
	#bufSz = 0;
	#strm = null;
	#taken = false;

	constructor(das3)
	{
		this.#d = das3;
		this.#p = das3._c().newRdr();
		if(this.#p === 0)
			throw new DasError('new_DasWasmRdr failed: ' + das3.lastError());
	}

	/** Push a chunk of stream bytes.
	 *
	 * The chunk has to be copied into the wasm heap first because C code can
	 * only see its own memory.  A single scratch buffer is reused and grown
	 * to the largest chunk seen, so steady-state feeding does one malloc
	 * total.  HEAPU8 is re-read from the Module on every call rather than
	 * cached, see the detached-view discussion at the top of the file.
	 *
	 * @param {Uint8Array} chunk
	 * @throws {DasError} if the stream is malformed; the error latches
	 */
	feed(chunk)
	{
		const m = this.#d._m();
		if(chunk.length > this.#bufSz){
			if(this.#buf) m._free(this.#buf);
			this.#bufSz = chunk.length;
			this.#buf = m._malloc(this.#bufSz);
		}
		m.HEAPU8.set(chunk, this.#buf);

		const rc = this.#d._c().feed(this.#p, this.#buf, chunk.length);
		if(rc !== 0)
			throw new DasError(this.#d.lastError(), this.exception);
	}

	/** Signal end of input.  Throws if the stream ended mid-packet. */
	end()
	{
		const rc = this.#d._c().end(this.#p);
		if(rc !== 0)
			throw new DasError(this.#d.lastError(), this.exception);
	}

	/** The stream under construction, owned by the reader.  Datasets may be
	 * walked mid-download.  Null before the stream header has arrived. */
	get stream()
	{
		const p = this.#d._c().rdrStream(this.#p);
		if(p === 0) return null;
		if(this.#strm === null || this.#strm._p() !== p)
			this.#strm = new DasStream(this.#d, p, false);
		return this.#strm;
	}

	/** Detach the stream from the reader; the caller now owns it and must
	 * call DasStream.free() eventually.  Freeing the reader afterwards leaves
	 * the stream alive. */
	take()
	{
		const p = this.#d._c().rdrTake(this.#p);
		if(p === 0)
			throw new DasError('no stream to take: ' + this.#d.lastError());
		this.#taken = true;
		this.#strm = new DasStream(this.#d, p, true);
		return this.#strm;
	}

	/** Producer-reported progress in arbitrary units, -1 if none */
	get progress(){ return this.#d._c().rdrProgress(this.#p); }

	/** Producer-reported task size in the same units, -1 if none */
	get taskSize(){ return this.#d._c().rdrTaskSize(this.#p); }

	/** Text of the last in-band exception packet, or '' */
	get exception(){ return this.#d._c().rdrException(this.#p); }

	/** Release the parser, the scratch buffer, and the stream unless it was
	 * taken.  The reader is unusable afterwards. */
	free()
	{
		if(this.#p === 0) return;
		const m = this.#d._m();
		this.#d._c().delRdr(this.#p);
		this.#p = 0;
		if(this.#buf) m._free(this.#buf);
		this.#buf = 0;
		this.#bufSz = 0;
		if(!this.#taken) this.#strm = null;
	}
}

/* ************************************************************************ */
/* The dataset model: DasStream -> DasDataset -> DasDim -> DasVar.
 *
 * Each of these is a thin handle around a C pointer.  They do not copy any
 * metadata at construction; every getter is a C call.  That keeps them
 * cheap to create (walking a stream mid-download creates many) and always
 * current (a dataset's record count changes as packets arrive). */

/* Property access is shared by streams, datasets and dimensions, which are
 * all DasDesc descriptors in C.  A mixin keeps it in one place. */
function readProps(c, p)
{
	const n = c.propCount(p);
	const props = new Map();
	for(let i = 0; i < n; ++i)
		props.set(c.propName(p, i), {value: c.propValue(p, i), type: c.propType(p, i)});
	return props;
}

/** A das stream: global properties and a list of datasets.  Wraps a das2C
 * DasStream. */
export class DasStream {
	#d; #p; #owned;

	constructor(das3, p, owned)
	{
		this.#d = das3; this.#p = p; this.#owned = owned;
	}
	_p(){ return this.#p; }

	/** DasStream-level properties as a Map of name -> {value, type} */
	get props(){ return readProps(this.#d._c(), this.#p); }

	/** Number of datasets so far */
	get length(){ return this.#d._c().strmDsCount(this.#p); }

	/** The i-th dataset */
	dataset(i)
	{
		const p = this.#d._c().strmDsAt(this.#p, i);
		if(p === 0) throw new RangeError(`no dataset ${i}`);
		return new DasDataset(this.#d, p);
	}

	/** All datasets, so `for(const ds of stream.datasets())` works */
	*datasets()
	{
		const n = this.length;
		for(let i = 0; i < n; ++i) yield this.dataset(i);
	}

	/** Release the C side.  Only valid for streams taken from a reader;
	 * streams still owned by a DasReader are freed with it. */
	free()
	{
		if(this.#p === 0) return;
		if(this.#owned) this.#d._c().streamFree(this.#p);
		this.#p = 0;
	}
}

/** One dataset: a set of correlated variables that share bulk indices.
 * Wraps a das2C DasDs; spelled out here because "Ds" appears nowhere in
 * the stream format or its documentation, only in C identifiers.
 *
 * The bulk shape is the shape every variable agrees to be indexed by.  Its
 * first index is the stream-append direction: records, which is 0 for a
 * dataset whose header has arrived but whose data has not.  Headers may
 * arrive at any point in a stream, after data for other datasets, so a
 * stream's dataset count and each dataset's record count are both live
 * quantities; nothing here assumes headers come first.  Entries may be a
 * count or DasRuntime.RAGGED (varies with earlier indices).  A single variable's
 * shape may also say DasRuntime.UNUSED (the variable does not vary along it) or
 * DasRuntime.BORROW (no extent of its own, as many values as the dataset has
 * there; typical of a sequence paired with ragged data). */
export class DasDataset {
	#d; #p;

	constructor(das3, p){ this.#d = das3; this.#p = p; }
	_p(){ return this.#p; }

	get id(){ return this.#d._c().dsId(this.#p); }
	get group(){ return this.#d._c().dsGroup(this.#p); }
	get props(){ return readProps(this.#d._c(), this.#p); }
	get rank(){ return this.#d._c().dsRank(this.#p); }

	/** Bulk shape as an array of ints, see the class comment */
	get shape()
	{
		const c = this.#d._c();
		const n = c.dsRank(this.#p);
		const a = new Array(n);
		for(let i = 0; i < n; ++i) a[i] = c.dsShapeAt(this.#p, i);
		return a;
	}

	/** Coordinate dimensions (time, frequency, ...) */
	get coords(){ return this.#dims(1); }

	/** Data dimensions (the measured quantities) */
	get data(){ return this.#dims(0); }

	#dims(bCoord)
	{
		const c = this.#d._c();
		const n = c.dsDimCount(this.#p, bCoord);
		const a = new Array(n);
		for(let i = 0; i < n; ++i)
			a[i] = new DasDim(this.#d, c.dsDimAt(this.#p, i, bCoord));
		return a;
	}

	/** Look up a dimension by id in either group, undefined if absent */
	dim(id)
	{
		for(const d of this.coords) if(d.id === id) return d;
		for(const d of this.data) if(d.id === id) return d;
		return undefined;
	}

	/** Every variable of every dimension, as [dim, role, var] triples */
	*vars()
	{
		for(const dim of this.coords.concat(this.data))
			for(const [role, v] of dim.vars) yield [dim, role, v];
	}

	/** A variable whose extents v can wear where v's own shape says BORROW:
	 * the first array-backed variable sized or ragged along that index.
	 * Undefined if v borrows nothing (or nothing can lend).  Pass the result
	 * as DasVar.values({shapeFrom}). */
	shapeDonor(v)
	{
		const d = this.#d;
		const iBorrow = v.shape(this.rank).indexOf(d.BORROW);
		if(iBorrow < 0) return undefined;
		for(const [, , other] of this.vars()){
			if(!other.isArrayBacked) continue;
			const ext = other.shape(this.rank)[iBorrow];
			if(ext > 0 || ext === d.RAGGED) return other;
		}
		return undefined;
	}
}

/** A physical dimension: a named group of variables that play roles
 * (center, min, max, reference, offset, ...) in describing one quantity.
 * Wraps a das2C DasDim. */
export class DasDim {
	#d; #p;

	constructor(das3, p){ this.#d = das3; this.#p = p; }
	_p(){ return this.#p; }

	get id(){ return this.#d._c().dimId(this.#p); }
	get isCoord(){ return this.#d._c().dimIsCoord(this.#p) !== 0; }
	get props(){ return readProps(this.#d._c(), this.#p); }

	/** Variables keyed by role, as a Map of role -> DasVar */
	get vars()
	{
		const c = this.#d._c();
		const n = c.dimVarCount(this.#p);
		const vars = new Map();
		for(let i = 0; i < n; ++i)
			vars.set(c.dimRoleAt(this.#p, i), new DasVar(this.#d, c.dimVarAt(this.#p, i)));
		return vars;
	}

	/** The variable with the given role, 'center' by default, or undefined */
	var(role = 'center'){ return this.vars.get(role); }
}

/** A variable: dataset-shaped values of one element type.  Wraps a das2C
 * DasVar; values() reaches through it to the backing DasAry, which has no
 * handle of its own here because shape and type are only known together
 * at the variable.
 *
 * The important member is values().  Everything else is the metadata a
 * caller needs to interpret what values() returns. */
export class DasVar {
	#d; #p;

	constructor(das3, p){ this.#d = das3; this.#p = p; }
	_p(){ return this.#p; }

	/** Units string, '' for dimensionless */
	get units(){ return this.#d._c().varUnits(this.#p); }

	/** Storage element type name, one of the keys of TYPED_ARRAYS plus
	 * 'das_time', 'char*' and 'ubyte*'.  See glue/wasm.h. */
	get valType(){ return this.#d._c().varValType(this.#p); }

	/** True if values() can return numbers (numeric or time elements) */
	get isNumeric(){ return this.#d._c().varIsNumeric(this.#p) !== 0; }

	/** Extent along each BULK dataset index: count, DasRuntime.RAGGED or
	 * DasRuntime.UNUSED.  Same length as the owning dataset's shape. */
	shape(dsRank)
	{
		const c = this.#d._c();
		const a = new Array(dsRank);
		for(let i = 0; i < dsRank; ++i) a[i] = c.varShapeAt(this.#p, i);
		return a;
	}

	/** Intrinsic (per record, internal) shape: [] for scalars, [3] for a
	 * 3-vector, [DasRuntime.RAGGED] for variable length text */
	get intrShape()
	{
		const c = this.#d._c();
		const n = c.varIntrRank(this.#p);
		const a = new Array(n);
		for(let i = 0; i < n; ++i) a[i] = c.varIntrShapeAt(this.#p, i);
		return a;
	}

	/** Component symbols of a vector variable (['x','y','z']), [] otherwise */
	get components()
	{
		const c = this.#d._c();
		const a = [];
		const shape = this.intrShape;
		if(shape.length !== 1) return a;
		for(let i = 0; i < shape[0]; ++i){
			const s = c.varCompSym(this.#p, i);
			if(s === '') break;
			a.push(s);
		}
		return a;
	}

	/** True if this variable is backed by a decoded array in the heap, so
	 * values() is zero-copy.  False for computed variables (sequences,
	 * arithmetic on other variables), where values() materializes a copy. */
	get isArrayBacked(){ return this.#d._c().varAry(this.#p) !== 0; }

	/** The values.
	 *
	 * For numeric element types the result is the TypedArray matching
	 * valType, in C index order over the backing array's shape (which you
	 * get from arrayShape()).  When the variable is array-backed this is a
	 * VIEW over the wasm heap: no copy, and the detached-view caveat at the
	 * top of the file applies.  When it is not, das2C materializes a
	 * rectangular copy (ragged edges padded with fill) and the result is an
	 * independent TypedArray that outlives everything.
	 *
	 * 'das_time' elements, which only text-encoded streams produce, come
	 * back as a Float64Array copy of seconds since 1958-01-01 (das2C's
	 * internal epoch, no leap seconds).
	 *
	 * 'char*' (text) comes back as JavaScript strings, nested in Arrays to
	 * the variable's shape: a rank 1 text variable gives Array<string>, a
	 * rank 2 one (several status strings per record) Array<Array<string>>.
	 * das2C stores such text as byte runs in a ragged ubyte array one rank
	 * higher than the variable, so each string is decoded from the heap
	 * individually; text is never zero-copy.
	 *
	 * 'ubyte*' (opaque byte runs) are not yet supported.
	 *
	 * A computed variable whose shape says DasRuntime.BORROW along some index has
	 * no extent of its own there and cannot be materialized alone; pass a
	 * variable of the same dataset that does have one (DasDataset.shapeDonor()
	 * finds one) as opts.shapeFrom.
	 *
	 * @param {object} [opts]
	 * @param {boolean} [opts.copy=false] Always return an independent copy,
	 *        never a view
	 * @param {DasVar} [opts.shapeFrom] Donor of extents this variable borrows
	 * @returns {TypedArray|Array}
	 */
	values(opts = {})
	{
		const c = this.#d._c();
		const m = this.#d._m();

		let pAry = c.varAry(this.#p);
		let owned = false;
		if(pAry === 0){
			pAry = c.varQube(this.#p, opts.shapeFrom ? opts.shapeFrom._p() : 0);
			if(pAry === 0)
				throw new DasError('cannot materialize values: ' + this.#d.lastError());
			owned = true;
		}

		try{
			const vt = c.aryValType(pAry);
			const n = c.arySize(pAry);

			/* A dataset whose header arrived before any of its data has empty
			 * arrays; routine mid-stream, and permanent for a packet type a
			 * producer declares but never sends.  Answer with the right empty
			 * container rather than asking C for pointers into nothing. */
			if(n === 0){
				if(vt === 'das_time') return new Float64Array(0);
				if(vt === 'char*' || this.valType === 'char*') return [];
				const Ctor = TYPED_ARRAYS[vt];
				return Ctor ? new Ctor(0) : [];
			}

			if(vt === 'das_time'){
				const pSec = c.aryTimes(pAry);
				if(pSec === 0)
					throw new DasError('time conversion failed: ' + this.#d.lastError());
				try{
					/* slice() copies out of the heap before the buffer is freed */
					return new Float64Array(m.HEAPU8.buffer, pSec, n).slice();
				}
				finally{ c.free(pSec); }
			}

			/* Text arrays proper: an array of C string pointers */
			if(vt === 'char*'){
				const a = new Array(n);
				for(let i = 0; i < n; ++i) a[i] = c.aryTextAt(pAry, i);
				return a;
			}

			/* Text stored as byte runs: decode run by run */
			if(this.valType === 'char*' && vt === 'ubyte')
				return this.#textRuns(pAry, [], c.aryRank(pAry));

			return this.#view(pAry, vt, c.aryData(pAry), n, owned || opts.copy);
		}
		finally{
			if(owned) c.aryFree(pAry);
		}
	}

	/* Recursive descent over a ragged ubyte array whose last index is the
	 * bytes of one string.  loc is the partial index built so far. */
	#textRuns(pAry, loc, rank)
	{
		const c = this.#d._c();
		const m = this.#d._m();
		const pLoc = this.#d._loc(loc);

		if(loc.length === rank - 1){
			const n = c.arySizeAt(pAry, pLoc, loc.length);
			const p = c.aryDataAt(pAry, pLoc, loc.length);
			if(n <= 0 || p === 0) return '';
			/* das2C keeps a terminating null inside the run; drop it */
			const end = (m.HEAPU8[p + n - 1] === 0) ? p + n - 1 : p + n;
			return UTF8.decode(m.HEAPU8.subarray(p, end));
		}

		const nSub = c.aryLengthAt(pAry, pLoc, loc.length);
		if(nSub < 0) throw new DasError(this.#d.lastError());
		const a = new Array(nSub);
		for(let i = 0; i < nSub; ++i)
			a[i] = this.#textRuns(pAry, loc.concat(i), rank);
		return a;
	}

	/* Wrap n elements of type vt at heap address pData in a TypedArray */
	#view(pAry, vt, pData, n, copy)
	{
		const c = this.#d._c();
		const m = this.#d._m();

		const Ctor = TYPED_ARRAYS[vt];
		if(Ctor === undefined)
			throw new DasError(`element type ${vt} is not viewable`);

		if(pData === 0 || n === 0) return new Ctor(0);

		/* A TypedArray view demands its byte offset be a multiple of the
		 * element size.  das2C's buffers come from malloc and are aligned,
		 * but a sub-array of 1-byte elements inside a run of 8-byte ones
		 * could in principle start anywhere; copy out if so rather than let
		 * the constructor throw a cryptic RangeError */
		const sz = c.aryValSize(pAry);
		if(pData % sz !== 0){
			const bytes = m.HEAPU8.slice(pData, pData + n * sz);
			return new Ctor(bytes.buffer, 0, n);
		}

		const view = new Ctor(m.HEAPU8.buffer, pData, n);
		return copy ? view.slice() : view;
	}

	/** Number of entries below a partial index of the backing array.
	 *
	 * This is how ragged data is walked: lengthAt([]) is the record count,
	 * lengthAt([i]) the number of items in record i, and so on down.  Only
	 * for array-backed variables.
	 *
	 * @param {number[]} loc leading indices, fewer than arrayShape().length
	 */
	lengthAt(loc)
	{
		const c = this.#d._c();
		const pAry = c.varAry(this.#p);
		if(pAry === 0) throw new DasError('not an array-backed variable');
		const n = c.aryLengthAt(pAry, this.#d._loc(loc), loc.length);
		if(n < 0) throw new DasError(this.#d.lastError());
		return n;
	}

	/** The numeric values below a partial index, as a zero-copy view.
	 *
	 * valuesAt([i]) is record i's values, however many there are, which is
	 * what a ragged waveform plot wants.  valuesAt([]) equals values().
	 * Numeric element types only; see values() for text and time.
	 *
	 * @param {number[]} loc leading indices
	 * @param {object} [opts]
	 * @param {boolean} [opts.copy=false]
	 * @returns {TypedArray}
	 */
	valuesAt(loc, opts = {})
	{
		const c = this.#d._c();
		const pAry = c.varAry(this.#p);
		if(pAry === 0) throw new DasError('not an array-backed variable');
		const pLoc = this.#d._loc(loc);
		const n = c.arySizeAt(pAry, pLoc, loc.length);
		if(n < 0) throw new DasError(this.#d.lastError());
		const p = c.aryDataAt(pAry, pLoc, loc.length);
		return this.#view(pAry, c.aryValType(pAry), p, n, !!opts.copy);
	}

	/** Shape of the array behind values(), which may have one more index
	 * than the intrinsic shape (the record index) and may be ragged.  Null
	 * for computed variables; use shape() and intrShape instead. */
	get arrayShape()
	{
		const c = this.#d._c();
		const pAry = c.varAry(this.#p);
		if(pAry === 0) return null;
		const n = c.aryRank(pAry);
		const a = new Array(n);
		for(let i = 0; i < n; ++i) a[i] = c.aryShapeAt(pAry, i);
		return a;
	}
}
