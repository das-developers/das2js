# das2js build
#
# Two C dependencies are pinned as submodules and compiled in, never linked
# dynamically: deps/das2C (the stream library) and deps/expat (its XML
# parser, needed because emscripten ships a zlib port but no expat port).
#
# Targets:
#
#   make wasm        cross-compile libexpat.a and libdas3.a to wasm32, build
#                    test/TestWasm.c against them, run it under node
#   make module      the browser deliverable in build.wasm32/: das2c.wasm, its
#                    emscripten loader das2c.mjs, and the hand-written ES
#                    module das2js.mjs copied from src/.  DEBUG=yes keeps
#                    the C debug info (about 5x the .wasm size)
#   make browser     build the module and run test/browser/ under headless
#                    Firefox via a small node runner (Firefox only; it is
#                    what is installed here and --no-remote keeps it out of
#                    the developer's own session)
#   make live        the same against a public dasFlex server over the network
#   make local       the same against ../dasflex (DASFLEX=... to point elsewhere)
#                    through test/dasflex_cgi.py, a CGI shim; no Apache needed
#   make serve       serve the build and a test page on http://127.0.0.1:9099
#                    for a browser you drive yourself (PAGE=TestLive.html,
#                    RUNFLAGS=--dasflex to add the local dasFlex); Ctrl-C stops
#   make wasm_test   run das2C's own regression suite as wasm under node
#   make test        native build of the glue plus TestWasm against a native
#                    deps/das2C, for debugging the glue with ordinary tools
#   make clean
#
# The emscripten toolchain must be active in the calling shell (source
# emsdk_env.sh).  Node for running wasm output is taken from EMSDK_NODE, which
# that script exports; pass NODE=... to use another.

DAS2C=deps/das2C
EXPAT_SRC=deps/expat/expat/lib

# One output directory per target architecture, build.<arch>, as in das2C
# (whose wasm objects land in deps/das2C/build.wasm32)
BD=build.$(shell uname -m)
WBD=build.wasm32

# Native ---------------------------------------------------------------------

CC=gcc
CFLAGS=-std=c99 -Wall -Werror -ggdb -I$(DAS2C) -Iglue

DAS2C_LIB=$(DAS2C)/build./libdas3.a

# Same system libraries das2C itself links on Linux
LIBS=$(DAS2C_LIB) -lfftw3 -lexpat -lssl -lcrypto -lz -lm -lpthread

# Wasm -----------------------------------------------------------------------

EMCC=emcc
EMAR=emar

ifeq ($(NODE),)
ifeq ($(EMSDK_NODE),)
NODE:=node
else
NODE:=$(EMSDK_NODE)
endif
endif

EXPAT_INC=$(CURDIR)/$(EXPAT_SRC)
EXPAT_LIB=$(CURDIR)/$(WBD)/libexpat.a

# The three parser sources plus one entropy source.  The entropy choice has
# to agree with HAVE_GETENTROPY in buildfiles/expat_config.h, the hand-written
# stand-in for what expat's configure script would have probed.
EXPAT_SRCS=xmlparse.c xmltok.c xmlrole.c random_getentropy.c
EXPAT_OBJS=$(patsubst %.c,$(WBD)/expat_%.o,$(EXPAT_SRCS))
EXPAT_CFLAGS=-O2 -g -I$(EXPAT_INC) -Ibuildfiles

DAS2C_WASM_LIB=$(DAS2C)/build.wasm32/libdas3.a

# No -g here: whether DWARF ships is decided at link time, per output below.
# The libdas3.a and libexpat.a objects keep theirs either way.
WASM_CFLAGS=-std=c99 -Wall -Werror -O2 -I$(DAS2C) -Iglue --use-port=zlib

# NODERAWFS mounts the real filesystem so the test reads fixtures in place,
# nothing embedded.  EXIT_RUNTIME turns main()'s return into the exit status.
# -g keeps DWARF in the .wasm, which makes emcc warn that wasm-opt ran fewer
# passes; -Werror on the same command line would turn that into a failed
# link, so the warning is waived here.
# The browser module uses none of these.
WASM_TEST_LFLAGS=--use-port=zlib -sENVIRONMENT=node -sNODERAWFS=1 \
 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 \
 -g -Wno-limited-postlink-optimizations

# The shipped module carries no debug info.  -g at this link would keep the
# DWARF from every das2C and expat object and make das2c.wasm about 2.2 MB
# instead of 450 KB.  DEBUG=yes puts it back for stepping through the C in a
# browser debugger, and is why the module link keeps the warning waiver too.
# Run make clean first: nothing here notices DEBUG changing.
ifeq ($(DEBUG),yes)
MOD_DEBUG=-g
endif

# Browser module link.  MODULARIZE + EXPORT_ES6 turns the loader into an ES
# module exporting one factory function (EXPORT_NAME) that resolves to the
# runtime once the .wasm is instantiated; nothing runs at import time.  No
# filesystem: streams arrive through DasWasmRdr_feed, never fopen.  The C
# export surface is marked EMSCRIPTEN_KEEPALIVE in glue/wasm.h, so only the
# allocator the JS side needs for its scratch buffers is listed here.  The
# HEAP* views are what the JS wraps TypedArrays around, hence exported.
# Only the runtime helpers the JS actually uses are exported: cwrap to bind
# the glue functions once at load time, HEAPU8 and HEAP32 to reach the heap.
# The other typed views (HEAP16, HEAPF64, HEAP64...) are not exported because
# das2js.mjs builds its own TypedArrays over HEAPU8.buffer, so BigInt64Array
# over TT2000 values needs nothing extra here, not even WASM_BIGINT (no glue
# signature carries an int64 across the call boundary).  ccall is left out
# on purpose: it re-marshals on every call and would hand downstream a slow
# path we would rather they did not find.  The 1 MiB stack stays: das2C has
# large automatics.
MODULE=$(WBD)/das2c.mjs
JS_SRCS=$(wildcard src/*.mjs)
JS_OUT=$(patsubst src/%,$(WBD)/%,$(JS_SRCS))
WASM_MOD_LFLAGS=--use-port=zlib -sMODULARIZE=1 -sEXPORT_ES6=1 \
 -sEXPORT_NAME=createDas3Module -sENVIRONMENT=web,worker -sFILESYSTEM=0 \
 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 \
 -sEXPORTED_FUNCTIONS=_malloc,_free \
 -sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAP32 \
 -Wno-limited-postlink-optimizations

## Native ####################################################################

# TestWasm reads stream fixtures by paths relative to the das2C checkout, so
# it runs from there
test: $(BD)/TestWasm
	cd $(DAS2C) && $(CURDIR)/$(BD)/TestWasm

$(BD)/TestWasm: test/TestWasm.c glue/wasm.c glue/wasm.h $(DAS2C_LIB) | $(BD)
	$(CC) $(CFLAGS) test/TestWasm.c glue/wasm.c $(LIBS) -o $@

# Only builds das2C when the archive is missing; after pulling the submodule
# run make -C deps/das2C build yourself
$(DAS2C_LIB):
	$(MAKE) -C $(DAS2C) build

## Wasm ######################################################################

wasm: $(WBD)/TestWasm.js
	cd $(DAS2C) && $(NODE) $(CURDIR)/$(WBD)/TestWasm.js

$(WBD)/TestWasm.js: test/TestWasm.c glue/wasm.c glue/wasm.h $(DAS2C_WASM_LIB) $(EXPAT_LIB) | $(WBD)
	$(EMCC) $(WASM_CFLAGS) test/TestWasm.c glue/wasm.c $(DAS2C_WASM_LIB) $(EXPAT_LIB) $(WASM_TEST_LFLAGS) -o $@

# Always recurse: das2C's own dependency tracking decides what to rebuild
$(DAS2C_WASM_LIB): FORCE
	$(MAKE) -C $(DAS2C) EMSCRIPTEN=yes EXPAT_INC=$(EXPAT_INC) build

$(EXPAT_LIB): $(EXPAT_OBJS)
	rm -f $@
	$(EMAR) rc $@ $(EXPAT_OBJS)

$(WBD)/expat_%.o: $(EXPAT_SRC)/%.c buildfiles/expat_config.h | $(WBD)
	$(EMCC) -c $(EXPAT_CFLAGS) -o $@ $<

module: $(MODULE) $(JS_OUT)

$(MODULE): glue/wasm.c glue/wasm.h $(DAS2C_WASM_LIB) $(EXPAT_LIB) | $(WBD)
	$(EMCC) $(WASM_CFLAGS) $(MOD_DEBUG) glue/wasm.c $(DAS2C_WASM_LIB) $(EXPAT_LIB) $(WASM_MOD_LFLAGS) -o $@

# The ES module sits beside the loader it imports, so one directory is the
# whole deliverable
$(WBD)/%.mjs: src/%.mjs | $(WBD)
	cp $< $@

browser: module
	$(NODE) test/browser/run.mjs

# Same runner, real server: needs the network and a public dasFlex that is up
live: module
	$(NODE) test/browser/run.mjs TestLive.html

# Same page against the dasFlex checkout next door, served through the CGI
# shim in test/dasflex_cgi.py; no network, no Apache.  A sibling checkout
# rather than a submodule on purpose: a test server should track head.
DASFLEX?=../dasflex
local: module
	$(NODE) test/browser/run.mjs TestLive.html --dasflex=$(DASFLEX)

# No headless Firefox: the runner prints a URL and waits.  Load it, read the
# page and the devtools console, edit, reload.  Needed because file:// cannot
# load ES modules or .wasm, so "just open the html" does not work.
PAGE?=TestModule.html
serve: module
	$(NODE) test/browser/run.mjs $(PAGE) --serve $(RUNFLAGS)

# The structure inspector: load any stream URL, see the whole dataset tree
inspect: module
	$(NODE) test/browser/run.mjs Inspect.html --serve $(RUNFLAGS)

# Real-world timing against a live server, then re-parse from memory
perf: module
	$(NODE) test/browser/run.mjs Perf.html --serve $(RUNFLAGS)

wasm_test: $(EXPAT_LIB)
	$(MAKE) -C $(DAS2C) EMSCRIPTEN=yes EXPAT_INC=$(EXPAT_INC) EXPAT_LIB=$(EXPAT_LIB) test

## Housekeeping ##############################################################

$(BD) $(WBD):
	mkdir -p $@

clean:
	rm -rf build.*

FORCE:
.PHONY: test wasm module browser live local serve wasm_test clean FORCE
