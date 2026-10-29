/* Live check against a public dasFlex server: the first time the module
 * meets a real network response rather than a fixture served by the test
 * runner.  What this adds over TestModule: cross-origin fetch under CORS,
 * chunk sizes chosen by the network stack, a server-side error response
 * with its in-band exception message, and a das2 stream big enough to see
 * mid-download growth.
 *
 * Not part of `make headless_test` since it needs a server: `make
 * live_test` for the public one over the network, `make local_test` for the
 * dasFlex checkout next door through the CGI shim. */

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
	if(!cond){ failed = true; log('ERROR: ' + msg); }
	return cond;
}

async function done()
{
	log(failed ? 'ERROR: live test FAILED' : 'INFO: All live checks passed');
	try{
		await queue;   /* every log line first, then the verdict */
		await fetch('/done', {method: 'POST', body: JSON.stringify({pass: !failed})});
	}
	catch(e){}
}

/* Which server: the page URL's ?server= picks one.
 *
 * iowa (default): Juno Waves survey spectra on space.physics.uiowa.edu.  The
 *   source says data older than six months are anonymous and the server
 *   sends Access-Control-Allow-Origin: *, so this works from any origin.
 *   Two hours at 86.4 s bins is about 54 KB.
 * local: the dasFlex checkout next door through test/dasflex_cgi.py, whose
 *   port the runner passes as ?port=.  Its Examples/Spectra source is the
 *   Voyager 1 PWS fixture; one minute at 10 s bins is about 23 KB.
 *
 * In both cases BAD asks the das2_bin_avgsec pipeline for das3 output,
 * which dasFlex refuses with HTTP 400 plus an exception packet. */
const params = new URLSearchParams(location.search);
const SERVERS = {
	iowa: {
		src: 'https://space.physics.uiowa.edu/das/stream/source/juno/wav/survey/flex',
		query: '?read.time.min=2018-10-02T11:00&read.time.max=2018-10-02T13:00&bin.time.max=86.4',
		minRecs: 10, year: [1.8e9, 2.0e9],   /* 2018 in seconds since 1958 */
	},
	local: {
		src: `http://127.0.0.1:${params.get('port')}/das/server/source/examples/spectra/flex`,
		query: '?read.time.min=1979-03-01T12:26:11&read.time.max=1979-03-01T12:27:00&bin.time.max=10',
		minRecs: 3, year: [6.6e8, 7.0e8],    /* 1979 */
	},
};
const which = params.get('server') || 'iowa';
const SRV = SERVERS[which];
const GOOD = SRV.src + SRV.query;
const BAD = GOOD + '&format.version=3';

async function main()
{
	const d = await load({progName: 'TestLive'});
	log(`INFO: server '${which}': ${SRV.src}`);

	let nChunks = 0, nBytes = 0, grew = false, lastRecs = 0;
	const t0 = performance.now();
	const strm = await d.fetchStream(GOOD, {onChunk: (rdr, n) => {
		++nChunks; nBytes = n;
		const s = rdr.stream;
		if(s && s.length > 0){
			const recs = s.dataset(0).shape[0];
			if(recs > lastRecs && lastRecs > 0) grew = true;
			lastRecs = recs;
		}
	}});
	const ms = performance.now() - t0;
	log(`INFO: ${nBytes} bytes in ${nChunks} chunks, ${ms.toFixed(0)} ms including network`);

	check(strm.length > 0, 'live stream has no datasets');
	for(const ds of strm.datasets()){
		const shape = ds.shape;
		log(`INFO: dataset ${ds.name} shape [${shape}] coords ${ds.coords.map(c => c.name)} data ${ds.data.map(c => c.name)}`);
		check(shape[0] >= SRV.minRecs, `${ds.name}: too few records (${shape[0]}) for the span`);

		/* A das2 spectrogram up-converted to das3: time and frequency
		 * coordinates, one data dimension, all numeric.  Note the id: das2
		 * up-conversion names the x axis 'Time', native das3 streams say
		 * 'time'; a tolerant lookup is what a UI needs too. */
		const time = ds.coords.find(c => c.name.toLowerCase() === 'time');
		check(time !== undefined, `${ds.name}: no time coordinate`);
		if(time){
			const t = time.var('center').values({shapeFrom: ds.shapeDonor(time.var('center'))});
			check(t.length === shape[0], `${ds.name}: time count ${t.length} != records ${shape[0]}`);
			/* das2 text streams carry das_time, converted here to seconds since
			 * 1958; the expected year is a property of the chosen server */
			check(t[0] > SRV.year[0] && t[0] < SRV.year[1], `${ds.name}: first time ${t[0]} outside expected year`);
			check(t[t.length - 1] > t[0], `${ds.name}: time not increasing`);
		}
		for(const dim of ds.data){
			const v = dim.var('center');
			const vals = v.values({shapeFrom: ds.shapeDonor(v)});
			check(vals.length > 0, `${ds.name}/${dim.name}: no values`);
			log(`INFO: ${ds.name}/${dim.name} ${v.storage}[${vals.length}] units '${v.units}' first ${vals[0]}`);
		}
	}
	/* Growth between chunks depends on how the network stack slices the
	 * body; a local server may deliver 23 KB in one piece.  TestModule
	 * checks progressive growth deterministically, so here it is reported,
	 * not required. */
	log(grew ? 'INFO: record count grew between chunks' : 'INFO: body arrived in too few chunks to observe growth');
	strm.free();

	/* Server-side rejection must surface as a DasError carrying the
	 * server's own exception text, which is what a UI shows the user.  The
	 * text only reaches a cross-origin page if the server puts CORS headers
	 * on its error replies too; dasFlex does since 2026-10-20 (Iowa deployed
	 * the same day).  Older servers without them make the browser hide the
	 * body, so the missing text is reported as a WARNING, not failed on. */
	log('INFO: now a deliberately bad request (format.version=3 on a das2-only source)');
	let threw = false;
	try{ await d.fetchStream(BAD); }
	catch(e){
		threw = true;
		check(e instanceof DasError, 'rejection was not a DasError');
		log(`INFO: rejection message: ${e.message}`);
		if(e.exception) log(`INFO: server exception text: ${e.exception}`);
		else log('WARNING: no exception text reached the page (CORS headers missing on the error reply?)');
	}
	check(threw, 'bad request did not throw');
}

main().catch(e => check(false, `uncaught: ${e.message}\n${e.stack || ''}`)).then(done);
