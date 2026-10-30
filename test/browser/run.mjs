/* Browser test runner: serve the build over HTTP, point a headless Firefox
 * at a test page, collect what the page reports back, exit with its status.
 *
 * Why a server at all?  ES modules and WebAssembly refuse to load from
 * file:// URLs (CORS treats every file as its own origin), so even a local
 * test needs http://.  Node's built-in http module is enough; no framework.
 *
 * Why Firefox specifically?  It is what is installed here, and with
 * --no-remote it leaves the developer's running Firefox session alone.
 * google-chrome is deliberately not used on this machine.
 *
 * Protocol with the page: the page POSTs text lines to /log as it goes and
 * finally POSTs {pass: bool} to /done.  Firefox's own console output is
 * also captured via the devtools.console.stdout.content pref, which routes
 * console.log() to the process stdout, for the cases where the page dies
 * before it can report anything.
 *
 * Usage: node test/browser/run.mjs [page.html] [--keep] [--dasflex=DIR] [--serve]
 *        [--timeout=SECONDS]
 *   page defaults to TestModule.html, --keep leaves the profile dir behind.
 *   --dasflex starts test/dasflex_cgi.py over the dasFlex build tree in DIR
 *   (default ../dasflex) and tells the page about it with
 *   ?server=local&port=N, so a live-style test can run with no network.
 *   --serve starts no Firefox: it prints the URL and stays up until Ctrl-C
 *   so you can load the page in your own browser, reload it after edits,
 *   and watch its log lines here as well as in the devtools console.
 *   It listens on a fixed port (SERVE_PORT below, or --port=N) so the URL
 *   can be bookmarked; the headless runs take an ephemeral port so they
 *   never collide with a serve session or with each other.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/* URL prefix -> directory.  Fixtures are served straight out of the das2C
 * checkout so the browser test reads the same files the native test does. */
const MOUNTS = [
	['/build/', path.join(ROOT, 'build.wasm32')],
	['/test/',  HERE],
	['/das2C/', path.join(ROOT, 'deps', 'das2C')],
	['/catalog/', path.join(ROOT, 'test', 'catalog')],
];

/* /auth/ serves the das2C mount behind a Basic auth login.  Pages must
 * reach it under the other loopback name (localhost for 127.0.0.1 and
 * back): as a second origin it gets the CORS preflight a remote das server
 * gets, and same origin would bring up Firefox's own login dialog.  The
 * password's non-ASCII letters test basicAuth()'s encoding. */
const AUTH_REALM = 'das2js test';
const AUTH_HDR = 'Basic ' + Buffer.from('tester:p\u00e4ss\u03c0', 'utf8').toString('base64');
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Expose-Headers': 'WWW-Authenticate',
};

/* Answer the /auth/ preflight or refuse a bad login, returning null; or
 * return the das2C path to serve when the login matches */
function authGate(req, res, url)
{
	if(req.method === 'OPTIONS'){
		res.writeHead(204, {...CORS,
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Authorization',
		}).end();
		return null;
	}
	if(req.headers.authorization !== AUTH_HDR){
		res.writeHead(401, {...CORS, 'WWW-Authenticate': `Basic realm="${AUTH_REALM}"`})
			.end('login required');
		return null;
	}
	return '/das2C/' + url.pathname.slice('/auth/'.length);
}

/* The .wasm type matters: WebAssembly.instantiateStreaming refuses anything
 * else.  Module scripts need a JavaScript type too, and so do stylesheets
 * and SVG images: browsers ignore either one served under a generic type. */
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.mjs':  'text/javascript; charset=utf-8',
	'.js':   'text/javascript; charset=utf-8',
	'.css':  'text/css; charset=utf-8',
	'.wasm': 'application/wasm',
	'.json': 'application/json',
	'.png':  'image/png',
	'.svg':  'image/svg+xml',
};

/* --timeout=N (seconds) for pages that pull hundreds of megabytes */
const timeoutArg = process.argv.slice(2).find(a => a.startsWith('--timeout='));
const TIMEOUT_MS = timeoutArg ? Number(timeoutArg.split('=')[1]) * 1000 : 90000;

/* 9099: not in /etc/services, and the local convention here is that ports
 * ending in 99 are personal test servers */
const SERVE_PORT = 9099;

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const serve = args.includes('--serve');
const portArg = args.find(a => a.startsWith('--port='));
const listenPort = serve ? (portArg ? Number(portArg.split('=')[1]) : SERVE_PORT) : 0;
const page = args.find(a => !a.startsWith('--')) || 'TestModule.html';
const dasflexArg = args.find(a => a.startsWith('--dasflex'));

let done = false;
let pass = false;
let firefox = null;
let dasflex = null;   /* child process of the CGI shim, if any */

function finish(ok, why)
{
	if(done) return;
	done = true;
	pass = ok;
	if(why) console.log((ok ? 'INFO: ' : 'ERROR: ') + why);
	if(firefox) firefox.kill();
	if(dasflex) dasflex.kill();
	server.close();
}

/* Start the CGI shim and resolve to the port it chose, which it prints as
 * its first line of output.  Python buffering is why the shim flushes. */
function startDasflex(dir)
{
	return new Promise((resolve, reject) => {
		const py = spawn('python3',
			[path.join(HERE, '..', 'dasflex_cgi.py'), '--root', dir],
			{stdio: ['ignore', 'pipe', 'pipe']});
		let first = '';
		py.stdout.once('data', chunk => {
			first = chunk.toString().split('\n')[0];
			resolve(parseInt(first, 10));
		});
		py.stderr.on('data', chunk => {
			for(const line of chunk.toString().split('\n'))
				if(line.trim()) console.log('dasflex: ' + line);
		});
		py.on('exit', code => { if(!first) reject(new Error(`dasflex_cgi.py exited ${code}`)); });
		dasflex = py;
	});
}

function readBody(req)
{
	return new Promise(resolve => {
		const parts = [];
		req.on('data', d => parts.push(d));
		req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://localhost');

	if(req.method === 'POST'){
		const body = await readBody(req);
		res.writeHead(204).end();
		if(url.pathname === '/log'){
			for(const line of body.split('\n')) if(line) console.log(line);
		}
		else if(url.pathname === '/done'){
			const r = JSON.parse(body);
			if(serve)   /* a human is driving; report and stay up for the next reload */
				console.log((r.pass ? 'INFO: ' : 'ERROR: ') + 'page reported ' + (r.pass ? 'success' : 'failure'));
			else
				finish(!!r.pass, r.pass ? 'page reported success' : 'page reported failure');
		}
		return;
	}

	let pathname = url.pathname;
	let extra = {};
	if(pathname.startsWith('/auth/')){
		pathname = authGate(req, res, url);
		if(pathname === null) return;
		extra = CORS;
	}

	for(const [prefix, dir] of MOUNTS){
		if(!pathname.startsWith(prefix)) continue;
		/* path.normalize then a prefix check keeps ../ from escaping the mount */
		const rel = path.normalize(decodeURIComponent(pathname.slice(prefix.length)));
		const file = path.join(dir, rel);
		if(!file.startsWith(dir)) break;
		let data;
		try{ data = fs.readFileSync(file); }
		catch(e){ break; }
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
			'Cache-Control': 'no-store',
			...extra,
		});
		res.end(data);
		return;
	}
	res.writeHead(404, extra).end('not found: ' + url.pathname);
});

server.on('error', e => {
	if(e.code === 'EADDRINUSE')
		console.log(`ERROR: port ${listenPort} is in use (another make server running?); try --port=N`);
	else
		console.log('ERROR: ' + e.message);
	if(dasflex) dasflex.kill();
	process.exit(1);
});

server.listen(listenPort, '127.0.0.1', async () => {
	const port = server.address().port;
	let target = `http://127.0.0.1:${port}/test/${page}`;

	if(dasflexArg){
		const dir = dasflexArg.includes('=') ? dasflexArg.split('=')[1] : path.join(ROOT, '..', 'dasflex');
		let dfPort;
		try{ dfPort = await startDasflex(dir); }
		catch(e){ finish(false, e.message); return; }
		console.log(`INFO: local dasFlex from ${dir} on port ${dfPort}`);
		target += (target.includes('?') ? '&' : '?') + `server=local&port=${dfPort}`;
	}
	console.log(`INFO: serving on ${target}`);

	if(serve){
		console.log('INFO: open that URL in a browser; Ctrl-C here to stop');
		process.on('SIGINT', () => finish(true, 'stopped'));
		server.on('close', () => process.exit(0));
		return;
	}

	/* A throwaway profile: Firefox refuses to start without one it can
	 * write, and we want prefs that a personal profile should never carry.
	 * It lives under ./tmp by project convention, not the system temp dir. */
	const profile = fs.mkdtempSync(path.join(ROOT, 'tmp', 'ffprofile-'));
	fs.writeFileSync(path.join(profile, 'user.js'), [
		/* console.log() -> stdout of the firefox process */
		'user_pref("devtools.console.stdout.content", true);',
		/* no first-run pages, update checks, telemetry, or default browser nag */
		'user_pref("browser.shell.checkDefaultBrowser", false);',
		'user_pref("browser.startup.homepage_override.mstone", "ignore");',
		'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
		'user_pref("app.update.enabled", false);',
		'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
		'user_pref("browser.aboutwelcome.enabled", false);',
		/* the bundled webcompat extension logs every site shim it registers
		 * at console.info, dozens of lines of noise per start */
		'user_pref("extensions.webcompat.perform_injections", false);',
		'user_pref("extensions.webcompat.perform_ua_overrides", false);',
		'',
	].join('\n'));

	firefox = spawn('firefox',
		['--headless', '--no-remote', '--profile', profile, target],
		{stdio: ['ignore', 'pipe', 'pipe']});

	/* Forward Firefox's console lines, which are prefixed by the pref with
	 * "console.log: " and the like; keep them as-is for diagnosis.
	 *
	 * Nothing after the verdict: finish() kills the main process, and while
	 * the cleanup waits for it to exit, its child processes lose their link
	 * to it and each prints "Exiting due to channel error". */
	const forward = chunk => {
		if(done) return;
		for(const line of chunk.toString().split('\n'))
			if(line.trim()) console.log('firefox: ' + line);
	};
	firefox.stdout.on('data', forward);
	firefox.stderr.on('data', forward);

	firefox.on('exit', code => {
		if(!done) finish(false, `firefox exited (${code}) before the page reported`);
	});

	const timer = setTimeout(() => finish(false, `no result within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);

	server.on('close', () => {
		clearTimeout(timer);

		const cleanup = () => {
			if(!keep) removeProfile(profile);
			else console.log('INFO: profile kept at ' + profile);
			process.exit(pass ? 0 : 1);
		};

		/* finish() only asked Firefox to quit; it still has the profile's
		 * databases open.  Deleting open files on NFS leaves .nfsXXXX
		 * stand-ins behind and the directory stays busy, so wait for the
		 * exit.  exitCode and signalCode stay null while the process runs.
		 * The timer covers a Firefox that ignores the request: cleanup()
		 * exits the process, so whichever fires first wins. */
		if(firefox.exitCode === null && firefox.signalCode === null){
			setTimeout(cleanup, 5000);
			firefox.once('exit', cleanup);
		}
		else
			cleanup();
	});
});

/* The page decides pass or fail, not the cleanup.  A profile that won't go
 * (a straggling Firefox child process can hold a file) is reported and left
 * in tmp/, which git ignores. */
function removeProfile(dir)
{
	try{
		fs.rmSync(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 200});
	}
	catch(err){
		console.log(`INFO: profile left at ${dir}: ${err.message}`);
	}
}
