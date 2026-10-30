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
 * DasVar.storage (das_vt_toStr names in glue/wasm.h).  Each numeric one has exactly one
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
const UTF8E = new TextEncoder();   /* always UTF-8, it takes no argument */

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
			descJson:      w('daswasm_desc_json', N, [N]),
			dsJson:        w('daswasm_ds_json', N, [N]),

			/* the live quantities: everything else about a dataset's structure
			 * is fixed at header time and comes from the JSON snapshot */
			dsShapeAt:     w('daswasm_ds_shapeAt', N, [N, N]),
			varShapeAt:    w('daswasm_var_shapeAt', N, [N, N]),
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
			aryDoubles:    w('daswasm_ary_doubles', N, [N, N, N]),
			aryFree:       w('daswasm_ary_free', null, [N]),
			free:          w('daswasm_free', null, [N]),

			/* the raster painter, src/render.h */
			newRen:        w('new_DasRender', N, [N, N]),
			renSetX:       w('DasRender_setX', N, [N, S, S]),
			renAttach:     w('DasRender_attach', N, [N, N]),
			renKind:       w('DasRender_kind', N, [N]),
			renColorize:   w('DasRender_colorize', N, [N]),
			renDirty:      w('DasRender_dirty', N, [N]),
			renPaintMs:    w('DasRender_paintMs', N, [N]),
			renValues:     w('DasRender_values', N, [N]),
			renRescales:   w('DasRender_rescales', N, [N]),
			renSkipped:    w('DasRender_skipped', N, [N]),
			renNote:       w('DasRender_note', S, [N]),
			renRange:      w('DasRender_range', N, [N, N, N]),
			renIsLog:      w('DasRender_isLog', N, [N, N]),
			renUnits:      w('DasRender_units', S, [N, N]),
			delRen:        w('del_DasRender', null, [N]),

			/* Catalog: everything but the snapshot is das2C's own API,
			 * exported straight from libdas3.a (see DAS2C_EXPORTS in the
			 * Makefile).  Pointers that may be NULL come back as 'number' and
			 * are decoded by cString(), since 'string' turns NULL into ''. */
			nodeJson:      w('daswasm_node_json', N, [N]),
			nodeNew:       w('new_DasNode_json', N, [N, N, S, S]),
			nodeDel:       w('del_DasNode', null, [N]),
			walkNew:       w('new_DasNodeWalk', N, [N, S]),
			walkSeed:      w('new_DasNodeWalk_seed', N, []),
			walkDel:       w('del_DasNodeWalk', null, [N]),
			walkState:     w('DasNodeWalk_state', N, [N]),
			walkUrl:       w('DasNodeWalk_url', S, [N, N]),
			walkUri:       w('DasNodeWalk_uri', S, [N]),
			walkFeed:      w('DasNodeWalk_feed', N, [N, N, N, N, S]),
			walkFail:      w('DasNodeWalk_fail', null, [N, N, S]),
			walkResult:    w('DasNodeWalk_result', N, [N]),
			walkNearest:   w('DasNodeWalk_nearest', N, [N, N]),
			srcNew:        w('new_DasSrc_node', N, [N]),
			srcDel:        w('del_DasSrc', null, [N]),
			srcTitle:      w('DasSrc_title', N, [N]),
			srcNeedsAuth:  w('DasSrc_needsAuth', 'boolean', [N]),
			srcAuthRealm:  w('DasSrc_authRealm', N, [N]),
			srcExCount:    w('DasSrc_exampleCount', N, [N]),
			srcExLabel:    w('DasSrc_exampleLabel', S, [N, N]),
			srcNewReq:     w('DasSrc_newReq', N, [N, N]),
			srcMime:       w('DasSrc_mime', S, [N, N]),
			srcUrl:        w('DasStreamSrc_url', N, [N, N, N, N, N]),
			reqDel:        w('del_DasReq', null, [N]),
			reqSet:        w('DasReq_set', N, [N, S, S]),
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

		/* One element of any storage type, for the reference value of
		 * DasVar.doubles().  malloc aligns to 8, which the DataView and
		 * TypedArray writes in _ref() need. */
		this.#ref = m._malloc(8);
	}
	#loc;
	#ref;

	/* Copy a JavaScript index list into the scratch buffer and return its
	 * heap address.  HEAP32 is indexed in 4-byte units, hence the >> 2. */
	_loc(loc)
	{
		if(loc.length > 8) throw new RangeError('index list longer than 8');
		this.#m.HEAP32.set(loc, this.#loc >> 2);
		return this.#loc;
	}

	/* Write one value into the reference scratch slot as storage type vt
	 * and return its heap address, or 0 when no value was given (C reads
	 * NULL as "no offset").  The 64-bit integer types go through a
	 * DataView: a BigInt64Array element only accepts a BigInt, and a caller
	 * may reasonably pass a Number for a small offset, so both are taken
	 * and BigInt() does the widening (it throws on a fractional Number,
	 * which is the right answer for an integer axis).  Everything else is
	 * written through the matching TypedArray, which rounds a Number into
	 * the storage type the way C would.  Wasm memory is little-endian. */
	_ref(vt, value)
	{
		if(value === undefined || value === null) return 0;
		const m = this.#m;
		if(vt === 'long' || vt === 'ulong'){
			const dv = new DataView(m.HEAPU8.buffer, this.#ref, 8);
			const big = (typeof value === 'bigint') ? value : BigInt(value);
			if(vt === 'long') dv.setBigInt64(0, big, true);
			else dv.setBigUint64(0, big, true);
		}
		else{
			const Ctor = TYPED_ARRAYS[vt];
			if(Ctor === undefined) throw new DasError(`no reference value for storage ${vt}`);
			new Ctor(m.HEAPU8.buffer, this.#ref, 1)[0] = Number(value);
		}
		return this.#ref;
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

	/** A raster painter of the given size in pixels, see DasRender */
	newRender(width, height){ return new DasRender(this, width, height); }

	/** A catalog session: a tree of das catalog nodes loaded on demand.
	 * See DasCatalog for the options. */
	newCatalog(opts = {}){ return new DasCatalog(this, opts); }

	/** A data source straight from the URL of its node, no catalog walk.
	 *
	 *   const src = await das.loadSource('https://das2.org/catalog/das/site/'
	 *       + 'uiowa/voyager/1/pws/specanalyzer-4s-efield/das2.json');
	 *   const {url} = src.request(0, {time: '2014-08-31T12'});
	 *   src.free();
	 *
	 * Options: uri, the catalog URI the node stands for; fetch and timeout
	 * as for DasCatalog.
	 * @returns {Promise<DasCatSource>}, which the caller frees
	 * @throws {DasError} if the URL fails or holds a container node */
	async loadSource(url, opts = {})
	{
		const cat = new DasCatalog(this, {fetch: opts.fetch, timeout: opts.timeout,
			seed: url, seedUri: opts.uri});
		try{
			const node = await cat.root();
			if(!node.isSource)
				throw new DasError(`${url} is a ${node.type} node, not a data source`);
			return node.source();   /* a copy, so it outlives cat */
		}
		finally{ cat.free(); }
	}

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
			                    await this.#errorBody(resp), httpInfo(resp));

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
 * friends) rides along in .exception.
 *
 * For HTTP errors, .status is the status code (0 otherwise) and .realm the
 * login realm from a 401's WWW-Authenticate header.  Across origins a
 * script only sees that header if the server lists it in
 * Access-Control-Expose-Headers; when it doesn't, .realm is null. */
export class DasError extends Error {
	constructor(msg, exception = '', {status = 0, realm = null} = {})
	{
		super(msg);
		this.name = 'DasError';
		this.exception = exception;
		this.status = status;
		this.realm = realm;
	}
}

/* The DasError fields for an HTTP reply */
function httpInfo(resp)
{
	const m = /realm="([^"]*)"/i.exec(resp.headers.get('WWW-Authenticate') || '');
	return {status: resp.status, realm: m ? m[1] : null};
}

/** The Authorization header value for HTTP Basic auth, for fetchStream's
 * headers option:
 *
 *   d.fetchStream(url, {headers: {Authorization: basicAuth(user, pass)}})
 *
 * Send it to https URLs only: base64 is an encoding, not encryption.
 *
 * @throws {DasError} if user contains ':', which Basic auth can't carry */
export function basicAuth(user, password)
{
	if(user.includes(':'))
		throw new DasError("A user name for Basic auth can't contain ':'");
	/* UTF-8 first: btoa() alone throws past U+00FF and sends Latin-1 below */
	let bin = '';
	for(const b of UTF8E.encode(`${user}:${password}`)) bin += String.fromCharCode(b);
	return 'Basic ' + btoa(bin);
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

	/* The DasWasmRdr pointer, for DasRender.attach(); 0 once freed */
	_p(){ return this.#p; }

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

/* DasRender.kind values, indexed by the C constants plus one, since
 * DASRENDER_UNUSABLE is -1 */
const RENDER_KINDS = ['unusable', 'none', 'spectrogram', 'density'];

/** Paints a picture of a stream while it downloads.
 *
 * Pixels, not a plot: no axes or labels.  The C side (src/render.h) hooks
 * into a reader and paints each packet as it is parsed, so by the time a
 * chunk's feed() returns its data are already in the image.  This class
 * only hands the finished pixels to a canvas.
 *
 * Use, in this order:
 *
 *   const ren = das.newRender(800, 232);
 *   ren.setX('2021-07-21', '2021-07-22');   // what the request asked for
 *   ren.attach(reader);                     // before the first feed()
 *   ... feed chunks; on a display timer:
 *   if(ren.dirty) ctx.putImageData(ren.imageData(), 0, 0);
 *   ... at the end: reader.free() FIRST, then ren.free()
 *
 * The order at the end matters: the C reader keeps a pointer to the C
 * renderer, so the renderer must outlive the reader's last feed.
 */
export class DasRender {
	#d;
	#p;
	#w;
	#h;

	constructor(das3, width, height)
	{
		this.#d = das3;
		this.#w = width;
		this.#h = height;
		this.#p = das3._c().newRen(width, height);
		if(this.#p === 0)
			throw new DasError('new_DasRender failed: ' + das3.lastError());
	}

	get width(){ return this.#w; }
	get height(){ return this.#h; }

	/** Set the time range the image covers, as ISO 8601 strings.  Must be
	 * called before any data arrive. */
	setX(beg, end)
	{
		if(this.#d._c().renSetX(this.#p, String(beg), String(end)) !== 0)
			throw new DasError(this.#d.lastError());
	}

	/** Paint whatever this reader parses from now on */
	attach(reader)
	{
		if(this.#d._c().renAttach(this.#p, reader._p()) !== 0)
			throw new DasError(this.#d.lastError());
	}

	/** 'none' until the first dataset header, then 'spectrogram' or
	 * 'density', or 'unusable' (see note) */
	get kind(){ return RENDER_KINDS[this.#d._c().renKind(this.#p) + 1]; }

	/** True if something was painted since the last imageData() call */
	get dirty(){ return this.#d._c().renDirty(this.#p) !== 0; }

	/** Total milliseconds spent painting inside feed() calls */
	get paintMs(){ return this.#d._c().renPaintMs(this.#p); }

	/** Values painted so far, repaints included; values / paintMs is the
	 * painter's rate */
	get values(){ return this.#d._c().renValues(this.#p); }

	/** How many times a range change forced a repaint or recolor */
	get rescales(){ return this.#d._c().renRescales(this.#p); }

	/** Datasets not painted because they didn't match the first one */
	get skipped(){ return this.#d._c().renSkipped(this.#p); }

	/** Why something wasn't painted, or '' */
	get note(){ return this.#d._c().renNote(this.#p); }

	/** Range of the vertical (color = false) or color axis, for a caption:
	 * {min, max, log, units}, min and max NaN until known */
	axis(color = false)
	{
		const c = this.#d._c(), b = color ? 1 : 0;
		return {
			min: c.renRange(this.#p, b, 0), max: c.renRange(this.#p, b, 1),
			log: c.renIsLog(this.#p, b) !== 0, units: c.renUnits(this.#p, b),
		};
	}

	/** Build the RGBA image and return it as an ImageData for putImageData().
	 *
	 * The ImageData's pixels are a VIEW onto the wasm heap, not a copy.
	 * putImageData() copies them into the canvas right away, so use it at
	 * once and drop it; the next feed() may grow the heap and detach it (see
	 * the top of this file). */
	imageData()
	{
		const p = this.#d._c().renColorize(this.#p);
		const px = new Uint8ClampedArray(this.#d._m().HEAPU8.buffer, p, this.#w * this.#h * 4);
		return new ImageData(px, this.#w, this.#h);
	}

	/** Release the C renderer.  Free the attached reader first. */
	free()
	{
		if(this.#p === 0) return;
		this.#d._c().delRen(this.#p);
		this.#p = 0;
	}
}

/* ************************************************************************ */
/* The dataset model: DasStream -> DasDataset -> DasDim -> DasVar.
 *
 * A dataset's structure is fixed the moment its header packet is parsed;
 * only the record count grows afterwards.  So the structure is read ONCE,
 * as a JSON document from glue/wasm.c (daswasm_ds_json), parsed into plain
 * objects, and the handle classes below are thin views over that snapshot
 * plus the C pointer for the few things that are live: record counts and
 * value buffers.  Walking a stream mid-download therefore costs one C call
 * per dataset, not one per field.
 *
 * Key spellings follow the das3 stream XML (name, group, physDim, axis,
 * role, semantic, storage) so what you see in a header is what you type.
 * Every snapshot field is a string, number, boolean or array; nothing in
 * the snapshot is consulted per value. */

/* Read a NUL terminated UTF-8 string the C side malloc'd, free it, and
 * parse it.  cwrap's 'string' return type would decode for us but then the
 * pointer is gone and the buffer leaks, hence 'number' and this. */
function takeJson(d, p)
{
	if(p === 0) throw new DasError('snapshot failed: ' + d.lastError());
	const m = d._m();
	const end = m.HEAPU8.indexOf(0, p);
	let text;
	try{ text = UTF8.decode(m.HEAPU8.subarray(p, end)); }
	finally{ d._c().free(p); }
	return JSON.parse(text);
}

/* JSON numbers are doubles and lose integers past 2^53, where a TT2000
 * time stamp lives.  So the C side writes 64-bit integers as digit strings
 * and these two helpers turn them into BigInts by the type tag beside
 * them.  Integer-typed properties are always BigInt, never Number, so that
 * a property holding a time stamp is exact; Number(x) when you need to mix. */
function reviveProps(props)
{
	for(const entry of Object.values(props)){
		if(!entry.type.startsWith('integer')) continue;
		entry.value = Array.isArray(entry.value)
			? entry.value.map(BigInt) : BigInt(entry.value);
	}
	return props;
}

function reviveDatum(dm)
{
	if(dm !== null && (dm.storage === 'long' || dm.storage === 'ulong') && dm.value !== null)
		dm.value = BigInt(dm.value);
	return dm;
}

function reviveVar(v)
{
	reviveProps(v.props);
	const g = v.source;
	if(g.kind === 'sequence'){
		if(Array.isArray(g.minval)) g.minval.forEach(reviveDatum);
		else reviveDatum(g.minval);
		/* interval is [per index] for a scalar sequence, [per component]
		 * [per index] for a composite one */
		for(const row of (Array.isArray(g.interval[0]) ? g.interval : [g.interval]))
			row.forEach(reviveDatum);
	}
	return v;
}


/* A deep copy with every BigInt turned into a decimal string, for
 * JSON.stringify, which refuses BigInts outright.  toJSON() below returns
 * such copies so `JSON.stringify(stream, null, 2)` prints a whole stream's
 * structure with no replacer; the live objects keep their BigInts. */
function plain(o)
{
	if(typeof o === 'bigint') return o.toString();
	if(Array.isArray(o)) return o.map(plain);
	if(o !== null && typeof o === 'object'){
		const out = {};
		for(const [k, v] of Object.entries(o)) out[k] = plain(v);
		return out;
	}
	return o;
}

/** A das stream: global properties and a list of datasets.  Wraps a das2C
 * DasStream. */
export class DasStream {
	#d; #p; #owned;
	#dsCache = new Map();   /* pointer -> DasDataset, so snapshots are read once */

	constructor(das3, p, owned)
	{
		this.#d = das3; this.#p = p; this.#owned = owned;
	}
	_p(){ return this.#p; }

	/** Stream-level properties as {name: {type, value, units, alt}}, see
	 * DasDataset.props.  Read from C on each access (a stream's properties
	 * are complete once its header has arrived, but this is cheap). */
	get props()
	{
		return reviveProps(takeJson(this.#d, this.#d._c().descJson(this.#p)));
	}

	/** Number of datasets so far */
	get length(){ return this.#d._c().strmDsCount(this.#p); }

	/** The i-th dataset.  The same DasDataset object is returned for the
	 * same dataset every time, so its snapshot is read once per stream. */
	dataset(i)
	{
		const p = this.#d._c().strmDsAt(this.#p, i);
		if(p === 0) throw new RangeError(`no dataset ${i}`);
		let ds = this.#dsCache.get(p);
		if(ds === undefined){
			ds = new DasDataset(this.#d, p);
			this.#dsCache.set(p, ds);
		}
		return ds;
	}

	/** All datasets, so `for(const ds of stream.datasets())` works */
	*datasets()
	{
		const n = this.length;
		for(let i = 0; i < n; ++i) yield this.dataset(i);
	}

	/** The structure of the whole stream as plain data: its properties and
	 * every dataset's toJSON().  Lets `JSON.stringify(stream, null, 2)`
	 * answer "what do I have to work with" without printing a single data
	 * value. */
	toJSON()
	{
		return {props: plain(this.props), datasets: Array.from(this.datasets(), ds => ds.toJSON())};
	}

	/** Release the C side.  Only valid for streams taken from a reader;
	 * streams still owned by a DasReader are freed with it. */
	free()
	{
		if(this.#p === 0) return;
		if(this.#owned) this.#d._c().streamFree(this.#p);
		this.#p = 0;
		this.#dsCache.clear();
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
 * there; typical of a sequence paired with ragged data).
 *
 * Properties, here and on dimensions and variables, are a plain object
 * keyed by name.  Every entry has the same four fields and only the JS type
 * of value changes, chosen by type:
 *
 *   { type: "realRange", value: [0, 100], units: "V", alt: {} }
 *
 *   string -> string, bool -> boolean, real -> Number, integer -> BigInt,
 *   datetime -> ISO 8601 string as the producer wrote it, *Range -> a two
 *   element array, *Array -> an array.  units is '' when none was given
 *   and alt holds alternate language values keyed by ISO 639-1 code (empty
 *   until das2C stores them).  Properties are the producer's message to the
 *   client; this library never interprets them. */
export class DasDataset {
	#d; #p; #meta;
	#coords; #data;

	constructor(das3, p)
	{
		this.#d = das3; this.#p = p;
		this.#meta = takeJson(das3, das3._c().dsJson(p));
		reviveProps(this.#meta.props);
		this.#coords = this.#meta.coords.map(m => new DasDim(das3, m, this.#meta.rank));
		this.#data = this.#meta.data.map(m => new DasDim(das3, m, this.#meta.rank));
	}
	_p(){ return this.#p; }

	/** Dataset name, as in the header's <dataset name=...> */
	get name(){ return this.#meta.name; }

	/** Join group: datasets of one group are pieces of one quantity, '' if
	 * the producer declared none */
	get group(){ return this.#meta.group; }

	get props(){ return this.#meta.props; }
	get rank(){ return this.#meta.rank; }

	/** Bulk shape as an array of ints, see the class comment.  Read live:
	 * the record count grows as packets arrive. */
	get shape()
	{
		const c = this.#d._c();
		const n = this.#meta.rank;
		const a = new Array(n);
		for(let i = 0; i < n; ++i) a[i] = c.dsShapeAt(this.#p, i);
		return a;
	}

	/** Coordinate dimensions (time, frequency, ...) */
	get coords(){ return this.#coords; }

	/** Data dimensions (the measured quantities) */
	get data(){ return this.#data; }

	/** Look up a dimension by name in either group, undefined if absent */
	dim(name)
	{
		for(const d of this.#coords) if(d.name === name) return d;
		for(const d of this.#data) if(d.name === name) return d;
		return undefined;
	}

	/** The dataset's structure as plain data, pointers dropped, shape read
	 * live, BigInts as strings so JSON.stringify accepts it.  No data values. */
	toJSON()
	{
		return {
			name: this.#meta.name, group: this.#meta.group, rank: this.#meta.rank,
			shape: this.shape, props: plain(this.#meta.props),
			coords: this.#coords.map(d => d.toJSON()),
			data: this.#data.map(d => d.toJSON()),
		};
	}

	/** Every variable of every dimension, as [dim, role, var] triples */
	*vars()
	{
		for(const dim of this.#coords.concat(this.#data))
			for(const [role, v] of Object.entries(dim.vars)) yield [dim, role, v];
	}

	/** A variable whose extents v can wear where v's own shape says BORROW:
	 * the first array-backed variable sized or ragged along that index.
	 * Undefined if v borrows nothing (or nothing can lend).  Pass the result
	 * as DasVar.values({shapeFrom}). */
	shapeDonor(v)
	{
		const d = this.#d;
		const iBorrow = v.shape.indexOf(d.BORROW);
		if(iBorrow < 0) return undefined;
		for(const [, , other] of this.vars()){
			if(other.source.kind !== 'array') continue;
			const ext = other.shape[iBorrow];
			if(ext > 0 || ext === d.RAGGED) return other;
		}
		return undefined;
	}
}

/** A physical dimension: a named group of variables that play roles
 * (center, min, max, reference, offset, ...) in describing one quantity.
 * Wraps a das2C DasDim. */
export class DasDim {
	#d; #meta; #vars;

	constructor(das3, meta, dsRank)
	{
		this.#d = das3; this.#meta = meta;
		this.#vars = {};
		for(const [role, vm] of Object.entries(meta.vars))
			this.#vars[role] = new DasVar(das3, reviveVar(vm), dsRank);
		reviveProps(meta.props);
	}
	_p(){ return this.#meta.ptr; }

	/** Dimension name, unique within the dataset ("time", "B_mag", ...) */
	get name(){ return this.#meta.name; }

	/** The physical dimension ("time", "frequency", "electric_field"); two
	 * dimensions of a dataset may share one, which is why name exists */
	get physDim(){ return this.#meta.physDim; }

	/** Plot axis affinities as the producer declared them, e.g. ['x'];
	 * [] when none */
	get axes(){ return this.#meta.axes; }

	/** 'coord' or 'data' */
	get kind(){ return this.#meta.kind; }

	get props(){ return this.#meta.props; }

	/** Variables keyed by role: dim.vars.center, dim.vars.offset, ... */
	get vars(){ return this.#vars; }

	/** The variable with the given role, 'center' by default, or undefined */
	var(role = 'center'){ return this.#vars[role]; }

	/** Plain data for JSON.stringify, see DasDataset.toJSON() */
	toJSON()
	{
		const m = this.#meta;
		const vars = {};
		for(const [role, v] of Object.entries(this.#vars)) vars[role] = v.toJSON();
		return {name: m.name, physDim: m.physDim, axes: m.axes, kind: m.kind,
		        props: plain(m.props), vars};
	}
}

/** A variable: dataset-shaped values of one element type.  Wraps a das2C
 * DasVar; values() reaches through it to the backing DasAry, which has no
 * handle of its own here because shape and type are only known together
 * at the variable.
 *
 * The important member is values().  Everything else is the metadata a
 * caller needs to interpret what values() returns. */
export class DasVar {
	#d; #meta; #dsRank;

	constructor(das3, meta, dsRank){ this.#d = das3; this.#meta = meta; this.#dsRank = dsRank; }
	_p(){ return this.#meta.ptr; }

	/** 'center', 'min', 'max', 'reference', 'offset', ... */
	get role(){ return this.#meta.role; }

	/** Units string, '' for dimensionless */
	get units(){ return this.#meta.units; }

	/** What the values mean, one of the schema's closed set: 'bool',
	 * 'datetime', 'integer', 'real', 'string', 'blob' */
	get semantic(){ return this.#meta.semantic; }

	/** How one storage element is laid out, one of the keys of TYPED_ARRAYS
	 * plus 'das_time' (broken-down time, only from text encoded streams).
	 * Strings and blobs are runs of 'ubyte'; their semantic says which. */
	get storage(){ return this.#meta.storage; }

	/** Shape in elements inside one value: [] for a scalar, [3] for a
	 * 3-vector, [3, 3] for a rotation matrix, [DasRuntime.RAGGED] for
	 * variable length text */
	get innerShape(){ return this.#meta.innerShape; }

	/** True if values() can return numbers (numeric or time elements) */
	get isNumeric(){ return this.#meta.isNumeric; }

	get props(){ return this.#meta.props; }

	/** Where the values come from: {kind: 'array'} for decoded stream
	 * values (the zero-copy path), {kind: 'sequence', minval, interval} for
	 * a value computed from the index, {kind: 'const'}, or {kind: 'binaryOp',
	 * op: '+', left: 'reference', right: 'offset'} for a value combined from
	 * two other variables of the same dimension, named by role (how a das2
	 * waveform's time center is built).  minval and interval are typed values
	 * {storage, units, value}; interval has one entry per dataset index,
	 * null where the sequence does not run. */
	get source(){ return this.#meta.source; }

	/** The formalism, the header's <ops> element: {kind: 'linear'} by
	 * default, {kind: 'point'} for a time stamp, {kind: 'vector', frame,
	 * system, sysorder: [0, 1, 2]} and so on, parameters parsed by type.
	 * Undefined for strings and blobs, which carry no math. */
	get ops(){ return this.#meta.ops; }

	/** Component symbols in storage order, ['x', 'y', 'z'] for a vector,
	 * [] for a scalar; null entries where the formalism names none */
	get symbols(){ return this.#meta.symbols; }

	/** Plain data for JSON.stringify, see DasDataset.toJSON().  Adds the
	 * live shape, which the snapshot does not carry. */
	toJSON()
	{
		const m = this.#meta;
		const out = {role: m.role, units: m.units, semantic: m.semantic, storage: m.storage,
		             shape: this.shape, innerShape: m.innerShape, isNumeric: m.isNumeric,
		             props: plain(m.props), source: plain(m.source)};
		if(m.ops !== undefined) out.ops = m.ops;
		out.symbols = m.symbols;
		return out;
	}

	/** Extent along each BULK dataset index: count, DasRuntime.RAGGED,
	 * DasRuntime.BORROW or DasRuntime.UNUSED.  Same length as the owning
	 * dataset's shape, and read live since index 0 grows with the stream. */
	get shape()
	{
		const c = this.#d._c();
		const a = new Array(this.#dsRank);
		for(let i = 0; i < this.#dsRank; ++i) a[i] = c.varShapeAt(this.#meta.ptr, i);
		return a;
	}

	/** The values.
	 *
	 * For numeric element types the result is the TypedArray matching
	 * storage, in C index order over the backing array's shape (which you
	 * get from arrayShape).  When source.kind is 'array' this is a VIEW over
	 * the wasm heap: no copy, and the detached-view caveat at the top of
	 * the file applies.  Otherwise das2C materializes a rectangular copy
	 * (ragged edges padded with fill) and the result is an independent
	 * TypedArray that outlives everything.
	 *
	 * 'das_time' elements, which only text-encoded streams produce, come
	 * back as a Float64Array copy of seconds since 1958-01-01 (das2C's
	 * internal epoch, no leap seconds).
	 *
	 * A 'string' semantic comes back as JavaScript strings, nested in Arrays
	 * to the variable's shape: a rank 1 text variable gives Array<string>,
	 * a rank 2 one (several status strings per record) Array<Array<string>>.
	 * das2C stores such text as byte runs in a ragged ubyte array one rank
	 * higher than the variable, so each string is decoded from the heap
	 * individually; text is never zero-copy.
	 *
	 * A 'blob' semantic (opaque byte runs) is not yet supported.
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
		const isText = (this.#meta.semantic === 'string');

		let pAry = c.varAry(this.#meta.ptr);
		let owned = false;
		if(pAry === 0){
			pAry = c.varQube(this.#meta.ptr, opts.shapeFrom ? opts.shapeFrom._p() : 0);
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
				if(vt === 'char*' || isText) return [];
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
			if(isText && vt === 'ubyte')
				return this.#textRuns(pAry, [], c.aryRank(pAry));

			return this.#view(pAry, vt, c.aryData(pAry), n, owned || opts.copy);
		}
		finally{
			if(owned) c.aryFree(pAry);
		}
	}

	/** The values as a Float64Array, re-based and scaled, fill as NaN.
	 *
	 *   out[i] = (value[i] - ref) * scale
	 *
	 * This is the plot-ready form, and the right way to consume an integer
	 * axis.  values() on a TT2000 time variable is a BigInt64Array, which
	 * is exact and free to create but costly to read: every element access
	 * from JavaScript allocates a BigInt, and turning a million of them into
	 * Numbers takes tens to hundreds of milliseconds.  This method does the
	 * same conversion in one C loop at memory speed and, more importantly,
	 * does the subtraction in int64 BEFORE the cast.  TT2000 values in the
	 * 2020s are around 8e17, far past the 2^53 limit of exact integers in a
	 * double, so Number(t) is quantized to 128 ns; Number(t - t0) is exact.
	 *
	 * Fill elements (the array's declared fill value) come back as NaN,
	 * which is what plotting libraries treat as a gap.  Leap seconds are not
	 * handled here: TT2000 times scale 1e-9 are TT seconds, not UTC.
	 *
	 * The result is always an independent copy, never a view; keep it as
	 * long as you like.  Text and blob variables are refused.
	 *
	 * @param {object} [opts]
	 * @param {bigint|number|'first'} [opts.ref] Reference subtracted from
	 *        every value, in the variable's own storage units (TT2000
	 *        nanoseconds for a TT2000 axis; for 'das_time' storage, the
	 *        seconds since 1958 that values() returns).  'first' uses the
	 *        first stored value, the usual choice for a time axis.  Default
	 *        none.
	 * @param {number} [opts.scale=1] Multiplier applied after the
	 *        subtraction: 1e-9 makes seconds of TT2000 nanoseconds
	 * @param {DasVar} [opts.shapeFrom] As for values()
	 * @returns {Float64Array}
	 */
	doubles(opts = {})
	{
		const c = this.#d._c();
		const m = this.#d._m();
		const sem = this.#meta.semantic;
		if(sem === 'string' || sem === 'blob')
			throw new DasError(`${sem} values have no double form`);
		const scale = (opts.scale === undefined) ? 1 : opts.scale;

		let pAry = c.varAry(this.#meta.ptr);
		let owned = false;
		if(pAry === 0){
			pAry = c.varQube(this.#meta.ptr, opts.shapeFrom ? opts.shapeFrom._p() : 0);
			if(pAry === 0)
				throw new DasError('cannot materialize values: ' + this.#d.lastError());
			owned = true;
		}

		try{
			const vt = c.aryValType(pAry);
			const n = c.arySize(pAry);
			if(n === 0) return new Float64Array(0);

			/* Broken-down times (text das2 streams) are already a C copy of
			 * doubles after aryTimes; re-base and scale that in place.  A
			 * Float64Array loop in JavaScript is memory-speed, it is only
			 * the BigInt path that is slow. */
			if(vt === 'das_time'){
				const pSec = c.aryTimes(pAry);
				if(pSec === 0)
					throw new DasError('time conversion failed: ' + this.#d.lastError());
				let out;
				try{ out = new Float64Array(m.HEAPU8.buffer, pSec, n).slice(); }
				finally{ c.free(pSec); }
				if(opts.ref !== undefined || scale !== 1){
					const r = (opts.ref === 'first') ? out[0] : Number(opts.ref ?? 0);
					for(let i = 0; i < n; ++i) out[i] = (out[i] - r) * scale;
				}
				return out;
			}

			/* 'first' is read straight out of the heap as the storage type,
			 * one element, so a BigInt is made at most once here */
			let ref = opts.ref;
			if(ref === 'first'){
				const Ctor = TYPED_ARRAYS[vt];
				if(Ctor === undefined) throw new DasError(`element type ${vt} is not convertible`);
				ref = new Ctor(m.HEAPU8.buffer, c.aryData(pAry), 1)[0];
			}
			const pOut = c.aryDoubles(pAry, this.#d._ref(vt, ref), scale);
			if(pOut === 0)
				throw new DasError('double conversion failed: ' + this.#d.lastError());
			try{
				/* slice() copies out of the heap before the buffer is freed;
				 * take HEAPU8 fresh, the malloc inside C may have grown it */
				return new Float64Array(this.#d._m().HEAPU8.buffer, pOut, n).slice();
			}
			finally{ c.free(pOut); }
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
	 * This is how ragged data is walked: lengthIn([]) is the record count,
	 * lengthIn([i]) the number of items in record i, and so on down.  The
	 * name follows das2C's rule: "In" takes a partial index and answers for
	 * the sub-array beneath it, "At" would take a full index and name one
	 * value.  Only for array-backed variables (source.kind === 'array').
	 *
	 * @param {number[]} loc leading indices, fewer than arrayShape.length
	 */
	lengthIn(loc)
	{
		const c = this.#d._c();
		const pAry = c.varAry(this.#meta.ptr);
		if(pAry === 0) throw new DasError('not an array-backed variable');
		const n = c.aryLengthAt(pAry, this.#d._loc(loc), loc.length);
		if(n < 0) throw new DasError(this.#d.lastError());
		return n;
	}

	/** The numeric values below a partial index, as a zero-copy view.
	 *
	 * valuesIn([i]) is record i's values, however many there are, which is
	 * what a ragged waveform plot wants.  valuesIn([]) equals values().
	 * Numeric element types only; see values() for text and time.
	 *
	 * @param {number[]} loc leading indices
	 * @param {object} [opts]
	 * @param {boolean} [opts.copy=false]
	 * @returns {TypedArray}
	 */
	valuesIn(loc, opts = {})
	{
		const c = this.#d._c();
		const pAry = c.varAry(this.#meta.ptr);
		if(pAry === 0) throw new DasError('not an array-backed variable');
		const pLoc = this.#d._loc(loc);
		const n = c.arySizeAt(pAry, pLoc, loc.length);
		if(n < 0) throw new DasError(this.#d.lastError());
		const p = c.aryDataAt(pAry, pLoc, loc.length);
		return this.#view(pAry, c.aryValType(pAry), p, n, !!opts.copy);
	}

	/** Shape of the array behind values(), which may have one more index
	 * than innerShape (the record index) and may be ragged.  Null for
	 * computed variables; use shape and innerShape instead. */
	get arrayShape()
	{
		const c = this.#d._c();
		const pAry = c.varAry(this.#meta.ptr);
		if(pAry === 0) return null;
		const n = c.aryRank(pAry);
		const a = new Array(n);
		for(let i = 0; i < n; ++i) a[i] = c.aryShapeAt(pAry, i);
		return a;
	}
}

/* ************************************************************************ */
/* Catalog
 *
 * The das federated catalog is a tree of small JSON documents spread over
 * several servers.  Container nodes (Catalog, Collection, SourceSet) list
 * their children by name with the URLs each loads from, mirrors included.
 * Source nodes (HttpStreamSrc) describe how to query a data server.
 *
 * das2C parses nodes, matches paths and falls back to the next mirror
 * (DasNodeWalk, das3/node.h); the documents are fetched with fetch(), so
 * the browser's HTTP cache and CORS rules apply.  Nodes stay in the wasm
 * heap until DasCatalog.free().
 */

/* das_walk_state_e from das3/node.h.  Hard coded: an enum has no value to
 * read at load time the way the shape sentinels do. */
const WALK_FETCH = 0;
const WALK_DONE = 1;

/* das2C's DASSRC_BLANK_REQ, a requisition with nothing filled in */
const BLANK_REQ = -1;

/* Where browsing starts when no seed is given: the federated site catalog,
 * reached from the compiled in root index */
const SITE_URI = 'tag:das2.org,2012:site';

/* A NUL terminated string the C side lends us, or null for a NULL pointer.
 * Not freed: the C object it belongs to still owns it. */
function cString(m, p)
{
	if(p === 0) return null;
	const end = m.HEAPU8.indexOf(0, p);
	return UTF8.decode(m.HEAPU8.subarray(p, end));
}

/** A catalog session.
 *
 * Holds the root of a node tree in the wasm heap and loads nodes below it
 * on demand.  Get one from DasRuntime.newCatalog().
 *
 *   const cat = das.newCatalog();
 *   const site = await cat.open();          // tag:das2.org,2012:site
 *   const v1 = await site.child('uiowa/voyager/1');
 *   for(const kid of v1.children) console.log(kid.name, kid.kind, kid.title);
 *   cat.free();
 *
 * Options:
 *
 *   seed     URL of a node to use as the root instead of das2C's compiled
 *            in root index.  Without seedUri it is an unnamed root: nodes
 *            below it are named by their path from it.
 *   seedUri  The catalog URI the seed node stands for, so the nodes below
 *            it carry their real federated names.
 *   start    Path from the root to the node open() returns.  Default
 *            'tag:das2.org,2012:site' without a seed, the seed itself with
 *            one.
 *   fetch    A fetch() work-alike, for tests that serve fixtures from
 *            another place, or apps that add headers.  Default: fetch.
 *   timeout  Milliseconds to wait for each catalog document, default
 *            10000.
 */
export class DasCatalog {
	#d;                     /* the DasRuntime handle */
	#root = 0;              /* DasNode*, the tree top this session owns */
	#loading = null;        /* Promise of the root while it loads */
	#nodes = new Map();     /* DasNode* -> DasCatNode, one view per node */
	#pending = new Map();   /* walks in flight, see walk() */
	#fetch;
	#timeout;
	#seed;
	#seedUri;
	#start;

	constructor(das3, opts = {})
	{
		this.#d = das3;

		/* The default is wrapped in an arrow function rather than stored as
		 * a bare reference.  The browser's fetch checks that it was called
		 * on the window and throws "Illegal invocation" when called as a
		 * method of some other object, which this.#fetch(...) would be. */
		this.#fetch = opts.fetch || ((url, init) => fetch(url, init));
		this.#timeout = opts.timeout ?? 10000;
		this.#seed = opts.seed || null;
		this.#seedUri = opts.seedUri || null;
		this.#start = opts.start ?? (this.#seed ? '' : SITE_URI);
	}

	/** The node browsing starts at, see the start option */
	async open(){ return this.resolve(this.#start); }

	/** Resolve a path from the root.  For the compiled in root that is a
	 * full catalog URI, 'tag:das2.org,2012:site:/uiowa/juno'; for a seed it
	 * is a path below the seed.
	 * @returns {Promise<DasCatNode>}
	 * @throws {DasError} naming the deepest node reached and what it lacked */
	async resolve(path)
	{
		const root = await this.root();
		return root.child(path);
	}

	/** The root node, loading it on first use */
	async root()
	{
		/* Concurrent first calls share one load rather than racing to set
		 * #root, which would leak the loser's tree */
		if(this.#root === 0){
			if(this.#loading === null)
				this.#loading = this.#loadRoot().finally(() => { this.#loading = null; });
			await this.#loading;
		}
		return this._node(this.#root);
	}

	/** Free every node this session loaded.  DasCatNode objects from it
	 * are unusable afterwards; DasCatSource objects are independent and
	 * stay valid. */
	free()
	{
		if(this.#root === 0) return;
		this.#d._c().nodeDel(this.#root);
		this.#root = 0;
		this.#nodes.clear();
	}

	/* The one view object per node, so a tree view can compare nodes with
	 * === and keep state on them */
	_node(p)
	{
		let node = this.#nodes.get(p);
		if(node === undefined){
			node = new DasCatNode(this, this.#d, p, takeJson(this.#d, this.#d._c().nodeJson(p)));
			this.#nodes.set(p, node);
		}
		return node;
	}

	/* Walk from a loaded node, for DasCatNode.child().
	 *
	 * Two walks in flight to the same not-yet-loaded child would each load
	 * it and each attach it under the parent when done, since das2C checks
	 * for an existing child when a walk starts but not when it finishes.
	 * So identical walks share one promise.  Overlapping different paths
	 * ('a' and 'a/b' at once) are not caught here. */
	walk(pFrom, path)
	{
		const key = pFrom + '\n' + path;
		let pr = this.#pending.get(key);
		if(pr === undefined){
			pr = this.#walk(pFrom, path).finally(() => this.#pending.delete(key));
			this.#pending.set(key, pr);
		}
		return pr;
	}

	async #walk(pFrom, path)
	{
		const c = this.#d._c();
		/* new_DasNodeWalk logs its refusal rather than recording it, so
		 * lastError() would hold some earlier, unrelated failure */
		const w = c.walkNew(pFrom, path);
		if(w === 0){
			const n = this._node(pFrom);
			throw new DasError(`can't walk to '${path}' from ${n.uri ?? n.url}: it is a `
				+ `${n.type} node, not a container` + (n.isSource ? '; see DasRuntime.loadSource()' : ''));
		}
		try{
			const tried = await this.#drive(w);
			const p = c.walkResult(w);
			if(p !== 0) return this._node(p);
			throw new DasError(this.#missMessage(w, path, tried));
		}
		finally{ c.walkDel(w); }
	}

	async #loadRoot()
	{
		const c = this.#d._c();
		if(this.#seed !== null){
			let doc;
			try{ doc = await this.#get(this.#seed); }
			catch(e){ throw new DasError(`${this.#seed}: ${e.message}`); }
			const p = this.#withHeap(doc.bytes,
				(pBytes, n) => c.nodeNew(pBytes, n, doc.url, this.#seedUri));
			if(p === 0)
				throw new DasError(`${this.#seed} is not a catalog node: ${this.#d.lastError()}`);
			this.#root = p;
			return;
		}

		/* The compiled in root index, from whichever of its mirrors answers */
		const w = c.walkSeed();
		try{
			const tried = await this.#drive(w, true);
			const p = c.walkResult(w);
			if(p === 0)
				throw new DasError(`no copy of the das catalog index answered: ${tried.join('; ')}`);
			this.#root = p;   /* a seed is the caller's to free, see node.h */
		}
		finally{ c.walkDel(w); }
	}

	/* The driver loop from das3/node.h with fetch() as the transport.
	 * Index 0 is always the candidate to try next: das2C drops the ones that
	 * fail.  Returns what went wrong along the way, for error messages.
	 *
	 * Each await hands control back to the page, which may free the catalog
	 * meanwhile.  Feeding a walk whose start node is gone would write into
	 * freed memory, so the root is re-checked after every fetch.  A seed
	 * walk starts from nothing and is exempt. */
	async #drive(w, bSeed = false)
	{
		const c = this.#d._c();
		const tried = [];
		while(c.walkState(w) === WALK_FETCH){
			const url = c.walkUrl(w, 0);
			let doc = null, why = '';
			try{ doc = await this.#get(url); }
			catch(e){ why = e.message; }

			if(!bSeed && this.#root === 0)
				throw new DasError('catalog freed during a walk');

			if(doc === null){
				tried.push(`${url}: ${why}`);
				c.walkFail(w, 0, why);
				continue;
			}
			const rc = this.#withHeap(doc.bytes,
				(pBytes, n) => c.walkFeed(w, 0, pBytes, n, doc.url));
			if(rc !== 0) tried.push(`${url}: not a catalog node`);
		}
		return tried;
	}

	/* One catalog document.  Rejects with a short reason as the message. */
	async #get(url)
	{
		/* fetch() never gives up on a server that accepts the connection
		 * and then says nothing.  The timeout covers the body read too. */
		const signal = AbortSignal.timeout(this.#timeout);
		let resp;
		try{ resp = await this.#fetch(url, {signal}); }
		catch(e){
			if(e.name === 'TimeoutError') throw new Error(`no answer in ${this.#timeout / 1000} s`);
			throw new Error(e.message || String(e));
		}
		if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const bytes = new Uint8Array(await resp.arrayBuffer());

		/* The final URL only when the server really redirected; a custom
		 * fetch that maps URLs to fixtures should not rename the node */
		return {bytes, url: resp.redirected ? resp.url : url};
	}

	/* Copy bytes into a temporary heap buffer for the length of one call.
	 * malloc(0) may return NULL, hence the minimum of one byte. */
	#withHeap(bytes, fn)
	{
		const m = this.#d._m();
		const p = m._malloc(bytes.length || 1);
		try{
			m.HEAPU8.set(bytes, p);
			return fn(p, bytes.length);
		}
		finally{ m._free(p); }
	}

	/* "no 'juno/wav' under tag:...:/uiowa" plus the failures on the way.
	 * DasNodeWalk_nearest reports through an out pointer, so a 4 byte slot
	 * on the heap receives it. */
	#missMessage(w, path, tried)
	{
		const m = this.#d._m();
		const pRest = m._malloc(4);
		let sNear, sRest;
		try{
			m.HEAP32[pRest >> 2] = 0;
			sNear = cString(m, this.#d._c().walkNearest(w, pRest));
			sRest = cString(m, m.HEAP32[pRest >> 2]);
		}
		finally{ m._free(pRest); }

		let msg = (sNear === null)
			? `couldn't resolve '${path}'`
			: `no '${sRest ?? path}' under ${sNear || 'the root'}`;
		if(tried.length > 0) msg += ` (${tried.join('; ')})`;
		return msg;
	}
}

/** One node of a catalog, a view over a snapshot taken when it loaded.
 *
 * Fields follow the node document: kind, type, version, name, label,
 * title, description, plus the uri it has in the catalog (null for a
 * root), the url it loaded from and, for containers, the separator its
 * children's names are joined with.
 *
 * kind is das2C's normalized type: 'catalog', 'collection', 'srcset',
 * 'stream_src', 'file_agg', 'spdf_cat', 'spase_cat', or 'inv' for a type
 * this das2C does not know (type still has the document's spelling).
 */
export class DasCatNode {
	#cat;
	#d;
	#p;
	#s;
	#kids = null;

	constructor(cat, das3, p, snap)
	{
		this.#cat = cat;
		this.#d = das3;
		this.#p = p;
		this.#s = snap;
	}

	get kind(){ return this.#s.kind; }
	get type(){ return this.#s.type; }
	get version(){ return this.#s.version; }
	get name(){ return this.#s.name; }
	get label(){ return this.#s.label; }
	get title(){ return this.#s.title; }
	get description(){ return this.#s.description; }
	get uri(){ return this.#s.uri; }
	get url(){ return this.#s.url; }
	get separator(){ return this.#s.separator; }

	/** True for nodes that list children, whether or not any are listed */
	get isContainer(){ return this.#s.separator !== null; }

	/** True for nodes source() can build a data source from */
	get isSource(){ return this.#s.kind === 'stream_src'; }

	/** The listed children, known without loading any of them.
	 *
	 * Each is {name, kind, label, title, description, provides, urls,
	 * loadable, stub}.  name is the path component for child(); label is
	 * what to show, falling back to the name.  loadable says das2C could
	 * build a data source from that child.  stub is the container's entry
	 * as the server wrote it, for fields not lifted out here.
	 */
	get children()
	{
		if(this.#kids === null){
			const loadable = new Set(this.#s.loadable);
			this.#kids = this.#s.children.map(k => {
				const st = k.stub || {};
				return {
					name: k.name,
					kind: k.kind,
					label: st.label || st.name || k.name,
					title: st.title || null,
					description: st.description || null,
					provides: st.provides || [],
					urls: st.urls || [],
					loadable: loadable.has(k.name),
					stub: st,
				};
			});
		}
		return this.#kids;
	}

	/** Load a descendant: one child name, or a path of them joined by the
	 * separators the catalog uses.  A child already loaded costs nothing.
	 * @returns {Promise<DasCatNode>}
	 * @throws {DasError} naming the deepest node reached and what it lacked */
	child(path){ return this.#cat.walk(this.#p, path); }

	/** A data source built from this node, see DasCatSource.  Only for
	 * nodes where isSource is true. */
	source(){ return new DasCatSource(this.#d, this.#p); }
}

/** A data source: what a source node offers and the request URLs for it.
 *
 * Built from a copy of the node document, so it outlives the catalog it
 * came from.  Holds C memory: call free() when done.
 */
export class DasCatSource {
	#d;
	#p;

	constructor(das3, pNode)
	{
		this.#d = das3;
		this.#p = das3._c().srcNew(pNode);
		/* new_DasSrc_node logs why, it doesn't record it for lastError() */
		if(this.#p === 0)
			throw new DasError('not a data source node, see the log for why');
	}

	get title(){ return cString(this.#d._m(), this.#d._c().srcTitle(this.#p)); }

	/** True if the catalog marks the source as protected.  Servers may
	 * still answer some requests without a login, by time range for
	 * instance; a 401 (DasError.status) is the real answer. */
	get needsAuth(){ return this.#d._c().srcNeedsAuth(this.#p); }

	/** The login realm the catalog names, or '' */
	get authRealm(){ return cString(this.#d._m(), this.#d._c().srcAuthRealm(this.#p)); }

	/** Labels of the worked examples the node provides, possibly none */
	get examples()
	{
		const c = this.#d._c();
		const n = c.srcExCount(this.#p);
		const a = new Array(n);
		for(let i = 0; i < n; ++i) a[i] = c.srcExLabel(this.#p, i);
		return a;
	}

	/** Build a request.
	 *
	 * @param {number} [example] Which worked example to start from.  -1
	 *        starts blank.  Default: the first example if there is one.
	 * @param {object} [settings] Keys to change, {'time.min': '2025-10-01'},
	 *        in the spellings das_fetch accepts (das3/source.h, "Keys").
	 * @returns {{url: string, mime: string}} mime is '' when the source
	 *        does not say what it will send
	 * @throws {DasError} for an unknown key, or settings that don't add up
	 *        to a request; das2C logs the details to the console
	 */
	request(example, settings = {})
	{
		const c = this.#d._c();
		const m = this.#d._m();
		if(example === undefined) example = (c.srcExCount(this.#p) > 0) ? 0 : BLANK_REQ;

		const req = c.srcNewReq(this.#p, example);
		if(req === 0) throw new DasError(`no example ${example}: ${this.#d.lastError()}`);
		let buf = 0;
		try{
			for(const [key, val] of Object.entries(settings))
				if(c.reqSet(req, key, String(val)) !== 0)
					throw new DasError(`can't set ${key}: ${this.#d.lastError()}`);

			/* snprintf style: the return is the length needed, so one retry
			 * with the exact size covers any URL */
			let size = 4096;
			buf = m._malloc(size);
			let n = c.srcUrl(this.#p, req, 0, buf, size);
			if(n >= size){
				m._free(buf);
				size = n + 1;
				buf = m._malloc(size);
				n = c.srcUrl(this.#p, req, 0, buf, size);
			}
			if(n === 0)
				throw new DasError('no request URL for these settings, see the console log');
			return {url: cString(m, buf), mime: c.srcMime(this.#p, req)};
		}
		finally{
			if(buf) m._free(buf);
			c.reqDel(req);
		}
	}

	/** Release the C side.  The object is unusable afterwards. */
	free()
	{
		if(this.#p === 0) return;
		this.#d._c().srcDel(this.#p);
		this.#p = 0;
	}
}
