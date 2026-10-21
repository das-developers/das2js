/* The structure inspector: fetch a das stream and print its JSON form.
 *
 * Answers "if I point at this data source, what do I have to work with?"
 * The whole page is JSON.stringify(stream, null, 2); every handle class in
 * das2js.mjs has a toJSON() that returns its structure as plain data, so
 * nothing here knows the dataset model.  The URL comes from the form or
 * from ?url=... so a stream can be bookmarked. */

import {load, DasError} from '/build/das2js.mjs';

const out = document.getElementById('out');
const status = document.getElementById('status');
const urlBox = document.getElementById('url');

const DEFAULT_URL = '/das2C/examples/ex17_vector_noframe.d3b';

/* Anonymous for data older than six months, so a bookmarkable live example */
const EXAMPLE_LIVE = 'https://space.physics.uiowa.edu/das/stream?server=dataset'
	+ '&dataset=Juno/WAV/Survey&start_time=2017-01-01T13:00&end_time=2017-01-01T14:00';

/* When the node runner is driving (make inspect, or a headless check), the
 * first load's verdict is posted back like the test pages do; with a plain
 * static server the POSTs fail quietly. */
function report(line, pass)
{
	fetch('/log', {method: 'POST', body: line}).catch(() => {});
	if(pass !== undefined)
		fetch('/done', {method: 'POST', body: JSON.stringify({pass})}).catch(() => {});
}

const d = await load({progName: 'inspect'});

async function inspect(url, verdict = false)
{
	out.textContent = '';
	out.className = '';
	status.textContent = 'fetching...';
	const t0 = performance.now();
	let bytes = 0;
	try{
		/* onChunk fires after each network chunk is parsed; the stream is
		 * already walkable there, which is how a progress meter works.  Here
		 * it just keeps the byte count moving. */
		const strm = await d.fetchStream(url, {
			onChunk: (rdr, n) => { bytes = n; status.textContent = `${n} bytes...`; }
		});
		const ms = (performance.now() - t0).toFixed(0);
		out.textContent = JSON.stringify(strm, null, 2);
		const recs = Array.from(strm.datasets(), ds => `${ds.name}: ${ds.shape[0]}`).join(', ');
		status.textContent = `${bytes} bytes, ${strm.length} dataset(s) in ${ms} ms.  Records: ${recs}`;
		if(verdict) report(`INFO: inspector printed ${strm.length} dataset(s) from ${url}`, true);
		strm.free();
	}
	catch(e){
		out.className = 'err';
		status.textContent = 'failed';
		out.textContent = (e instanceof DasError)
			? `${e.message}${e.exception ? '\n\nserver said: ' + e.exception : ''}`
			: `${e.name}: ${e.message}`;
		if(verdict) report(`ERROR: inspector failed on ${url}: ${e.message}`, false);
	}
}

document.getElementById('form').addEventListener('submit', ev => {
	ev.preventDefault();
	const url = urlBox.value.trim();
	if(url === '') return;
	history.replaceState(null, '', '?url=' + encodeURIComponent(url));
	inspect(url);
});

const initial = new URLSearchParams(location.search).get('url') || DEFAULT_URL;
urlBox.value = initial;
urlBox.title = 'Try a live one: ' + EXAMPLE_LIVE;
inspect(initial, true);
