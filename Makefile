# das2js build
#
# Two C dependencies are pinned as submodules and compiled in, never linked
# dynamically: deps/das2C (the stream library) and deps/expat (its XML
# parser, needed because emscripten ships a zlib port but no expat port).
#
# Targets:
#
#   make wasm        cross-compile libexpat.a and libdas3.a to wasm32, build
#                    test/TestWasm.c against them, run it under node.  The
#                    current milestone; the browser module comes next.
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

WASM_CFLAGS=-std=c99 -Wall -Werror -O2 -g -I$(DAS2C) -Iglue --use-port=zlib

# NODERAWFS mounts the real filesystem so the test reads fixtures in place,
# nothing embedded.  EXIT_RUNTIME turns main()'s return into the exit status.
# -g keeps DWARF in the .wasm, which makes emcc warn that wasm-opt ran fewer
# passes; -Werror on the same command line would turn that into a failed
# link, so the warning is waived here.
# The browser module will use none of these.
WASM_TEST_LFLAGS=--use-port=zlib -sENVIRONMENT=node -sNODERAWFS=1 \
 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 \
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

wasm_test: $(EXPAT_LIB)
	$(MAKE) -C $(DAS2C) EMSCRIPTEN=yes EXPAT_INC=$(EXPAT_INC) EXPAT_LIB=$(EXPAT_LIB) test

## Housekeeping ##############################################################

$(BD) $(WBD):
	mkdir -p $@

clean:
	rm -rf build.*

FORCE:
.PHONY: test wasm wasm_test clean FORCE
