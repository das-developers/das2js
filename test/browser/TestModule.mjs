/* Browser-side checks of src/das2js.mjs, the JavaScript twin of
 * test/TestWasm.c.  Same fixtures, same walk, same self-consistency checks,
 * but through the ES module rather than the C functions directly, so what
 * is tested here is the marshalling, the TypedArray construction and the
 * fetch/feed loop.
 *
 * Reporting goes two ways at once: into the page (so a human loading the
 * page sees something) and to the runner over POST (so make sees the
 * result).  The runner is optional; served from anywhere else the page
 * skips the POSTs and still works. */

import {load, DasError, basicAuth} from '../build/das2js.mjs';

const out = document.getElementById('out');
let failed = false;

/* The node runner (make server, headless tests) listens on 127.0.0.1 only,
 * so any other host is a plain web server with no /log or /done.  Skip the
 * POSTs there rather than leave a 404 in its access log per line. */
const RUNNER = location.hostname === '127.0.0.1';

/* POSTs are chained so lines reach the runner in the order logged; fired
 * independently they race and interleave */
let queue = Promise.resolve();
function log(line)
{
	out.textContent += line + '\n';
	if(RUNNER)
		queue = queue.then(() => fetch('/log', {method: 'POST', body: line})).catch(() => {});
}

function check(cond, msg)
{
	if(!cond){
		failed = true;
		log('ERROR: ' + msg);
	}
	return cond;
}

async function done()
{
	log(failed ? 'ERROR: module test FAILED' : 'INFO: All module checks passed');
	if(!RUNNER) return;
	try{
		await queue;   /* every log line first, then the verdict */
		await fetch('/done', {method: 'POST', body: JSON.stringify({pass: !failed})});
	}
	catch(e){ /* no runner, that is fine */ }
}

/* The same fixtures TestWasm.c uses: das3 binary vectors, das3 rank 2
 * strings, a das2 text stream exercising up-conversion and das_time, and a
 * ragged waveform for the partial-index access */
const FIXTURES = [
	'../das2C/examples/ex17_vector_noframe.d3b',
	'../das2C/examples/ex35_strings_rank2.d3b',
	'../das2C/examples/ex01_polar_mfe.d2t',
	'../das2C/examples/ex19_cassini_ragged_wfrm.d3t',
	/* two multi-dataset das2 streams whose packet headers arrive AFTER data
	 * packets for earlier ids, the Juno/WAV/Survey shape */
	'../das2C/examples/ex08_cassini_rpws_survey.d2t',
	'../das2C/examples/ex09_juno_waves_survey.d2t',
];

const SEMANTICS = new Set(['bool', 'datetime', 'integer', 'real', 'string', 'blob']);
const SOURCE_KINDS = new Set(['array', 'sequence', 'const', 'unaryOp', 'binaryOp']);
const PROP_TYPES = new Set(['bool', 'boolArray', 'datetime', 'datetimeRange',
	'datetimeArray', 'integer', 'integerRange', 'integerArray', 'real', 'realRange',
	'realArray', 'string', 'stringArray']);

/* Every property entry has the same four fields; only value's JS type
 * changes, picked by type */
function checkProps(props, tag)
{
	check(Object.getPrototypeOf(props) === Object.prototype, `${tag}: props is not a plain object`);
	for(const [k, e] of Object.entries(props)){
		check(k !== '', `${tag}: property with empty name`);
		check(PROP_TYPES.has(e.type), `${tag}: property ${k} has type '${e.type}'`);
		check(typeof e.units === 'string', `${tag}: property ${k} units not a string`);
		check(e.alt !== null && typeof e.alt === 'object', `${tag}: property ${k} alt not an object`);
		const base = e.type.replace(/Range|Array$/, '');
		const multi = (base !== e.type);
		check(multi === Array.isArray(e.value), `${tag}: property ${k} value container wrong for ${e.type}`);
		if(e.type.endsWith('Range'))
			check(e.value.length === 2, `${tag}: range property ${k} has ${e.value.length} entries`);
		const want = {bool: 'boolean', datetime: 'string', integer: 'bigint', real: 'number', string: 'string'}[base];
		for(const v of (multi ? e.value : [e.value]))
			check(typeof v === want || (base === 'real' && v === null), `${tag}: property ${k} value is ${typeof v}, want ${want}`);
	}
}

function walkStream(d, strm, name)
{
	const nDs = strm.length;
	if(!check(nDs > 0, `${name}: stream has no datasets`)) return;

	for(const ds of strm.datasets()){
		check(ds.name !== '', `${name}: dataset without a name`);
		check(strm.dataset(0) === ds || ds !== strm.dataset(0), `${name}: dataset handle identity`);
		const shape = ds.shape;
		check(shape.length === ds.rank, `${name}: shape length is not the rank`);
		check(shape.length >= 1, `${name}: dataset with no bulk indices`);
		check(shape[0] >= 0, `${name}: negative record count`);
		const empty = (shape[0] === 0);
		if(empty) log(`INFO: ${name}: dataset '${ds.name}' has a header but no records`);
		checkProps(ds.props, `${name} ${ds.name}`);

		const dims = ds.coords.concat(ds.data);
		check(dims.length > 0, `${name}: dataset with no dimensions`);
		check(ds.coords === ds.coords, `${name}: coords not stable between reads`);

		for(const dim of dims){
			check(dim.name !== '', `${name}: dimension without a name`);
			check(dim.physDim !== '', `${name}: dimension ${dim.name} without a physDim`);
			check(dim.kind === (ds.coords.includes(dim) ? 'coord' : 'data'), `${name}: ${dim.name} kind mismatch`);
			check(Array.isArray(dim.axes), `${name}: ${dim.name} axes not an array`);
			check(ds.dim(dim.name) === dim, `${name}: dim(${dim.name}) lookup failed`);
			checkProps(dim.props, `${name} ${ds.name}/${dim.name}`);
			const vars = Object.entries(dim.vars);
			check(vars.length > 0, `${name}: dimension ${dim.name} has no variables`);

			for(const [role, v] of vars){
				const tag = `${name} ${ds.name}/${dim.name}:${role}`;
				check(role !== '' && v.role === role, `${tag}: role mismatch`);
				check(dim.var(role) === v, `${tag}: var(role) lookup failed`);
				check(SEMANTICS.has(v.semantic), `${tag}: semantic '${v.semantic}' out of vocabulary`);
				check(v.storage !== '', `${tag}: no storage type`);
				check(SOURCE_KINDS.has(v.source.kind), `${tag}: source kind '${v.source.kind}' out of vocabulary`);
				check(Array.isArray(v.innerShape), `${tag}: innerShape not an array`);
				checkProps(v.props, tag);

				const isBytes = (v.semantic === 'string' || v.semantic === 'blob');
				check(isBytes === (v.ops === undefined), `${tag}: ops present=${v.ops !== undefined} for semantic ${v.semantic}`);
				if(!isBytes) check(typeof v.ops.kind === 'string' && v.ops.kind !== '', `${tag}: ops without a kind`);

				/* symbols are per element of one value, in storage order */
				const nInner = isBytes ? 0 : v.innerShape.reduce((a, b) => a * b, 1);
				check(v.symbols.length === (nInner > 0 && v.innerShape.length > 0 ? nInner : 0),
					`${tag}: ${v.symbols.length} symbols for inner shape [${v.innerShape}]`);

				if(v.source.kind === 'sequence'){
					const g = v.source;
					const mins = Array.isArray(g.minval) ? g.minval : [g.minval];
					for(const dm of mins)
						check(typeof dm.storage === 'string' && 'units' in dm && 'value' in dm, `${tag}: sequence minval not a typed value`);
					const rows = Array.isArray(g.interval[0]) ? g.interval : [g.interval];
					for(const row of rows){
						check(row.length === ds.rank, `${tag}: interval has ${row.length} slots for rank ${ds.rank}`);
						check(row.some(x => x !== null), `${tag}: sequence runs along no index`);
					}
				}

				const vshape = v.shape;
				check(vshape.length === ds.rank, `${tag}: var shape length is not the rank`);
				for(const ext of vshape)
					check(ext >= 0 || ext === d.RAGGED || ext === d.BORROW || ext === d.UNUSED,
						`${tag}: shape entry ${ext} out of contract`);

				/* blobs are the one semantic values() refuses */
				if(v.semantic === 'blob') continue;

				const isArray = (v.source.kind === 'array');
				const donor = ds.shapeDonor(v);
				if(empty){
					/* values() must answer with an empty container, not throw,
					 * for anything that varies along records.  A variable that
					 * does not (a das2 frequency table, UNUSED along index 0)
					 * is fully present with zero records; that is correct. */
					if(isArray && vshape[0] !== d.UNUSED)
						check(v.values().length === 0, `${tag}: empty dataset gave values`);
					continue;
				}
				const vals = v.values({shapeFrom: donor});
				check(vals.length > 0, `${tag}: no values`);

				if(v.semantic === 'string'){
					check(Array.isArray(vals), `${tag}: text did not come back as an Array`);
					/* nested to the variable's shape: descend to the first leaf */
					let leaf = vals;
					while(Array.isArray(leaf)) leaf = leaf[0];
					check(typeof leaf === 'string' && leaf.length > 0, `${tag}: first string missing`);
				}
				else if(v.storage === 'das_time'){
					check(vals instanceof Float64Array, `${tag}: das_time not Float64Array`);
					/* seconds since 1958: 0 (1958) to ~4.5e9 (2100) */
					check(vals[0] > 0 && vals[0] < 4.5e9, `${tag}: time ${vals[0]} implausible`);
				}
				else{
					check(ArrayBuffer.isView(vals), `${tag}: numeric values not a TypedArray`);

					/* The zero-copy promise: for array-backed variables the view
					 * must sit inside the wasm heap, not in a fresh buffer */
					if(isArray)
						check(vals.buffer === d._m().HEAPU8.buffer, `${tag}: view is not over the heap`);

					/* and the copy option must give an independent buffer with
					 * equal contents */
					const copy = v.values({copy: true, shapeFrom: donor});
					check(copy.buffer !== d._m().HEAPU8.buffer, `${tag}: copy still aliases heap`);
					check(copy.length === vals.length, `${tag}: copy length differs`);
					let same = true;
					for(let i = 0; i < vals.length && same; ++i) same = (copy[i] === vals[i]);
					check(same, `${tag}: copy contents differ`);

					/* per-record sub-arrays must tile the flat view exactly */
					if(isArray){
						const nRecs = v.lengthIn([]);
						check(nRecs === v.arrayShape[0], `${tag}: lengthIn([]) is not the record count`);
						let total = 0;
						for(let i = 0; i < nRecs; ++i){
							const rec = v.valuesIn([i]);
							if(rec.length > 0)
								check(rec.byteOffset === vals.byteOffset + total * vals.BYTES_PER_ELEMENT,
									`${tag}: record ${i} not contiguous with predecessor`);
							total += rec.length;
						}
						check(total === vals.length, `${tag}: records do not tile the array`);
					}
				}

				/* doubles(): the plot-ready form of anything numeric.  Always
				 * a fresh Float64Array of the same length; re-based on the
				 * first element the first entry is 0 (or NaN for fill) and,
				 * for int64 storage, every entry equals the exact BigInt
				 * difference.  That last check is the reason the method
				 * exists: it would fail if C cast before subtracting. */
				if(v.semantic !== 'string'){
					const dbl = v.doubles({shapeFrom: donor});
					check(dbl instanceof Float64Array, `${tag}: doubles() not a Float64Array`);
					check(dbl.length === vals.length, `${tag}: doubles() length ${dbl.length} != ${vals.length}`);
					check(dbl.buffer !== d._m().HEAPU8.buffer, `${tag}: doubles() aliases the heap`);
					const rel = v.doubles({ref: 'first', shapeFrom: donor});
					check(rel[0] === 0 || Number.isNaN(rel[0]), `${tag}: re-based first element is ${rel[0]}`);
					if(vals instanceof BigInt64Array || vals instanceof BigUint64Array){
						let exact = true;
						for(let i = 0; i < vals.length && exact; ++i)
							if(!Number.isNaN(rel[i])) exact = (rel[i] === Number(vals[i] - vals[0]));
						check(exact, `${tag}: re-based int64 doubles are not exact differences`);
					}
				}
			}
		}
	}
	log(`INFO: ${name}: ${nDs} dataset(s) walked clean through the module`);
}

async function main()
{
	const d = await load({progName: 'TestModule'});
	log(`INFO: module loaded, RAGGED=${d.RAGGED} UNUSED=${d.UNUSED}`);

	for(const url of FIXTURES){
		let nChunks = 0;
		let strm;
		try{
			strm = await d.fetchStream(url, {onChunk: () => { ++nChunks; }});
		}
		catch(e){
			check(false, `${url}: ${e.message}`);
			continue;
		}
		check(nChunks > 0, `${url}: onChunk never called`);
		walkStream(d, strm, url);

		checkProps(strm.props, `${url} stream`);

		/* the printable form: stringify must not throw on BigInts, must not
		 * leak heap pointers, and must carry the live shape */
		{
			let text = '';
			try{ text = JSON.stringify(strm); }
			catch(e){ check(false, `${url}: JSON.stringify(stream) threw ${e.message}`); }
			const o = text ? JSON.parse(text) : {datasets: []};
			check(o.datasets.length === strm.length, `${url}: toJSON dataset count`);
			check(!text.includes('"ptr"'), `${url}: toJSON leaks pointers`);
			if(o.datasets.length > 0)
				check(o.datasets[0].shape[0] === strm.dataset(0).shape[0], `${url}: toJSON shape not live`);
		}
		strm.free();
	}

	/* The snapshot's structural keys on a known fixture: ex17 is a cartesian
	 * 3-vector with its sysorder declared, a TT2000 time axis with a point
	 * formalism, and a das2-style group-less dataset */
	{
		const strm = await d.fetchStream(FIXTURES[0]);
		const ds = strm.dataset(0);
		check(ds.name === 'BDC_ROI' && ds.group === '', `ex17: name/group ${ds.name}/${ds.group}`);
		const t = ds.dim('time').var();
		check(t.semantic === 'datetime' && t.storage === 'long' && t.units === 'TT2000',
			`ex17: time is ${t.semantic}/${t.storage}/${t.units}`);
		check(t.ops.kind === 'point', `ex17: time ops kind ${t.ops.kind}`);
		check(t.values() instanceof BigInt64Array, 'ex17: TT2000 values not BigInt64Array');
		{
			/* the intended idiom for a time axis: seconds from the first
			 * sample, as a Float64Array a plotting library takes as is */
			const big = t.values();
			const sec = t.doubles({ref: 'first', scale: 1e-9});
			check(sec[0] === 0 && sec[sec.length - 1] > 0, `ex17: seconds from first sample ${sec[0]}..${sec[sec.length - 1]}`);
			check(sec[1] === Number(big[1] - big[0]) * 1e-9, 'ex17: scaled seconds not exact');
			/* an explicit BigInt reference equals 'first' when it is the first
			 * value, and a small Number reference is widened to a BigInt */
			const a = t.doubles({ref: big[0]});
			const rel = t.doubles({ref: 'first'});
			check(a.length === rel.length && a.every((x, i) => x === rel[i]), 'ex17: BigInt ref differs from first');
			const c = t.doubles({ref: 5});
			check(c[0] === Number(big[0] - 5n), 'ex17: Number reference not widened to BigInt');
			/* and no reference at all rounds to the nearest double, as Number() would */
			const plain = t.doubles();
			check(plain[0] === Number(big[0]), 'ex17: plain doubles differ from Number()');
		}
		const b = ds.dim('b_tscs').var();
		check(b.ops.kind === 'vector' && b.ops.system === 'cartesian', `ex17: vector ops ${JSON.stringify(b.ops)}`);
		check(Array.isArray(b.ops.sysorder) && b.ops.sysorder.join() === '0,1,2', 'ex17: sysorder not parsed to ints');
		check(b.innerShape.join() === '3' && b.symbols.join() === 'x,y,z', `ex17: inner [${b.innerShape}] syms [${b.symbols}]`);
		const lbl = ds.dim('b_tscs').props.label;
		check(lbl.type === 'string' && typeof lbl.value === 'string' && lbl.units === '' && Object.keys(lbl.alt).length === 0, 'ex17: label property');
		strm.free();
	}

	/* Mid-download visibility: feed a fixture by hand in small chunks and
	 * confirm the dataset grows between feeds */
	{
		const resp = await fetch(FIXTURES[0]);
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const rdr = d.newReader();
		let lastRecs = 0, grew = false;
		for(let i = 0; i < bytes.length; i += 997){
			rdr.feed(bytes.subarray(i, i + 997));
			const s = rdr.stream;
			if(s && s.length > 0){
				const recs = s.dataset(0).shape[0];
				if(recs > lastRecs && lastRecs > 0) grew = true;
				lastRecs = recs;
			}
		}
		rdr.end();
		check(grew, 'dataset record count never grew between feeds');
		rdr.free();
		log('INFO: progressive feed observed growth to ' + lastRecs + ' records');
	}

	/* Late headers: in ex08 the headers for packet ids 03, 04 and 05 come
	 * after over a thousand data packets for id 02.  Nothing may assume all
	 * headers precede all data.  Feed in chunks and record the dataset
	 * count each time records exist; it must still be climbing after the
	 * first records have landed. */
	{
		const resp = await fetch('../das2C/examples/ex08_cassini_rpws_survey.d2t');
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const rdr = d.newReader();
		let countWhenFirstRecords = -1;
		for(let i = 0; i < bytes.length; i += 4093){
			rdr.feed(bytes.subarray(i, i + 4093));
			const s = rdr.stream;
			if(s && countWhenFirstRecords < 0 && s.length > 0 && s.dataset(0).shape[0] > 0)
				countWhenFirstRecords = s.length;
		}
		rdr.end();
		const finalCount = rdr.stream.length;
		check(countWhenFirstRecords > 0, 'ex08: never saw records mid-feed');
		check(finalCount > countWhenFirstRecords,
			`ex08: dataset count ${finalCount} did not grow after records arrived (was ${countWhenFirstRecords})`);
		log(`INFO: late headers: ${countWhenFirstRecords} dataset(s) when records began, ${finalCount} at end`);
		rdr.free();
	}

	/* Painting through DasRender: the same late-header stream, fed in
	 * chunks with a renderer attached.  The image is fetched mid-stream and
	 * again at the end; the heap grows in between, so the second
	 * imageData() would come back empty if it reused a stale view. */
	{
		const resp = await fetch('../das2C/examples/ex08_cassini_rpws_survey.d2t');
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const rdr = d.newReader();
		const ren = d.newRender(800, 232);
		ren.setX('2017-01-01T02:40', '2017-01-01T06:00');
		ren.attach(rdr);
		check(ren.kind === 'none', `render: kind '${ren.kind}' before any header`);
		let midImage = null;
		for(let i = 0; i < bytes.length; i += 4093){
			rdr.feed(bytes.subarray(i, i + 4093));
			if(midImage === null && ren.dirty) midImage = ren.imageData();
		}
		rdr.end();
		check(midImage !== null, 'render: never dirty mid-stream');
		check(ren.kind === 'spectrogram', `render: kind '${ren.kind}', want spectrogram`);
		const img = ren.imageData();
		check(img.width === 800 && img.height === 232 && img.data.length === 800*232*4, 'render: image size');
		let lit = 0;
		for(let p = 0; p < img.data.length; p += 4)
			if(img.data[p] | img.data[p+1] | img.data[p+2]) ++lit;
		check(lit > 800*232/4, `render: only ${lit} pixels painted`);
		check(img.data[3] === 255, 'render: alpha not opaque');
		const y = ren.axis(false);
		check(y.min < y.max && y.units === 'Hz', `render: y axis ${JSON.stringify(y)}`);
		let threw = false;
		try{ ren.setX('2017-01-01', '2017-01-02'); }
		catch(e){ threw = (e instanceof DasError); }
		check(threw, 'render: setX after data was accepted');
		log(`INFO: render: ${lit} pixels painted, ${ren.rescales} rescale(s), ${ren.paintMs.toFixed(1)} ms`);
		rdr.free();   /* reader first, it points at the renderer */
		ren.free();
	}

	/* Error path: garbage must throw a DasError carrying a message */
	{
		const rdr = d.newReader();
		let threw = false;
		try{ rdr.feed(new TextEncoder().encode('not a das stream')); }
		catch(e){
			threw = true;
			check(e instanceof DasError, 'garbage threw something other than DasError');
			check(e.message !== '', 'parse failure left no message');
		}
		check(threw, 'garbage input accepted');
		rdr.free();
	}

	/* HTTP failure path */
	{
		let threw = false;
		try{ await d.fetchStream('../das2C/examples/no_such_file.d3b'); }
		catch(e){ threw = (e instanceof DasError); }
		check(threw, '404 did not surface as DasError');
	}
	return d;
}

/* Catalog walks against the internal test catalog in test/catalog/, a copy of
 * real nodes laid out as host/path.  tracers-1.json is trimmed to the
 * public levels, L2 and SPICE.  The custom fetch maps every https URL
 * the walk asks for onto that tree, so das2C sees the real URLs and the
 * runner serves the bytes.  Hosts not in the copy, and siblings left out of
 * it, come back 404, which is how the failure paths are reached.
 * 'hang.invalid' never answers, for the timeout. */
function fixtureFetch(url, init)
{
	if(url.includes('//hang.invalid/'))
		return new Promise((_, reject) =>
			init.signal.addEventListener('abort', () => reject(init.signal.reason)));
	return fetch(url.replace(/^https:\/\//, '../catalog/'), init);
}

async function expectThrow(pr, re, msg)
{
	try{ await pr; }
	catch(e){
		check(e instanceof DasError, `${msg}: threw ${e.name}, not DasError`);
		check(re.test(e.message), `${msg}: message '${e.message}' lacks ${re}`);
		return;
	}
	check(false, `${msg}: did not throw`);
}

const SITE = 'tag:das2.org,2012:site';
const VGR = 'uiowa/voyager/1/pws/specanalyzer-4s-efield';   /* a Collection */
const BAC = 'uiowa/tracers/tracers-1/l2/msc_bac';            /* a SourceSet */
const VGR_DAS2 = 'https://planet.physics.uiowa.edu/das/das2Server?server=dataset'
	+ '&dataset=Voyager/1/PWS/SpecAnalyzer-4s-Efield';

async function catalogChecks(d)
{
	/* The compiled in root index, then down to the federated site catalog */
	const cat = d.newCatalog({fetch: fixtureFetch});
	const site = await cat.open();
	check(site.uri === SITE, `site uri ${site.uri}`);
	check(site.kind === 'catalog' && site.separator === ':/', `site kind ${site.kind}, sep ${site.separator}`);
	check(site.children.map(k => k.name).join() === 'jhuapl,uiowa,voparis',
		`site children ${site.children.map(k => k.name)}`);
	check(site.isContainer && !site.isSource, 'site container flags');
	const root = await cat.root();
	check(root.uri === null, `compiled root uri ${root.uri}`);

	/* A Collection holding one das2 source */
	const coll = await site.child(VGR);
	check(coll.uri === `${SITE}:/${VGR}`, `collection uri ${coll.uri}`);
	check(coll.kind === 'collection', `collection kind ${coll.kind}`);
	const lone = coll.children[0];
	check(coll.children.length === 1 && lone.name === 'das2' && lone.kind === 'stream_src'
		&& lone.loadable, `collection children ${coll.children.map(k => k.name)}`);

	/* A SourceSet with one source das2C can load beside one it can't, and
	 * that source's request URL in dasFlex's form */
	{
		const bac = await site.child(BAC);
		check(bac.uri === `${SITE}:/${BAC}`, `bac uri ${bac.uri}`);
		check(bac.kind === 'srcset', `bac kind ${bac.kind}`);
		const kids = Object.fromEntries(bac.children.map(k => [k.name, k]));
		check(kids.flex?.kind === 'stream_src' && kids.flex.loadable, 'flex listed as a loadable source');
		check(kids.das2?.kind === 'inv' && kids.das2.stub.type === 'Das2DSDF', 'das2 child is an unknown type');
		log(`INFO: catalog: ${bac.uri}: ${bac.children.map(k => `${k.name}(${k.kind})`).join(' ')}`);

		const flex = await bac.child('flex');
		check(flex.isSource && flex.version === '0.7', `flex source ${flex.kind} ${flex.version}`);
		const fs = flex.source();
		check(!fs.needsAuth, 'TRACERS L2 source asks for a login');
		const freq = fs.request(undefined, {time: '2025-10-01T12'});
		check(freq.url.startsWith('https://space.physics.uiowa.edu/das/stream/source/'
			+ 'tracers/tracers-1/l2/msc_bac/flex?'), `request url ${freq.url}`);
		check(freq.url.includes('read.time.min=2025-10-01T12%3A00%3A00'), `time not in ${freq.url}`);
		log(`INFO: catalog: request ${freq.url} (${freq.mime || 'no mime'})`);
		const cdf = fs.request(1);
		check(cdf.mime === 'application/x-cdf', `CDF example mime '${cdf.mime}'`);
		fs.free();
	}

	/* One view object per node, and identical walks in flight share a load */
	const [das2, das2b] = await Promise.all([coll.child('das2'), coll.child('das2')]);
	check(das2 === das2b, 'concurrent walks to one child gave two objects');
	check(das2 === await site.child(`${VGR}/das2`), 'walk from the site gave another object');
	check(das2.isSource && das2.version === '0.6', `das2 source ${das2.kind} ${das2.version}`);

	/* The source: examples and request URLs */
	const src = das2.source();
	check(!src.needsAuth, 'Voyager source asks for a login');
	check(src.authRealm === '', `Voyager realm '${src.authRealm}'`);

	/* loadSource, on das2C's own Juno 0.6 test node: one that names its realm */
	{
		const JUNO = 'https://fixture.invalid/juno_survey_0.6.json';
		const fx = (url, init) => fetch(url.replace('https://fixture.invalid/', '../das2C/test/das_fetch/'), init);
		const js = await d.loadSource(JUNO, {fetch: fx});
		check(js.needsAuth && js.authRealm === 'Juno Magnetospheric Working Group',
			`Juno login ${js.needsAuth}, realm '${js.authRealm}'`);
		js.free();

		await expectThrow(d.loadSource(`https://das2.org/catalog/das/site/${VGR}.json`,
			{fetch: fixtureFetch}), /Collection node, not a data source/, 'loadSource on a container');

		/* A source is still refused as a catalog seed */
		const seeded = d.newCatalog({seed: JUNO, fetch: fx});
		await expectThrow(seeded.open(), /not a container; see DasRuntime.loadSource/, 'source as a seed');
		seeded.free();
	}
	check(src.examples.length > 0, 'das2 has no examples');
	const req = src.request(undefined, {time: '2014-08-31T12'});
	check(req.url.startsWith(VGR_DAS2), `request url ${req.url}`);
	check(req.url.includes('start_time=2014-08-31T12%3A00%3A00'), `time not in ${req.url}`);
	log(`INFO: catalog: request ${req.url} (${req.mime || 'no mime'})`);
	let threw = false;
	try{ src.request(undefined, {'no.such.key': '1'}); }
	catch(e){ threw = (e instanceof DasError); }
	check(threw, 'unknown key accepted');
	src.free();

	/* A miss names how far the walk got */
	await expectThrow(site.child('uiowa/cassini'), /cassini/, 'missing branch');
	cat.free();

	/* A seed URL as an unnamed root, then the same seed given its real name */
	const UIOWA = 'https://das2.org/catalog/das/site/uiowa.json';
	const anon = d.newCatalog({seed: UIOWA, fetch: fixtureFetch});
	const v1 = await anon.resolve('voyager/1');
	check((await anon.open()).uri === null, 'unnamed seed has a uri');
	check(v1.uri === 'voyager/1', `path below an unnamed seed: ${v1.uri}`);
	anon.free();

	const named = d.newCatalog({seed: UIOWA, seedUri: `${SITE}:/uiowa`, fetch: fixtureFetch});
	const v1n = await named.resolve('voyager/1');
	check(v1n.uri === `${SITE}:/uiowa/voyager/1`, `named seed child: ${v1n.uri}`);
	named.free();

	/* Mirror fallback: the first URL of each child is dead */
	const fb = d.newCatalog({seed: 'https://local/fallback.json', fetch: fixtureFetch});
	const vg = await fb.resolve('voyager');
	check(vg.children.length === 2, 'second mirror not used');
	await expectThrow(fb.resolve('gone'), /gone/, 'every mirror dead');
	fb.free();

	/* A server that never answers */
	const hang = d.newCatalog({seed: 'https://hang.invalid/x.json', fetch: fixtureFetch, timeout: 300});
	await expectThrow(hang.open(), /no answer/, 'silent server');
	hang.free();
}

/* Login, against /auth/ on the runner: the das2C mount behind Basic auth,
 * reached under the other loopback name so it is a second origin and the
 * preflight runs.  See run.mjs. */
async function authChecks(d)
{
	/* What any correct encoder makes of tester:p<a-umlaut>ss<pi>, from
	 * Python's base64 over the UTF-8 bytes; btoa() alone would throw on the pi */
	const login = basicAuth('tester', 'p\u00e4ss\u03c0');
	check(login === 'Basic dGVzdGVyOnDDpHNzz4A=', `basicAuth gave ${login}`);
	let threw = false;
	try{ basicAuth('a:b', 'c'); }
	catch(e){ threw = (e instanceof DasError); }
	check(threw, "basicAuth took a user name with ':'");

	/* The /auth/ server is the node runner's; elsewhere only the encoding
	 * is checked */
	if(!RUNNER){
		log('INFO: login: no test runner here, exchange not tried');
		return d;
	}

	const host = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
	const url = `http://${host}:${location.port}/auth/examples/ex17_vector_noframe.d3b`;

	const tries = [[null, 'no login'], [basicAuth('tester', 'wrong'), 'wrong password']];
	for(const [hdr, what] of tries){
		try{
			const strm = await d.fetchStream(url, hdr ? {headers: {Authorization: hdr}} : {});
			strm.free();
			check(false, `${what}: no 401`);
		}
		catch(e){
			check(e instanceof DasError && e.status === 401, `${what}: ${e.name} status ${e.status}: ${e.message}`);
			check(e.realm === 'das2js test', `${what}: realm ${e.realm}`);
		}
	}

	const strm = await d.fetchStream(url, {headers: {Authorization: login}});
	check(strm.length > 0, 'logged in, but no datasets');
	log(`INFO: login: 401s with realm from ${host}, then ${strm.length} dataset(s) with the password`);
	strm.free();
	return d;
}

main()
	.then(authChecks)
	.then(catalogChecks)
	.catch(e => check(false, `uncaught: ${e.message}\n${e.stack || ''}`))
	.then(done);
