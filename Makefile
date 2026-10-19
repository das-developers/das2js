# das2js build stub.  Only the native glue test works so far; the wasm
# module build arrives once an emscripten makefile lands in das2C (it will
# produce the libdas3.a archive this project links).
#
# The glue compiles against a das2C checkout that has already been built,
# since the native test needs build./libdas3.a from it.  Default is a
# sibling directory; override on the command line if yours is elsewhere:
#
#    make test DAS2C=/path/to/das2C

DAS2C=../das2C
DAS2C_LIB=$(DAS2C)/build./libdas3.a

BD=build

CC=gcc
CFLAGS=-std=c99 -Wall -Werror -ggdb -I$(DAS2C) -Iglue

# Same system libraries das2C itself links on Linux
LIBS=$(DAS2C_LIB) -lfftw3 -lexpat -lssl -lcrypto -lz -lm -lpthread

# TestWasm reads stream fixtures by paths relative to the das2C checkout,
# so it runs from there
test: $(BD)/TestWasm
	cd $(DAS2C) && $(CURDIR)/$(BD)/TestWasm

$(BD)/TestWasm: test/TestWasm.c glue/wasm.c glue/wasm.h | $(BD)
	$(CC) $(CFLAGS) test/TestWasm.c glue/wasm.c $(LIBS) -o $@

$(BD):
	mkdir -p $(BD)

clean:
	rm -rf $(BD)

.PHONY: test clean
