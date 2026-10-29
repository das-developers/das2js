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
 *     are the parser alone, and several runs show the spread.  Each one is
 *     followed by a parse+paint run over the same bytes with the painter
 *     attached, whose painting time is split out, so parse ms and MB/s
 *     always mean the parser alone.
 *
 * The box under the table pulls out the headline: parser and painter
 * speeds next to what the network managed.  On a big stream the wall time
 * is all network, and the box is where the library's own speed shows.
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
 * show in the terminal running make server.
 *
 * The black box is the streaming run's data, painted as it arrives by the
 * C renderer (src/render.h) riding on the reader.  It needs the time range
 * the request asked for: the presets carry theirs, any other URL is
 * searched for the usual das server time parameters.  The parse+paint
 * runs repaint the same picture off screen; only their timing is shown. */

import {load, DasError} from '../build/das2js.mjs';

const form = document.getElementById('form');
const urlBox = document.getElementById('url');
const repsBox = document.getElementById('reps');
const status = document.getElementById('status');
const datasetsLine = document.getElementById('datasets');
const table = document.getElementById('results');
const tbody = table.querySelector('tbody');
const errBox = document.getElementById('err');
const summary = document.getElementById('summary');

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
		x: ['2018-10-02T11:00', '2018-10-04T11:00'],
	},
	hammer: {
		url: 'https://space.physics.uiowa.edu/das/stream/source/juno/wav/burst_waveforms/flex'
			+ '?read.time.min=2021-07-21&read.time.max=2021-07-22',
		reps: 1,
		bytes: 505305959,
		x: ['2021-07-21', '2021-07-22'],
	},
};

const REPARSE_CHUNK = 65536;

/* The node runner (make server, headless tests) listens on 127.0.0.1 only,
 * so any other host is a plain web server with no /log or /done.  Skip the
 * POSTs there rather than leave a 404 in its access log per line. */
const RUNNER = location.hostname === '127.0.0.1';

function report(line, pass)
{
	if(!RUNNER) return;
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

/* The painting.  Until the catalog tools can say what a request covers,
 * the time range comes from the preset, else from the query string: das2
 * servers take start_time/end_time, dasFlex read.time.min/max.  null means
 * no range is known and nothing is painted. */
const canvas = document.getElementById('paint');
const paintNote = document.getElementById('paintNote');

function timeRange(url, preset)
{
	if(preset) return preset.x;
	let q;
	try{ q = new URL(url).searchParams; }
	catch(e){ return null; }
	for(const [a, b] of [['read.time.min', 'read.time.max'], ['start_time', 'end_time']])
		if(q.has(a) && q.has(b)) return [q.get(a), q.get(b)];
	return null;
}

/* Size the drawing buffer to the canvas's on-screen width in device
 * pixels, so a big monitor gets more detail rather than a stretched
 * picture.  The 800:232 shape matches the data area of the desktop tools.
 * Capped because paint cost per frame grows with the pixel count. */
function sizeCanvas()
{
	canvas.hidden = false;
	const w = Math.min(2400, Math.max(400, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1))));
	canvas.width = w;
	canvas.height = Math.round(w * 232 / 800);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/* "44.8 Hz to 41 MHz, log" style text for one axis of the renderer */
function axisText(a)
{
	if(Number.isNaN(a.min)) return '?';
	const f = v => Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(2) : v.toPrecision(3);
	return `${f(a.min)} to ${f(a.max)} ${a.units}${a.log ? ', log' : ''}`;
}

function describeRender(ren)
{
	let s = ren.kind;
	if(ren.kind === 'spectrogram')
		s += `: vertical ${axisText(ren.axis(false))}; color ${axisText(ren.axis(true))}`;
	else if(ren.kind === 'density')
		s += `: vertical ${axisText(ren.axis(false))}; color is log(samples per pixel)`;
	s += `; ${ren.rescales} rescale(s)`;
	if(ren.skipped) s += `; ${ren.skipped} dataset(s) skipped`;
	if(ren.note) s += `; ${ren.note}`;
	return s;
}

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

async function streamingRun(url, xRange)
{
	const t0 = performance.now();
	const resp = await fetch(url, {cache: 'no-store'});
	if(!resp.ok)
		throw new DasError(`HTTP ${resp.status} ${resp.statusText}`);

	const rdr = d.newReader();
	const chunks = [];
	let bytes = 0, firstHeader = null, firstRecord = null, firstPixel = null;

	/* The renderer must be attached before the first feed so it sees the
	 * dataset headers.  Its frames ride the bar's 15 Hz throttle: painting
	 * happens inside feed() anyway, a frame only copies pixels out. */
	let ren = null, ctx = null, lastFrame = 0;
	if(xRange){
		sizeCanvas();
		ctx = canvas.getContext('2d');
		ren = d.newRender(canvas.width, canvas.height);
		ren.setX(xRange[0], xRange[1]);
		ren.attach(rdr);
	}
	const frame = (force) => {
		if(ren === null) return;
		const now = performance.now();
		if(!force && now - lastFrame < BAR_MS) return;
		lastFrame = now;
		if(!ren.dirty) return;
		ctx.putImageData(ren.imageData(), 0, 0);
		if(firstPixel === null) firstPixel = now - t0;
		paintNote.textContent = describeRender(ren);
	};

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
			frame(false);
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
	catch(e){ rdr.free(); if(ren) ren.free(); throw e; }
	const wall = performance.now() - t0;
	barUpdate(bytes, true);
	frame(true);
	const strm = rdr.take();

	/* Reader first: it holds a pointer to the renderer */
	rdr.free();
	let paintMs = null, values = null;
	if(ren){
		paintMs = ren.paintMs;
		values = ren.values;
		paintNote.textContent = describeRender(ren);
		ren.free();
	}
	else{
		canvas.hidden = true;
		paintNote.textContent = 'No time range known for this URL, nothing painted.';
	}

	/* one contiguous copy for the re-parse runs */
	const all = new Uint8Array(bytes);
	let off = 0;
	for(const c of chunks){ all.set(c, off); off += c.length; }

	return {strm, all, bytes, chunks: chunks.length, wall, firstHeader, firstRecord, firstPixel, paintMs, values};
}

/* One pass over the bytes in memory.  With xRange a renderer of the
 * canvas's size rides along, as in the streaming run, and its painting time
 * is reported separately from the total. */
function reparseRun(all, xRange)
{
	let ren = null;
	const rdr = d.newReader();
	try{
		if(xRange){
			ren = d.newRender(canvas.width, canvas.height);
			ren.setX(xRange[0], xRange[1]);
			ren.attach(rdr);
		}
		const t0 = performance.now();
		for(let i = 0; i < all.length; i += REPARSE_CHUNK)
			rdr.feed(all.subarray(i, i + REPARSE_CHUNK));
		rdr.end();
		const ms = performance.now() - t0;
		const strm = rdr.stream;
		const records = recordCount(strm);
		const view = viewAll(strm);
		const paintMs = ren ? ren.paintMs : null;
		const values = ren ? ren.values : null;
		return {ms, records, view, paintMs, values};
	}
	finally{
		rdr.free();   /* reader first, it points at the renderer */
		if(ren) ren.free();
	}
}

/* The headline box.  Rates use the table's MB (2^20 bytes).  "Best" is the
 * fastest run: slower ones carry garbage collection and other tabs, not
 * the library. */
function fmtRate(n)
{
	return n >= 1e9 ? (n / 1e9).toFixed(2) + ' G ' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' M '
		: n >= 1e3 ? (n / 1e3).toFixed(1) + ' k ' : n.toFixed(0) + ' ';
}

function showSummary(r, parses, paints)
{
	const MB = r.bytes / 1048576;
	const lines = [];
	const add = (label, value, note) => lines.push([label, value, note || '']);

	add('Network', `${(MB / (r.wall / 1000)).toFixed(1)} MB/s`,
		`${MB.toFixed(1)} MB in ${(r.wall / 1000).toFixed(1)} s, parsed and painted on arrival`);

	if(parses.length){
		const best = parses.reduce((a, b) => a.ms < b.ms ? a : b);
		add('Parser', `${(MB / (best.ms / 1000)).toFixed(1)} MB/s`,
			`${fmtRate(best.records / (best.ms / 1000))}records/s, best of ${parses.length}`);
	}

	/* The painter's rate from the best parse+paint run, else from the
	 * streaming run, whose painting happened between network chunks */
	const src = paints.length ? paints.reduce((a, b) => a.ms < b.ms ? a : b) : null;
	const pMs = src ? src.paintMs : r.paintMs, pVals = src ? src.values : r.values;
	if(pMs !== null && pMs > 0)
		add('Painter', `${fmtRate(pVals / (pMs / 1000))}values/s`,
			`${fmtRate(pVals)}values in ${pMs.toFixed(0)} ms${src ? ', best of ' + paints.length : ', while streaming'}`);

	if(src){
		const x = r.wall / src.ms;
		add('Parse + paint', `${(MB / (src.ms / 1000)).toFixed(1)} MB/s`,
			`the whole stream from memory in ${(src.ms / 1000).toFixed(2)} s: `
			+ `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}x faster than the network delivered it`);
	}

	const dl = document.createElement('dl');
	for(const [label, value, note] of lines){
		const dt = document.createElement('dt');
		dt.textContent = label;
		const dd = document.createElement('dd');
		const b = document.createElement('strong');
		b.textContent = value;
		const span = document.createElement('span');
		span.textContent = note;
		dd.append(b, span);
		dl.append(dt, dd);
	}
	summary.replaceChildren(dl);
	summary.hidden = false;
	report('INFO: perf summary: ' + lines.map(l => `${l[0]} ${l[1]} (${l[2]})`).join('; '));
}

/* Bring the box and the end of the table into view.  block 'end' lines the
 * box's bottom up with the bottom of the window, so the last table rows
 * sit just above it.  Smooth unless the user asked for less motion. */
function scrollToResults()
{
	const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	summary.scrollIntoView({behavior: calm ? 'auto' : 'smooth', block: 'end'});
}

async function run(url, reps, verdict, expected, xRange)
{
	errBox.textContent = '';
	paintNote.textContent = '';
	summary.hidden = true;
	tbody.replaceChildren();
	table.classList.remove('finished');
	datasetsLine.textContent = '';
	status.textContent = 'streaming...';
	barBegin(expected);
	try{
		const r = await streamingRun(url, xRange);
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
			r.firstPixel === null ? '' : r.firstPixel.toFixed(0),
			r.paintMs === null ? '' : r.paintMs.toFixed(0),
			'', '', records, '', view.ms.toFixed(2), heapMB()]);
		r.strm.free();

		/* Parse alone, then parse and paint, per rep.  In the parse+paint
		 * row wall ms is the total and parse ms is the total less painting,
		 * so the MB/s column stays the parser's rate in every row. */
		const parses = [], paints = [];
		const nChunks = Math.ceil(r.bytes / REPARSE_CHUNK);
		for(let i = 1; i <= reps; ++i){
			/* let the page paint between runs */
			await new Promise(res => setTimeout(res, 0));
			const p = reparseRun(r.all, null);
			parses.push(p);
			const mbs = (r.bytes / 1048576) / (p.ms / 1000);
			row([`re-parse ${i}`, r.bytes, nChunks, '', '', '', '', '',
				p.ms.toFixed(0), mbs.toFixed(1), p.records, (p.records / (p.ms / 1000)).toFixed(0),
				p.view.ms.toFixed(2), heapMB()]);
			status.textContent = `re-parse ${i} of ${reps} done`;

			if(!xRange) continue;
			await new Promise(res => setTimeout(res, 0));
			const q = reparseRun(r.all, xRange);
			paints.push(q);
			const parseMs = q.ms - q.paintMs;
			row([`parse+paint ${i}`, r.bytes, nChunks, q.ms.toFixed(0), '', '', '', q.paintMs.toFixed(0),
				parseMs.toFixed(0), ((r.bytes / 1048576) / (parseMs / 1000)).toFixed(1),
				q.records, (q.records / (parseMs / 1000)).toFixed(0), q.view.ms.toFixed(2), heapMB()]);
			status.textContent = `parse+paint ${i} of ${reps} done`;
		}
		showSummary(r, parses, paints);
		status.textContent = `done: ${r.bytes} bytes, ${records} records, wall ${r.wall.toFixed(0)} ms`;
		/* Lights up the parse ms column, see Perf.html; only a run that got
		 * this far earns it, a failure leaves the table plain */
		table.classList.add('finished');
		scrollToResults();
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
	try{ await run(url, Number(repsBox.value), true, preset ? preset.bytes : null, timeRange(url, preset)); }
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
