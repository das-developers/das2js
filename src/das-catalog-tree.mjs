/* Copyright (C) 2026 Chris Piker
 * This file is part of das2js, das stream utilities for browsers.
 * See the LICENSE file in the repository root for terms.
 */

/* <das-catalog-tree>: a lazily expanded tree over a das catalog.  A custom
 * element, so it works in plain HTML and inside any framework.
 *
 * Usage:
 *
 *   import {load} from 'das2js';
 *   import 'das2js/catalog-tree';         // defines the tag
 *
 *   const tree = document.querySelector('das-catalog-tree');
 *   tree.catalog = (await load()).newCatalog();
 *   tree.addEventListener('das-select', ev => show(ev.detail.node));
 *
 * The page owns the catalog.  Set tree.catalog = null before freeing it.
 *
 * Each level is fetched when first opened.  A Collection or SourceSet
 * holding exactly one source das2C can load is shown as that source, under
 * the container's label; one holding several opens as a folder when
 * clicked.  The no-collapse attribute (property noCollapse) shows every
 * container as it is.
 *
 * Events, all bubbling and crossing the shadow boundary (composed):
 *
 *   das-open    detail {node}        the start node loaded and is drawn
 *   das-select  detail {node, parent, entry}
 *                                     a row was activated.  node is the
 *                                     loaded DasCatNode, or null for an
 *                                     entry das2C can't load (WebSockSrc,
 *                                     SPASE ...); entry is the listing entry
 *                                     from parent.children.  For a
 *                                     collapsed container, parent is that
 *                                     container.
 *   das-error   detail {parent, entry, error}
 *                                     a node failed to load
 *
 * Styling: the tree draws in a shadow root, so page CSS doesn't reach in.
 * Colors come from these custom properties, which do inherit through it:
 *
 *   --das-tree-muted   secondary text, badges     default #888
 *   --das-tree-hover   row hover and selection    default translucent grey
 *   --das-tree-accent  selection outline          default currentColor
 *   --das-tree-source  data source labels         default #3a7bd5
 *   --das-tree-error   failure notes              default #d33
 *   --das-tree-line    badge borders              default translucent grey
 *
 * and ::part(row), ::part(label), ::part(kind), ::part(note) for more.
 *
 * Keyboard, after the WAI-ARIA tree pattern: Up/Down move between visible
 * rows, Right opens (or loads) a container, Left closes it or moves to the
 * parent, Enter or Space activates.  One row at a time is in the tab order.
 */

/* Kinds that expand.  das2C's names, see DasCatNode.kind. */
const CONTAINERS = new Set(['catalog', 'collection', 'srcset']);

/* Containers that collapse into a lone source, see #collapse */
const SETS = new Set(['collection', 'srcset']);

/* Short tags for the kind badge */
const KIND_TAG = {
	catalog: 'Catalog', collection: 'Collection', srcset: 'SourceSet',
	stream_src: 'Source', file_agg: 'FileAgg', spdf_cat: 'SPDF',
	spase_cat: 'SPASE',
};

/* Open and closed markers, escaped so the source stays ASCII */
const CLOSED = '\u25b8';   /* small right triangle */
const OPEN = '\u25be';     /* small down triangle */

/* The shadow root's stylesheet.  :host is the <das-catalog-tree> element
 * itself as seen from inside. */
const STYLE = `
:host { display: block; }
ul { list-style: none; margin: 0; padding-left: 1.1em; }
ul.top { padding-left: 0; }
.row {
	display: flex; align-items: baseline; gap: 0.4em;
	padding: 0.1em 0.3em; border-radius: 5px;
	cursor: pointer; white-space: nowrap; outline: none;
}
.row:hover, .row:focus-visible { background: var(--das-tree-hover, rgba(128, 128, 128, 0.15)); }
.row[aria-selected=true] {
	background: var(--das-tree-hover, rgba(128, 128, 128, 0.15));
	box-shadow: inset 0 0 0 1px var(--das-tree-accent, currentColor);
}
.twisty { width: 1em; flex: none; text-align: center; color: var(--das-tree-muted, #888); }
.lbl { overflow: hidden; text-overflow: ellipsis; }
.src .lbl { color: var(--das-tree-source, #3a7bd5); }
.dim { opacity: 0.45; }
.kind {
	font-size: 0.72em; color: var(--das-tree-muted, #888);
	border: 1px solid var(--das-tree-line, rgba(128, 128, 128, 0.4));
	border-radius: 4px; padding: 0 0.35em;
}
.note { font-size: 0.85em; color: var(--das-tree-muted, #888); }
.note.err { color: var(--das-tree-error, #d33); }
`;

/* Element builder.  Text goes in through textContent, never innerHTML:
 * labels come from remote servers.  role and part must be set as
 * attributes; older browsers have no role property. */
const ATTRS = new Set(['role', 'part']);
function el(tag, props = {}, ...kids)
{
	const e = document.createElement(tag);
	for(const [k, v] of Object.entries(props)){
		if(ATTRS.has(k)) e.setAttribute(k, v);
		else e[k] = v;
	}
	for(const k of kids) e.append(k);
	return e;
}

export class DasCatalogTree extends HTMLElement {
	#cat = null;
	#top = null;      /* <ul> of the start node's children */
	#sel = null;      /* the selected .row */
	#gen = 0;         /* bumped per catalog, so stale loads are dropped */

	#rows = new WeakMap();   /* row element -> its state */

	constructor()
	{
		super();
		const root = this.attachShadow({mode: 'open'});
		root.append(el('style', {}, STYLE));
		this.#top = el('ul', {className: 'top', role: 'tree'});
		root.append(this.#top);
		this.#top.addEventListener('keydown', ev => this.#onKey(ev));
	}

	/** The DasCatalog shown.  Setting it clears the tree and loads the
	 * catalog's start node. */
	get catalog(){ return this.#cat; }
	set catalog(cat)
	{
		this.#cat = cat;
		this.reload();
	}

	/* Changing no-collapse redraws the tree: collapsed rows can't be
	 * un-collapsed in place */
	static observedAttributes = ['no-collapse'];

	attributeChangedCallback()
	{
		/* Also called during parsing, before any catalog is set */
		if(this.#cat !== null) this.reload();
	}

	get noCollapse(){ return this.hasAttribute('no-collapse'); }
	set noCollapse(on){ this.toggleAttribute('no-collapse', Boolean(on)); }

	/** The selected row's node, null if none or not loadable */
	get selected(){ return this.#sel ? (this.#rows.get(this.#sel).node ?? null) : null; }

	/** Draw the tree again from the catalog's start node.  Nodes already
	 * loaded cost nothing. */
	async reload()
	{
		const gen = ++this.#gen;
		this.#sel = null;
		this.#top.replaceChildren();
		if(this.#cat === null) return;

		let node;
		try{ node = await this.#cat.open(); }
		catch(error){
			if(gen === this.#gen) this.#emit('das-error', {parent: null, entry: null, error});
			return;
		}
		if(gen !== this.#gen) return;   /* another catalog was set meanwhile */

		this.#fill(this.#top, node);
		const first = this.#top.querySelector('.row');
		if(first) first.tabIndex = 0;
		this.#emit('das-open', {node});
	}

	#emit(type, detail)
	{
		this.dispatchEvent(new CustomEvent(type, {detail, bubbles: true, composed: true}));
	}

	#fill(ul, node)
	{
		for(const entry of node.children) ul.append(this.#item(node, entry));
		if(node.children.length === 0)
			ul.append(el('li', {role: 'none'}, el('span', {className: 'note', part: 'note'}, '(empty)')));
	}

	/* One <li> for a listed child, known by its listing entry before the
	 * child itself is loaded */
	#item(parent, entry)
	{
		/* Collections and SourceSets start out drawn as sources, see #collapse */
		const guess = !this.noCollapse && SETS.has(entry.kind);
		const isBox = CONTAINERS.has(entry.kind) && !guess;
		const isSrc = entry.kind === 'stream_src' || guess;

		const twisty = el('span', {className: 'twisty'}, isBox ? CLOSED : '');
		const note = el('span', {className: 'note', part: 'note'});
		const kind = el('span', {className: 'kind', part: 'kind'},
			KIND_TAG[guess ? 'stream_src' : entry.kind] || entry.stub.type || '?');
		const row = el('div', {className: 'row', role: 'treeitem', part: 'row', tabIndex: -1,
				title: entry.title || ''},
			twisty,
			el('span', {className: 'lbl', part: 'label'}, entry.label),
			kind,
			note);
		row.setAttribute('aria-selected', 'false');
		if(isBox) row.setAttribute('aria-expanded', 'false');
		if(isSrc) row.classList.add('src');
		if(!isBox && !isSrc) row.classList.add('dim');

		const li = el('li', {role: 'none'}, row);
		this.#rows.set(row, {parent, entry, guess, isBox, isSrc, twisty, kind, note, li,
			node: null, sub: null, busy: null});
		row.addEventListener('click', () => this.#activate(row, true));
		return li;
	}

	/* Load a row's node once.  Concurrent callers share the one load, which
	 * includes the collapse below, so a double click can't collapse twice. */
	#load(row)
	{
		const st = this.#rows.get(row);
		if(st.node !== null) return Promise.resolve(st.node);
		if(st.busy === null){
			const gen = this.#gen;
			st.note.className = 'note';
			st.note.textContent = 'loading...';
			st.busy = st.parent.child(st.entry.name).then(
				node => this.#collapse(row, node)
			).then(
				node => {
					st.node = node;
					st.note.textContent = '';
					return node;
				},
				error => {
					st.busy = null;   /* a later click retries */
					st.note.className = 'note err';
					st.note.textContent = 'failed';
					if(gen === this.#gen)
						this.#emit('das-error', {parent: st.parent, entry: st.entry, error});
					return null;
				});
		}
		return st.busy;
	}

	/* A Collection or SourceSet with exactly one child das2C can load
	 * (entry.loadable, from dassrc_loadable()) stands for that child: the
	 * row keeps its label and becomes the child's row, with the container
	 * as parent.  How many children there are is only known once the
	 * container loads, so #item draws these rows as sources up front; one
	 * that holds several, or whose lone source fails to load, turns back
	 * into a container here. */
	async #collapse(row, node)
	{
		const st = this.#rows.get(row);
		const lone = await this.#lone(node);
		if(lone === null){
			if(st.guess) this.#asBox(row, st);
			return node;
		}

		Object.assign(st, {parent: node, entry: lone.entry, isBox: false, isSrc: true});
		st.twisty.textContent = '';
		st.kind.textContent = KIND_TAG.stream_src;
		row.removeAttribute('aria-expanded');
		row.classList.add('src');
		return lone.node;
	}

	/* The one usable source in a Collection or SourceSet, loaded, as
	 * {entry, node}; null if there isn't exactly one or it won't load */
	async #lone(node)
	{
		if(this.noCollapse || !SETS.has(node.kind)) return null;
		const usable = node.children.filter(e => e.loadable);
		if(usable.length !== 1) return null;
		try{ return {entry: usable[0], node: await node.child(usable[0].name)}; }
		catch(e){ return null; }
	}

	/* Redraw a row drawn as a source as the container it is.  #activate
	 * then opens it. */
	#asBox(row, st)
	{
		Object.assign(st, {isBox: true, isSrc: false});
		st.twisty.textContent = CLOSED;
		st.kind.textContent = KIND_TAG[st.entry.kind];
		row.setAttribute('aria-expanded', 'false');
		row.classList.remove('src');
	}

	#setOpen(row, open)
	{
		const st = this.#rows.get(row);
		if(st.sub === null) return;
		st.sub.hidden = !open;
		st.twisty.textContent = open ? OPEN : CLOSED;
		row.setAttribute('aria-expanded', String(open));
	}

	#select(row)
	{
		if(this.#sel){
			this.#sel.setAttribute('aria-selected', 'false');
			this.#sel.tabIndex = -1;
		}
		this.#sel = row;
		row.setAttribute('aria-selected', 'true');
		row.tabIndex = 0;
	}

	/* A click, Enter or Space.  toggle: containers open or close. */
	async #activate(row, toggle)
	{
		const st = this.#rows.get(row);
		const gen = this.#gen;
		this.#select(row);

		if(!st.isBox && !st.isSrc){
			this.#emit('das-select', {node: null, parent: st.parent, entry: st.entry});
			return;
		}

		const wasLoaded = st.node !== null;
		const node = await this.#load(row);
		if(node === null || gen !== this.#gen) return;

		if(st.isBox){
			if(st.sub === null){
				st.sub = el('ul', {role: 'group'});
				this.#fill(st.sub, node);
				st.li.append(st.sub);
				this.#setOpen(row, true);
			}
			else if(toggle && wasLoaded){
				this.#setOpen(row, st.sub.hidden);
			}
		}

		/* A load that came back after the user moved on keeps quiet */
		if(this.#sel === row)
			this.#emit('das-select', {node, parent: st.parent, entry: st.entry});
	}

	/* Rows a user can see, in display order.  A row under a closed group
	 * has no layout box, so offsetParent is null for it. */
	#visible()
	{
		return Array.from(this.shadowRoot.querySelectorAll('.row'))
			.filter(r => r.offsetParent !== null);
	}

	#focus(row)
	{
		if(!row) return;
		for(const r of this.shadowRoot.querySelectorAll('.row[tabindex="0"]')) r.tabIndex = -1;
		row.tabIndex = 0;
		row.focus();
	}

	#onKey(ev)
	{
		const row = ev.target.closest('.row');
		if(!row) return;
		const st = this.#rows.get(row);
		const rows = this.#visible();
		const i = rows.indexOf(row);

		switch(ev.key){
		case 'ArrowDown': this.#focus(rows[i + 1]); break;
		case 'ArrowUp':   this.#focus(rows[i - 1]); break;
		case 'ArrowRight':
			if(st.isBox && (st.sub === null || st.sub.hidden)){
				if(st.sub === null) this.#activate(row, false);
				else this.#setOpen(row, true);
			}
			else if(st.sub !== null) this.#focus(st.sub.querySelector('.row'));
			break;
		case 'ArrowLeft':
			if(st.sub !== null && !st.sub.hidden) this.#setOpen(row, false);
			else{
				/* up to the row that owns this list */
				const up = row.parentElement.parentElement.closest('li');
				if(up) this.#focus(up.querySelector('.row'));
			}
			break;
		case 'Enter':
		case ' ':
			this.#activate(row, true);
			break;
		default:
			return;
		}
		ev.preventDefault();   /* no page scrolling on arrows and Space */
	}
}

/* Defining a tag twice throws, which a page importing this module through
 * two different URLs would otherwise hit */
if(!customElements.get('das-catalog-tree'))
	customElements.define('das-catalog-tree', DasCatalogTree);
