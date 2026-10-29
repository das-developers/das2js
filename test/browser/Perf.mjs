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
 * Nothing runs until a button is pressed: the two presets, or Run for the
 * stream in the URL box.  All three are disabled while a run is going, so
 * runs never overlap.  ?url=... and ?reps=N fill in the form.
 *
 * Each run's rows and verdict are also posted to the node runner, so they
 * show in the terminal running make server. */

import {load, DasError} from '/build/das2js.mjs';

const form = document.getElementById('form');
const urlBox = document.getElementById('url');
const repsBox = document.getElementById('reps');
const status = document.getElementById('status');
const datasetsLine = document.getElementById('datasets');
const table = document.getElementById('results');
const tbody = table.querySelector('tbody');
const errBox = document.getElementById('err');

/* The two preset buttons.  Both sources are anonymous at Iowa.
 *
 * quick: Juno Waves survey for Perijove 16 at display resolution (1 minute
 *   averages), about 1.75 MB of das2 stream: float values, text times.
 *   From the das2py-server at jupiter.physics.uiowa.edu, whose stream cache
 *   answers in well under a second.
 * hammer: Juno Waves burst waveforms for 2021-07-21, about 505 MB of das3
 *   binary floats, so one re-parse is plenty.  It leaves about 1.5 GB of
 *   the 2 GB wasm heap in use. */
const PRESETS = {
	quick: {
		url: 'https://jupiter.physics.uiowa.edu/das/server?server=dataset&dataset=Juno/WAV/Survey'
			+ '&start_time=2018-10-02T11:00&end_time=2018-10-04T11:00&resolution=60',
		reps: 3,
		bytes: 1754139,
	},
	hammer: {
		url: 'https://space.physics.uiowa.edu/das/stream/source/juno/wav/burst_waveforms/flex'
			+ '?read.time.min=2021-07-21&read.time.max=2021-07-22',
		reps: 1,
		bytes: 505305959,
	},
};

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

/* The progress bar under the status line.  It goes by bytes, not stream
 * time, using the presets' known sizes.  das servers can't send a
 * Content-Length (how much they send depends on the data), so any other URL
 * gets a bar that sweeps back and forth while the byte count climbs.
 *
 * The bar's label has the percentage and rate.  Megabytes here are 10^6
 * bytes, to match the "505 MB" on the buttons.
 *
 * The bar is redrawn at most 15 times a second: a CSS transition of the
 * same length glides it between redraws.  The moving stripes are CSS
 * animation, see Perf.html.  The byte counter on the status line is not
 * throttled, see streamingRun(). */
const BAR_MS = 66;
const bar = document.getElementById('progress');
const fill = bar.querySelector('.fill');
const label = bar.querySelector('.label');
let barExpected = null;
let barT0 = 0;
let barDrawn = 0;

function barBegin(expected)
{
	barExpected = expected;
	barT0 = performance.now();
	barDrawn = 0;
	bar.hidden = false;
	bar.className = 'progress' + (expected ? '' : ' unknown');
	fill.style.width = expected ? '0%' : '';
	label.textContent = 'waiting for the server...';
}

function barUpdate(bytes, force)
{
	const now = performance.now();
	if(!force && now - barDrawn < BAR_MS) return;
	barDrawn = now;

	const rate = (bytes / 1e6) / Math.max(0.001, (now - barT0) / 1000);
	if(barExpected){
		/* Math.min: a stream that grew since the size was noted stops at full */
		const pct = Math.min(100, 100 * bytes / barExpected);
		fill.style.width = pct.toFixed(1) + '%';
		label.textContent = `${pct.toFixed(0)}%, ${rate.toFixed(1)} MB/s`;
	}
	else
		label.textContent = `${rate.toFixed(1)} MB/s`;
}

function barEnd(ok, note)
{
	bar.className = 'progress ' + (ok ? 'complete' : 'failed');
	if(ok) fill.style.width = '100%';
	if(note) label.textContent = note;
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
			/* Every chunk, as fast as they come.  Setting text only stores a
			 * string; the browser draws at most once per screen refresh, so
			 * the counter shows a new number on every frame and the low
			 * digits blur.  The bar throttles itself. */
			status.textContent = `${bytes} bytes...`;
			barUpdate(bytes, false);
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
	barUpdate(bytes, true);
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

async function run(url, reps, verdict, expected)
{
	errBox.textContent = '';
	tbody.replaceChildren();
	table.classList.remove('finished');
	datasetsLine.textContent = '';
	status.textContent = 'streaming...';
	barBegin(expected);
	try{
		const r = await streamingRun(url);
		barEnd(true, `${(r.bytes / 1e6).toFixed(1)} MB in ${(r.wall / 1000).toFixed(1)} s, `
			+ `${(r.bytes / 1e6 / (r.wall / 1000)).toFixed(1)} MB/s`);
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
		/* Lights up the parse ms column, see Perf.html; only a run that got
		 * this far earns it, a failure leaves the table plain */
		table.classList.add('finished');
		if(verdict) report(`INFO: perf: ${r.bytes} bytes, ${records} records in ${r.wall.toFixed(0)} ms wall from ${url}`, true);
	}
	catch(e){
		status.textContent = 'failed';
		barEnd(false, 'failed');
		errBox.textContent = (e instanceof DasError)
			? `${e.message}${e.exception ? '\nserver said: ' + e.exception : ''}`
			: `${e.name}: ${e.message}`;
		if(verdict) report(`ERROR: perf failed on ${url}: ${e.message}`, false);
	}
}

/* Every control that starts a run, so they can all be switched off at once */
const starters = [
	document.getElementById('quick'),
	document.getElementById('hammer'),
	form.querySelector('button[type=submit]'),
];

/* Runs the stream in the form.  The buttons stay disabled until run()
 * settles, whether it succeeded or threw; "finally" covers both. */
async function start()
{
	const url = urlBox.value.trim();
	if(url === '') return;
	history.replaceState(null, '', '?url=' + encodeURIComponent(url));
	for(const b of starters) b.disabled = true;
	/* A preset's size drives the bar; any other URL gets the sweeping one */
	const preset = Object.values(PRESETS).find(p => p.url === url);
	try{ await run(url, Number(repsBox.value), true, preset ? preset.bytes : null); }
	finally{ for(const b of starters) b.disabled = false; }
}

form.addEventListener('submit', ev => {
	ev.preventDefault();   /* a submit would otherwise reload the page */
	start();
});

for(const name of ['quick', 'hammer']){
	document.getElementById(name).addEventListener('click', () => {
		urlBox.value = PRESETS[name].url;
		repsBox.value = PRESETS[name].reps;
		start();
	});
}

const params = new URLSearchParams(location.search);
urlBox.value = params.get('url') || PRESETS.quick.url;
if(params.has('reps')) repsBox.value = params.get('reps');
status.textContent = 'Pick a test, or enter a stream URL and press Run.';
