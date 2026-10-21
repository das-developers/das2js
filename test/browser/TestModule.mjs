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

function walkStream(d, strm, name)
{
	const nDs = strm.length;
	if(!check(nDs > 0, `${name}: stream has no datasets`)) return;

	for(const ds of strm.datasets()){
		check(ds.id !== '', `${name}: dataset without an id`);
		const shape = ds.shape;
		check(shape.length >= 1, `${name}: dataset with no bulk indices`);
		check(shape[0] >= 0, `${name}: negative record count`);
		const empty = (shape[0] === 0);
		if(empty) log(`INFO: ${name}: dataset '${ds.id}' has a header but no records`);

		const dims = ds.coords.concat(ds.data);
		check(dims.length > 0, `${name}: dataset with no dimensions`);

		for(const dim of dims){
			check(dim.id !== '', `${name}: dimension without an id`);
			const vars = dim.vars;
			check(vars.size > 0, `${name}: dimension ${dim.id} has no variables`);

			for(const [role, v] of vars){
				const tag = `${name} ${ds.id}/${dim.id}:${role}`;
				check(role !== '', `${tag}: empty role`);
				check(v.valType !== '', `${tag}: no value type`);

				for(const ext of v.shape(ds.rank))
					check(ext >= 0 || ext === d.RAGGED || ext === d.BORROW || ext === d.UNUSED,
						`${tag}: shape entry ${ext} out of contract`);

				/* ubyte* (opaque blobs) is the one type values() refuses */
				if(v.valType === 'ubyte*') continue;

				const donor = ds.shapeDonor(v);
				if(empty){
					/* values() must answer with an empty container, not throw,
					 * for anything that varies along records.  A variable that
					 * does not (a das2 frequency table, UNUSED along index 0)
					 * is fully present with zero records; that is correct. */
					if(v.isArrayBacked && v.shape(ds.rank)[0] !== d.UNUSED)
						check(v.values().length === 0, `${tag}: empty dataset gave values`);
					continue;
				}
				const vals = v.values({shapeFrom: donor});
				check(vals.length > 0, `${tag}: no values`);

				if(v.valType === 'char*'){
					check(Array.isArray(vals), `${tag}: text did not come back as an Array`);
					/* nested to the variable's shape: descend to the first leaf */
					let leaf = vals;
					while(Array.isArray(leaf)) leaf = leaf[0];
					check(typeof leaf === 'string' && leaf.length > 0, `${tag}: first string missing`);
				}
				else if(v.valType === 'das_time'){
					check(vals instanceof Float64Array, `${tag}: das_time not Float64Array`);
					/* seconds since 1958: 0 (1958) to ~4.5e9 (2100) */
					check(vals[0] > 0 && vals[0] < 4.5e9, `${tag}: time ${vals[0]} implausible`);
				}
				else{
					check(ArrayBuffer.isView(vals), `${tag}: numeric values not a TypedArray`);

					/* The zero-copy promise: for array-backed variables the view
					 * must sit inside the wasm heap, not in a fresh buffer */
					if(v.isArrayBacked)
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
					if(v.isArrayBacked){
						const nRecs = v.lengthAt([]);
						check(nRecs === v.arrayShape[0], `${tag}: lengthAt([]) is not the record count`);
						let total = 0;
						for(let i = 0; i < nRecs; ++i){
							const rec = v.valuesAt([i]);
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

		const props = strm.props;
		for(const [k, v] of props)
			check(k !== '' && typeof v.value === 'string' && v.type !== '',
				`${url}: property ${k} has empty parts`);
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
