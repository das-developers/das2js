/* The structure inspector: fetch a das stream and print its JSON form.
 *
 * Answers "if I point at this data source, what do I have to work with?"
 * The whole page is JSON.stringify(stream, null, 2); every handle class in
 * das2js.mjs has a toJSON() that returns its structure as plain data, so
 * nothing here knows the dataset model.  The URL comes from the form or
 * from ?url=... so a stream can be bookmarked.
 *
 * A 401 brings up a login form, and the fetch is retried with an
 * Authorization header; see "Logins" below. */

import {load, DasError, basicAuth} from '../build/das2js.mjs';

const out = document.getElementById('out');
const status = document.getElementById('status');
const urlBox = document.getElementById('url');
const loginForm = document.getElementById('login');
const loginMsg = document.getElementById('loginMsg');
const userBox = document.getElementById('user');
const passBox = document.getElementById('pass');

const DEFAULT_URL = '../das2C/examples/ex17_vector_noframe.d3b';

/* Anonymous for data older than six months, so a bookmarkable live example */
const EXAMPLE_LIVE = 'https://space.physics.uiowa.edu/das/stream?server=dataset'
	+ '&dataset=Juno/WAV/Survey&start_time=2017-01-01T13:00&end_time=2017-01-01T14:00';

/* When the node runner is driving (make server, or a headless check), the
 * first load's verdict is posted back like the test pages do. */
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

const d = await load({progName: 'inspect'});

/* ************************************************************************ */
/* Logins, by origin, in page memory only: never in the URL or in browser
 * storage.  Sent only after a server answers 401, since servers decide per
 * request. */

const logins = new Map();
let current = null;   /* the URL shown, for the retry after a login */

/* Passwords go to https only, or to loopback for the test runner's /auth/ */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function askLogin(url, e, refused)
{
	const where = new URL(url, location.href);
	loginMsg.textContent = refused
		? `${where.host} refused that login.`
		: `${where.host} wants a login${e.realm ? ` for "${e.realm}"` : ''}.`;
	loginForm.hidden = false;
	userBox.focus();
}

loginForm.addEventListener('submit', ev => {
	ev.preventDefault();
	const where = new URL(current, location.href);
	if(where.protocol !== 'https:' && !LOOPBACK.has(where.hostname)){
		loginMsg.textContent = `Not sending a password to ${where.host} over plain http.`;
		return;
	}
	try{ logins.set(where.origin, basicAuth(userBox.value, passBox.value)); }
	catch(e){
		loginMsg.textContent = e.message;
		return;
	}
	passBox.value = '';
	inspect(current);
});

/* ************************************************************************ */

async function inspect(url, verdict = false)
{
	current = url;
	loginForm.hidden = true;
	out.textContent = '';
	out.className = '';
	status.textContent = 'fetching...';
	const origin = new URL(url, location.href).origin;
	const auth = logins.get(origin);
	const t0 = performance.now();
	let bytes = 0;
	try{
		/* onChunk fires after each network chunk is parsed; the stream is
		 * already walkable there, which is how a progress meter works.  Here
		 * it just keeps the byte count moving. */
		const strm = await d.fetchStream(url, {
			headers: auth ? {Authorization: auth} : undefined,
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
		if(e instanceof DasError && e.status === 401){
			if(auth) logins.delete(origin);   /* that one didn't work */
			askLogin(url, e, Boolean(auth));
		}
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
