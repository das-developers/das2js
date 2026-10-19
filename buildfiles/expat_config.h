/* Hand-written expat_config.h for compiling libexpat to wasm32 with emcc.
 *
 * libexpat normally generates this file with ./configure or CMake.  Neither
 * is wanted here: the answers for emscripten's libc never change, so they
 * are written down once instead of probed on every build.  Revisit when the
 * deps/expat pin moves to a release that adds config knobs; the authoritative
 * list is deps/expat/expat/expat_config.h.cmake.
 */
#ifndef EXPAT_CONFIG_H
#define EXPAT_CONFIG_H 1

/* wasm32 is little endian by definition */
#define BYTEORDER 1234

/* Hash salt entropy.  Emscripten's libc implements getentropy() over the
 * host's crypto.getRandomValues (browser) or crypto.randomFillSync (node),
 * so expat gets real randomness and XML_POOR_ENTROPY is not needed.  This
 * choice must agree with the random_*.c file compiled into the archive, see
 * EXPAT_SRCS in the Makefile. */
#define HAVE_GETENTROPY 1

/* Standard headers emscripten's musl libc provides */
#define HAVE_FCNTL_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_MEMORY_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define STDC_HEADERS 1

/* Parser features, the same defaults a stock expat build has.  das streams
 * use neither DTDs nor namespaces, but matching the system library keeps the
 * browser build's parsing behavior identical to das2C's native one. */
#define XML_CONTEXT_BYTES 1024
#define XML_DTD 1
#define XML_GE 1
#define XML_NS 1

#endif /* EXPAT_CONFIG_H */
