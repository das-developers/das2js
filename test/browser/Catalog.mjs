/* The catalog browser: <das-catalog-tree> on the left, and a details pane
 * that turns a data source's worked examples into request URLs.
 *
 * The tree is the shippable part, src/das-catalog-tree.mjs.  This file is
 * what an application would write around it: make a catalog, hand it to
 * the element, listen for its events.
 *
 * Query parameters, so a view can be bookmarked:
 *
 *   seed=URL     start from this node instead of START below
 *   flat=1       set the tree's no-collapse attribute
 *   internal=1   read the catalog from the internal test catalog, a
 *                partial copy in test/catalog/, instead of the network
 *   check=1      also click through the tree once and report the result
 *                to the node runner (make headless_test); implies internal
 */

import {load, DasError} from '/build/das2js.mjs';
import '/build/das-catalog-tree.mjs';     /* defines <das-catalog-tree> */

const tree = document.getElementById('tree');
const info = document.getElementById('info');
const status = document.getElementById('status');
const seedBox = document.getElementById('seed');
const internalNote = document.getElementById('internal');
const flatBox = document.getElementById('flat');

/* See Inspect.mjs: verdicts go to the node runner when one is listening */
function report(line, pass)
{
	fetch('/log', {method: 'POST', body: line}).catch(() => {});
	if(pass !== undefined)
		fetch('/done', {method: 'POST', body: JSON.stringify({pass})}).catch(() => {});
}

/* Map the real https URLs a walk asks for onto the internal test catalog,
 * served at /catalog/ by run.mjs */
function testCatalogFetch(url, init)
{
	return fetch(url.replace(/^https:\/\//, '/catalog/'), init);
}

/* Text through textContent only: catalog strings come from remote servers */
function el(tag, props = {}, ...kids)
{
	const e = Object.assign(document.createElement(tag), props);
	for(const k of kids) e.append(k);
	return e;
}

const das = await load({progName: 'catalog'});

/* Without a seed: das2C's compiled in root, opened at U. Iowa */
const START = 'tag:das2.org,2012:site:/uiowa';

let cat = null;        /* the DasCatalog shown */
let src = null;        /* the DasCatSource in the details pane, freed on change */
let t0 = 0;

/* ************************************************************************ */
/* Details pane */

function field(dl, name, value)
{
	if(value === null || value === undefined || value === '') return;
	dl.append(el('dt', {}, name), el('dd', {}, value));
}

function freeSource()
{
	if(src){ src.free(); src = null; }
}

function showNode(node)
{
	freeSource();
	const dl = el('dl');
	field(dl, 'node type', `${node.type} ${node.version || ''}`.trim());
	field(dl, 'uri', node.uri ?? '(a root, no uri)');
	field(dl, 'loaded from', node.url);
	if(node.isContainer) field(dl, 'children', String(node.children.length));
	field(dl, 'about', node.description);

	info.replaceChildren(el('h3', {}, node.title || node.label || node.name || '(untitled)'), dl);
	if(node.isSource) showSource(node);
}

/* A data source: pick a worked example, optionally a time span, and see
 * the request URL das2C builds from them */
function showSource(node)
{
	try{ src = node.source(); }
	catch(e){
		info.append(el('p', {className: 'err'}, e.message));
		return;
	}
	if(src.needsAuth)
		info.append(el('p', {}, el('span', {className: 'badge'},
				'login may be required' + (src.authRealm ? ` (${src.authRealm})` : '')),
			'  The catalog marks this source as protected; the server decides per'
			+ ' request, often by time range.'));

	const pick = el('select');
	src.examples.forEach((lbl, i) => pick.append(el('option', {value: i}, lbl || `example ${i}`)));
	if(src.examples.length === 0) pick.append(el('option', {value: -1}, '(no examples, blank request)'));

	const time = el('input', {type: 'text', placeholder: 'time, e.g. 2025-10-01T12', size: 26});
	const out = el('pre');
	let inspectUrl = null;
	const view = el('button', {type: 'button', onclick: () => window.open(inspectUrl, '_blank', 'noopener')},
		'Fetch and View Structure');
	const viewP = el('p', {}, view);

	/* Rebuild the URL whenever either control changes.  das2C reads
	 * "time=2025-10-01T12" as that whole hour, see das3/source.h "Keys". */
	function update()
	{
		const settings = time.value.trim() ? {time: time.value.trim()} : {};
		try{
			const req = src.request(Number(pick.value), settings);
			out.className = '';
			out.textContent = req.url + (req.mime ? `\n\n${req.mime}` : '');
			inspectUrl = 'Inspect.html?url=' + encodeURIComponent(req.url);
			viewP.hidden = false;
		}
		catch(e){
			out.className = 'err';
			out.textContent = e.message;
			viewP.hidden = true;
		}
	}
	pick.addEventListener('change', update);
	time.addEventListener('input', update);

	info.append(el('h3', {}, 'Examples'),
		el('form', {onsubmit: ev => ev.preventDefault()}, pick, time), out, viewP);
	update();
}

/* An entry das2C can't load: the listing is all there is */
function showEntry(parent, entry)
{
	freeSource();
	const dl = el('dl');
	field(dl, 'node type', `${entry.stub.type || '?'} (not a type this das2C loads)`);
	field(dl, 'listed in', parent.uri ?? parent.url);
	field(dl, 'urls', entry.urls.join('\n'));
	field(dl, 'provides', entry.provides.join(', '));
	field(dl, 'about', entry.description);
	info.replaceChildren(el('h3', {}, entry.title || entry.label), dl);
}

function showError(title, e)
{
	freeSource();
	info.replaceChildren(el('h3', {}, title),
		el('p', {className: 'err'}, (e instanceof DasError) ? e.message : `${e.name}: ${e.message}`));
}

/* ************************************************************************ */
/* The tree's events */

tree.addEventListener('das-open', ev => {
	const top = ev.detail.node;
	const ms = (performance.now() - t0).toFixed(0);
	status.textContent = `${top.uri ?? top.url}: ${top.children.length} children, ${ms} ms`;
	showNode(top);
});

tree.addEventListener('das-select', ev => {
	const {node, parent, entry} = ev.detail;
	if(node) showNode(node);
	else showEntry(parent, entry);
});

tree.addEventListener('das-error', ev => {
	const {entry, error} = ev.detail;
	if(entry === null) status.textContent = '';
	showError(entry ? (entry.title || entry.label) : 'catalog failed to open', error);
});

function open(seed, internal)
{
	freeSource();
	info.replaceChildren();
	tree.catalog = null;   /* never free a catalog the tree still holds */
	if(cat) cat.free();

	const opts = {};
	if(seed) opts.seed = seed;
	else opts.start = START;
	if(internal) opts.fetch = testCatalogFetch;
	cat = das.newCatalog(opts);

	status.textContent = 'loading...';
	t0 = performance.now();
	tree.catalog = cat;   /* the element loads and draws it */
}

/* ************************************************************************ */
/* Headless check, on the internal test catalog: open the tree, then click
 * down to the TRACERS-1 L2 MSC BAC SourceSet.  Of its flex and das2 DSDF
 * sources das2C loads only flex, so its row should collapse into that.
 * With no-collapse, the Voyager 1 PWS SpecAnalyzer-4s-Efield Collection
 * must open as a container.
 * Done the way a user would, through the shadow root's rows and click(). */

function next(type)
{
	return new Promise(resolve => tree.addEventListener(type, ev => resolve(ev), {once: true}));
}

/* Click the row labeled lbl among the rows under 'under' (a <ul>) and
 * return its das-select detail.  :scope > li pins it to that one level. */
function findRow(under, lbl)
{
	const row = Array.from(under.querySelectorAll(':scope > li > [part=row]'))
		.find(r => r.querySelector('[part=label]').textContent === lbl);
	if(!row) throw new Error(`no row '${lbl}'`);
	return row;
}

/* A leaf: no aria-expanded and no twisty painted */
function drawnAsLeaf(row)
{
	return !row.hasAttribute('aria-expanded') && row.querySelector('.twisty').textContent === '';
}

async function clickRow(under, lbl)
{
	const row = findRow(under, lbl);
	const picked = Promise.race([next('das-select'), next('das-error')]);
	row.click();
	const ev = await picked;
	if(ev.type === 'das-error') throw ev.detail.error;
	return {row, ...ev.detail};
}

async function selfCheck()
{
	const opened = await Promise.race([next('das-open'), next('das-error')]);
	if(opened.type === 'das-error') throw opened.detail.error;

	const top = opened.detail.node;
	if(top.uri !== START) throw new Error(`opened ${top.uri}`);
	const ul = tree.shadowRoot.querySelector('ul');
	const n = ul.querySelectorAll(':scope > li > [part=row]').length;
	if(n !== top.children.length) throw new Error(`${n} rows for ${top.children.length} children`);

	let at = ul, sel;
	for(const lbl of ['Tracers', 'TRACERS-1', 'L2']){
		sel = await clickRow(at, lbl);
		if(sel.row.getAttribute('aria-expanded') !== 'true') throw new Error(`${lbl} did not open`);
		const kids = sel.row.parentElement.querySelectorAll(':scope > ul > li > [part=row]').length;
		if(kids !== sel.node.children.length) throw new Error(`${kids} rows under ${lbl}, ${sel.node.children.length} children`);
		at = sel.row.parentElement.querySelector(':scope > ul');
	}

	if(!drawnAsLeaf(findRow(at, 'MSC BAC'))) throw new Error('MSC BAC drawn as a container before opening');
	sel = await clickRow(at, 'MSC BAC');
	if(!sel.node.isSource) throw new Error(`MSC BAC gave a ${sel.node.kind}, not a source`);
	if(sel.parent.kind !== 'srcset' || sel.entry.name !== 'flex')
		throw new Error(`MSC BAC collapsed to ${sel.parent.kind} / ${sel.entry.name}`);
	if(sel.row.hasAttribute('aria-expanded') || sel.row.parentElement.querySelector('ul'))
		throw new Error('MSC BAC row still drawn as a container');
	const srcUri = sel.node.uri;
	const SA = 'SpecAnalyzer-4s-Efield';

	/* no-collapse redraws the tree; the Collection must then open as one */
	const redrawn = next('das-open');
	tree.noCollapse = true;
	await redrawn;
	at = tree.shadowRoot.querySelector('ul');
	for(const lbl of ['Voyager', '1', 'PWS', SA]){
		if(lbl === SA && drawnAsLeaf(findRow(at, lbl)))
			throw new Error(`with no-collapse ${SA} drawn as a source`);
		sel = await clickRow(at, lbl);
		at = sel.row.parentElement.querySelector(':scope > ul');
	}
	if(sel.node.kind !== 'collection' || sel.row.getAttribute('aria-expanded') !== 'true')
		throw new Error(`with no-collapse ${SA} gave a ${sel.node.kind}`);
	const nColl = at.querySelectorAll(':scope > li > [part=row]').length;

	/* The rare case, from the hand-made test/catalog/local/srcsets.json: a
	 * SourceSet with two usable sources is drawn as a source until opened,
	 * then gets its twisty and opens as a container.  Detach first so the
	 * attribute change has no catalog to redraw, see open(). */
	tree.catalog = null;
	tree.noCollapse = false;
	const reopened = next('das-open');
	open('https://local/srcsets.json', true);
	await reopened;
	at = tree.shadowRoot.querySelector('ul');
	for(const lbl of ['MSC BAC', 'Two das2'])
		if(!drawnAsLeaf(findRow(at, lbl))) throw new Error(`${lbl} drawn as a container before opening`);

	sel = await clickRow(at, 'Two das2');
	if(sel.node.kind !== 'srcset' || sel.row.getAttribute('aria-expanded') !== 'true')
		throw new Error(`'Two das2' gave a ${sel.node.kind}, expanded ${sel.row.getAttribute('aria-expanded')}`);
	const nTwo = sel.row.parentElement.querySelectorAll(':scope > ul > li > [part=row]').length;
	if(nTwo !== 2) throw new Error(`${nTwo} rows under 'Two das2'`);
	sel = await clickRow(at, 'MSC BAC');
	if(!sel.node.isSource || sel.entry.name !== 'flex')
		throw new Error(`seeded MSC BAC gave a ${sel.node.kind} / ${sel.entry.name}`);

	return `opened ${top.uri}, ${n} rows; down to L2, MSC BAC collapsed to ${srcUri}; `
		+ `with no-collapse ${SA} opened with ${nColl} row(s); `
		+ `a two-source set drawn as a source opened with ${nTwo}`;
}

/* ************************************************************************ */

document.getElementById('form').addEventListener('submit', ev => {
	ev.preventDefault();
	const q = new URLSearchParams();
	if(seedBox.value.trim()) q.set('seed', seedBox.value.trim());
	if(internal) q.set('internal', '1');
	if(flatBox.checked) q.set('flat', '1');
	history.replaceState(null, '', '?' + q);
	/* After open(): a no-collapse change redraws whatever catalog the tree
	 * holds, and the old one is freed by then */
	open(seedBox.value.trim(), internal);
	tree.noCollapse = flatBox.checked;
});

const q = new URLSearchParams(location.search);
seedBox.value = q.get('seed') || '';
const check = q.get('check') === '1';
const internal = check || q.get('internal') === '1';
internalNote.hidden = !internal;
flatBox.checked = q.get('flat') === '1';
tree.noCollapse = flatBox.checked;

if(check)
	selfCheck().then(
		msg => report(`INFO: catalog tree: ${msg}`, true),
		e => report(`ERROR: catalog tree: ${e.message}`, false));
open(seedBox.value, internal);
