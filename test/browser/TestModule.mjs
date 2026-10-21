/* Browser-side checks of src/das2js.mjs, the JavaScript twin of
 * test/TestWasm.c.  Same fixtures, same walk, same self-consistency checks,
 * but through the ES module rather than the C functions directly, so what
 * is tested here is the marshalling, the TypedArray construction and the
 * fetch/feed loop.
 *
 * Reporting goes two ways at once: into the page (so a human loading the
 * page sees something) and to the runner over POST (so make sees the
 * result).  The runner is optional; when the page is opened from a plain
 * static server the POSTs fail quietly and the page still works. */

import {load, DasError} from '/build/das2js.mjs';

const out = document.getElementById('out');
let failed = false;

/* POSTs are chained so lines reach the runner in the order logged; fired
 * independently they race and interleave */
let queue = Promise.resolve();
function log(line)
{
	out.textContent += line + '\n';
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
	'/das2C/examples/ex17_vector_noframe.d3b',
	'/das2C/examples/ex35_strings_rank2.d3b',
	'/das2C/examples/ex01_polar_mfe.d2t',
	'/das2C/examples/ex19_cassini_ragged_wfrm.d3t',
	/* two multi-dataset das2 streams whose packet headers arrive AFTER data
	 * packets for earlier ids, the Juno/WAV/Survey shape */
	'/das2C/examples/ex08_cassini_rpws_survey.d2t',
	'/das2C/examples/ex09_juno_waves_survey.d2t',
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
		const resp = await fetch('/das2C/examples/ex08_cassini_rpws_survey.d2t');
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
		try{ await d.fetchStream('/das2C/examples/no_such_file.d3b'); }
		catch(e){ threw = (e instanceof DasError); }
		check(threw, '404 did not surface as DasError');
	}
}

main().catch(e => check(false, `uncaught: ${e.message}\n${e.stack || ''}`)).then(done);
