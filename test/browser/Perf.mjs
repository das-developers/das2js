/* Real-world performance: fetch a stream from a live server and time it.
 *
 * Two kinds of measurement, because they answer different questions:
 *
 *  1. The STREAMING run: fetch() with caching off, every network chunk fed
 *     to the parser as it arrives, exactly as DasRuntime.fetchStream() does
 *     it.  Wall time is what a user waits; "first header" and "first
 *     record" are when a progressive display could start drawing.  Network
 *     and parse are interleaved here and cannot be told apart from the
 *     browser, which only hands out time to the millisecond.
 *
 *  2. The RE-PARSE runs: the same bytes, already in memory, pushed through
 *     a fresh reader in 64 KB pieces.  No network, so parse ms and MB/s
 *     are the parser alone, and several runs show the spread.
 *
 * "view all vars" is the cost of handing every array-backed variable to a
 * caller as a TypedArray: it should be microseconds however big the data,
 * which is the zero-copy promise made good.  Heap MB is the wasm heap
 * after the run; it only grows, so repeated runs show the high-water mark.
 *
 * ?url=... bookmarks a stream and ?reps=N sets the re-parse count.  The
 * first run posts a verdict to the node
 * runner when one is driving, so this page doubles as a network test. */

import {load, DasError} from '/build/das2js.mjs';

const form = document.getElementById('form');
const urlBox = document.getElementById('url');
const repsBox = document.getElementById('reps');
const status = document.getElementById('status');
const datasetsLine = document.getElementById('datasets');
const tbody = document.querySelector('#results tbody');
const errBox = document.getElementById('err');

/* Juno Waves survey, two days at 86.4 s bins, anonymous at Iowa */
const DEFAULT_URL = 'https://space.physics.uiowa.edu/das/stream/source/juno/wav/survey/flex'
	+ '?read.time.min=2018-10-02T11%3A00&read.time.max=2018-10-04T11%3A00&bin.time.max=86.4';

const REPARSE_CHUNK = 65536;

function report(line, pass)
{
	fetch('/log', {method: 'POST', body: line}).catch(() => {});
	if(pass !== undefined)
		fetch('/done', {method: 'POST', body: JSON.stringify({pass})}).catch(() => {});
}

const d = await load({progName: 'perf'});

/* Sum of the record counts of every dataset */
function recordCount(strm)
{
	let n = 0;
	for(const ds of strm.datasets()) n += ds.shape[0];
	return n;
}

/* Ask for every array-backed variable's values and time it */
function viewAll(strm)
{
	const t0 = performance.now();
	let nVars = 0, nElems = 0;
	for(const ds of strm.datasets())
		for(const [, , v] of ds.vars()){
			if(v.source.kind !== 'array' || v.semantic === 'string' || v.semantic === 'blob') continue;
			nElems += v.values().length;
			++nVars;
		}
	return {ms: performance.now() - t0, nVars, nElems};
}

function heapMB(){ return (d._m().HEAPU8.length / 1048576).toFixed(1); }

function row(cells)
{
	/* the runner's log gets the same row, so a headless run shows numbers */
	report('INFO: perf row: ' + cells.map(c => (c === null || c === undefined) ? '-' : c).join(' '));
	const tr = document.createElement('tr');
	for(const c of cells){
		const td = document.createElement('td');
		td.textContent = (c === null || c === undefined) ? '' : String(c);
		tr.appendChild(td);
	}
	tbody.appendChild(tr);
}

async function streamingRun(url)
{
	const t0 = performance.now();
	const resp = await fetch(url, {cache: 'no-store'});
	if(!resp.ok)
		throw new DasError(`HTTP ${resp.status} ${resp.statusText}`);

	const rdr = d.newReader();
	const chunks = [];
	let bytes = 0, firstHeader = null, firstRecord = null;
	try{
		const body = resp.body.getReader();
		for(;;){
			const {done, value} = await body.read();
			if(done) break;
			chunks.push(value);
			bytes += value.length;
			rdr.feed(value);
			status.textContent = `${bytes} bytes...`;
			/* the two progressive milestones, checked cheaply per chunk */
			const s = rdr.stream;
			if(s !== null && s.length > 0){
				if(firstHeader === null) firstHeader = performance.now() - t0;
				if(firstRecord === null && s.dataset(0).shape[0] > 0)
					firstRecord = performance.now() - t0;
			}
		}
		rdr.end();
	}
	catch(e){ rdr.free(); throw e; }
	const wall = performance.now() - t0;
	const strm = rdr.take();
	rdr.free();

	/* one contiguous copy for the re-parse runs */
	const all = new Uint8Array(bytes);
	let off = 0;
	for(const c of chunks){ all.set(c, off); off += c.length; }

	return {strm, all, bytes, chunks: chunks.length, wall, firstHeader, firstRecord};
}

function reparseRun(all)
{
	const t0 = performance.now();
	const rdr = d.newReader();
	try{
		for(let i = 0; i < all.length; i += REPARSE_CHUNK)
			rdr.feed(all.subarray(i, i + REPARSE_CHUNK));
		rdr.end();
		const ms = performance.now() - t0;
		const strm = rdr.stream;
		const records = recordCount(strm);
		const view = viewAll(strm);
		return {ms, records, view};
	}
	finally{ rdr.free(); }
}

async function run(url, reps, verdict)
{
	errBox.textContent = '';
	tbody.replaceChildren();
	datasetsLine.textContent = '';
	try{
		const r = await streamingRun(url);
		const records = recordCount(r.strm);
		const view = viewAll(r.strm);
		const names = Array.from(r.strm.datasets(), ds => `${ds.name} [${ds.shape.join(',')}]`);
		datasetsLine.textContent = `${r.strm.length} dataset(s): ${names.join('; ')}; `
			+ `${view.nVars} array-backed variables, ${view.nElems} elements viewed`;
		row(['streaming', r.bytes, r.chunks, r.wall.toFixed(0),
			r.firstHeader === null ? '' : r.firstHeader.toFixed(0),
			r.firstRecord === null ? '' : r.firstRecord.toFixed(0),
			'', '', records, '', view.ms.toFixed(2), heapMB()]);
		r.strm.free();

		for(let i = 1; i <= reps; ++i){
			/* let the page paint between runs */
			await new Promise(res => setTimeout(res, 0));
			const p = reparseRun(r.all);
			const mbs = (r.bytes / 1048576) / (p.ms / 1000);
			row([`re-parse ${i}`, r.bytes, Math.ceil(r.bytes / REPARSE_CHUNK), '', '', '',
				p.ms.toFixed(0), mbs.toFixed(1), p.records, (p.records / (p.ms / 1000)).toFixed(0),
				p.view.ms.toFixed(2), heapMB()]);
			status.textContent = `re-parse ${i} of ${reps} done`;
		}
		status.textContent = `done: ${r.bytes} bytes, ${records} records, wall ${r.wall.toFixed(0)} ms`;
		if(verdict) report(`INFO: perf: ${r.bytes} bytes, ${records} records in ${r.wall.toFixed(0)} ms wall from ${url}`, true);
	}
	catch(e){
		status.textContent = 'failed';
		errBox.textContent = (e instanceof DasError)
			? `${e.message}${e.exception ? '\nserver said: ' + e.exception : ''}`
			: `${e.name}: ${e.message}`;
		if(verdict) report(`ERROR: perf failed on ${url}: ${e.message}`, false);
	}
}

form.addEventListener('submit', ev => {
	ev.preventDefault();
	const url = urlBox.value.trim();
	if(url === '') return;
	history.replaceState(null, '', '?url=' + encodeURIComponent(url));
	run(url, Number(repsBox.value), false);
});

const params = new URLSearchParams(location.search);
const initial = params.get('url') || DEFAULT_URL;
if(params.has('reps')) repsBox.value = params.get('reps');
urlBox.value = initial;
run(initial, Number(repsBox.value), true);
