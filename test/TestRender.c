/** @file TestRender.c Exercise of the raster painter in src/render.h
 *
 * Paints das2C example streams the way the perf page does: a reader with a
 * renderer attached, fed in chunks.  Checks are structural (picture kind,
 * what got painted where) plus one consistency check: a spectrogram
 * painted incrementally must match one repainted from the finished stream.
 *
 * Run from the das2C checkout so the example paths resolve.  Give a
 * directory as the first argument to also write each image there as a
 * PPM for eyeballing.  Add a stream file and its begin and end times to
 * paint just that one instead of the checks:
 *
 *   TestRender.js OUT_DIR FILE BEGIN END
 */

/* Author: Chris Piker <chris-piker@uiowa.edu>
 *
 * This file is intended to demonstrate an interface.  This is free
 * and unencumbered software released into the public domain.
 *
 * For more information, please refer to <http://unlicense.org/>
 */

#define _POSIX_C_SOURCE 200112L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include <das3/core.h>
#include "wasm.h"
#include "render.h"

#define CHECK(COND, MSG) \
	if(!(COND)){ printf("ERROR: %s (%s:%d)\n", MSG, __FILE__, __LINE__); return 1; }

#define WIDTH  800
#define HEIGHT 232

static const char* g_sOutDir = NULL;
static bool g_bLenient = false;   /* a truncated file is fine, see main */

/* Read a whole file through a reader with a renderer attached.  The
 * renderer is returned; the reader is freed first, as render.h asks. */
static DasRender* paintFile(
	const char* sPath, const char* sBeg, const char* sEnd, size_t uChunk
){
	FILE* pFile = fopen(sPath, "rb");
	if(pFile == NULL){
		printf("ERROR: Couldn't open %s\n", sPath);
		return NULL;
	}
	DasWasmRdr* pRdr = new_DasWasmRdr();
	DasRender* pRen = new_DasRender(WIDTH, HEIGHT);
	DasRender_setX(pRen, sBeg, sEnd);
	DasRender_attach(pRen, pRdr);

	static ubyte aBuf[65536];
	if(uChunk > sizeof(aBuf)) uChunk = sizeof(aBuf);
	size_t uRead;
	int nRet = 0;
	while((uRead = fread(aBuf, 1, uChunk, pFile)) > 0){
		if((nRet = DasWasmRdr_feed(pRdr, aBuf, (int)uRead)) != 0) break;
	}
	fclose(pFile);
	if(nRet == 0) nRet = DasWasmRdr_end(pRdr);
	del_DasWasmRdr(pRdr);

	/* The head of a big download ends mid-packet; that's expected */
	if((nRet != 0) && g_bLenient){
		printf("WARNING: %s: %s\n", sPath, daswasm_lastError());
		nRet = 0;
	}

	if(nRet != 0){
		printf("ERROR: %s failed to parse: %s\n", sPath, daswasm_lastError());
		del_DasRender(pRen);
		return NULL;
	}
	return pRen;
}

/* Count of columns with at least one non-black pixel, and the last one */
static int paintedCols(const ubyte* pRgba, int* pLast)
{
	int nCols = 0;
	*pLast = -1;
	for(int c = 0; c < WIDTH; ++c){
		for(int r = 0; r < HEIGHT; ++r){
			const ubyte* p = pRgba + ((size_t)r*WIDTH + c)*4;
			if(p[0] | p[1] | p[2]){ ++nCols; *pLast = c; break; }
		}
	}
	return nCols;
}

static void writePpm(const char* sName, const ubyte* pRgba)
{
	if(g_sOutDir == NULL) return;
	char sPath[512];
	snprintf(sPath, sizeof(sPath), "%s/%s.ppm", g_sOutDir, sName);
	FILE* pOut = fopen(sPath, "wb");
	if(pOut == NULL){ printf("WARNING: can't write %s\n", sPath); return; }
	fprintf(pOut, "P6\n%d %d\n255\n", WIDTH, HEIGHT);
	for(size_t u = 0; u < (size_t)WIDTH*HEIGHT; ++u) fwrite(pRgba + u*4, 1, 3, pOut);
	fclose(pOut);
	printf("INFO: wrote %s\n", sPath);
}

static void describe(const char* sName, const DasRender* pRen)
{
	printf("INFO: %s: kind %d, y %g to %g %s%s, color %g to %g %s%s, "
		"rescales %d, skipped %d, paint %.1f ms%s%s\n", sName,
		DasRender_kind(pRen),
		DasRender_range(pRen, 0, 0), DasRender_range(pRen, 0, 1),
		DasRender_units(pRen, 0), DasRender_isLog(pRen, 0) ? " log" : "",
		DasRender_range(pRen, 1, 0), DasRender_range(pRen, 1, 1),
		DasRender_units(pRen, 1), DasRender_isLog(pRen, 1) ? " log" : "",
		DasRender_rescales(pRen), DasRender_skipped(pRen), DasRender_paintMs(pRen),
		DasRender_note(pRen)[0] ? ", note: " : "", DasRender_note(pRen)
	);
}

int main(int argc, char** argv)
{
	daswasm_init(argv[0]);
	if(argc > 1) g_sOutDir = argv[1];

	if(argc > 4){
		g_bLenient = true;
		DasRender* pRen = paintFile(argv[2], argv[3], argv[4], 65536);
		CHECK(pRen != NULL, "read");
		const ubyte* pRgba = DasRender_colorize(pRen);
		describe(argv[2], pRen);
		writePpm("extra", pRgba);
		del_DasRender(pRen);
		return 0;
	}

	/* 1. Juno survey: four frequency bands, log y and log z */
	const char* sSurvey = "examples/ex09_juno_waves_survey.d2t";
	const char* sSBeg = "2017-01-01T00:00", *sSEnd = "2017-01-01T00:05";
	DasRender* pRen = paintFile(sSurvey, sSBeg, sSEnd, 997);
	CHECK(pRen != NULL, "survey read");
	describe("survey", pRen);
	CHECK(DasRender_kind(pRen) == DASRENDER_SPECTRO, "survey is a spectrogram");
	CHECK(DasRender_isLog(pRen, 0) && DasRender_isLog(pRen, 1), "survey axes are log");
	CHECK(DasRender_skipped(pRen) == 0, "survey bands all match");
	/* The first band tops out near 20 kHz; the union must reach the HF bands */
	CHECK(DasRender_range(pRen, 0, 1) > 1e6, "survey y range covers every band");
	CHECK(DasRender_range(pRen, 0, 0) < 48.83, "survey y range covers the lowest bin");

	const ubyte* pRgba = DasRender_colorize(pRen);
	int nLast;
	int nCols = paintedCols(pRgba, &nLast);
	printf("INFO: survey: %d of %d columns painted, last %d\n", nCols, WIDTH, nLast);
	/* about 1 record per second per band against 2.7 px per second: columns
	 * between records stay black, there is no x stretching */
	CHECK(nCols > WIDTH * 0.8, "survey fills most columns");
	writePpm("survey", pRgba);

	/* Peak-hold doesn't care how the records were batched: big chunks
	 * deliver many packets per feed, small ones split packets */
	ubyte* pFirst = (ubyte*)malloc((size_t)WIDTH*HEIGHT*4);
	memcpy(pFirst, pRgba, (size_t)WIDTH*HEIGHT*4);
	del_DasRender(pRen);
	pRen = paintFile(sSurvey, sSBeg, sSEnd, 65536);
	CHECK(pRen != NULL, "survey re-read");
	pRgba = DasRender_colorize(pRen);
	CHECK(memcmp(pFirst, pRgba, (size_t)WIDTH*HEIGHT*4) == 0,
		"survey painted in small chunks matches large chunks");
	free(pFirst);
	del_DasRender(pRen);

	/* The fixture holds 5 minutes; a 10 minute window paints the left half
	 * and nothing past the last record */
	pRen = paintFile(sSurvey, sSBeg, "2017-01-01T00:10", 997);
	CHECK(pRen != NULL, "survey wide window read");
	pRgba = DasRender_colorize(pRen);
	nCols = paintedCols(pRgba, &nLast);
	CHECK((nLast > WIDTH/2 - 4)&&(nLast < WIDTH/2 + 1), "no paint past the last record");
	del_DasRender(pRen);

	/* 2. Voyager peaks: spectrogram with no scaleType, so linear axes */
	pRen = paintFile("examples/ex05_vgr_pws_sa_peaks.d2s", "2014-04-02", "2014-04-12", 4096);
	CHECK(pRen != NULL, "voyager read");
	describe("voyager", pRen);
	CHECK(DasRender_kind(pRen) == DASRENDER_SPECTRO, "voyager is a spectrogram");
	pRgba = DasRender_colorize(pRen);
	nCols = paintedCols(pRgba, &nLast);
	printf("INFO: voyager: %d of %d columns painted\n", nCols, WIDTH);
	CHECK(nCols > 0, "voyager painted something");
	writePpm("voyager", pRgba);
	del_DasRender(pRen);

	/* Cassini survey: later band headers arrive after over a thousand data
	 * packets, so the y range widens with records already painted and the
	 * renderer must repaint them under the new range */
	pRen = paintFile("examples/ex08_cassini_rpws_survey.d2t", "2017-01-01T02:40", "2017-01-01T06:00", 4093);
	CHECK(pRen != NULL, "cassini read");
	describe("cassini", pRen);
	CHECK(DasRender_kind(pRen) == DASRENDER_SPECTRO, "cassini is a spectrogram");
	CHECK(DasRender_rescales(pRen) > 0, "cassini late headers forced a repaint");
	pRgba = DasRender_colorize(pRen);
	nCols = paintedCols(pRgba, &nLast);
	printf("INFO: cassini: %d of %d columns painted\n", nCols, WIDTH);
	CHECK(nCols > WIDTH / 2, "cassini painted most columns");
	writePpm("cassini", pRgba);
	del_DasRender(pRen);

	/* 3. Juno waveforms, das3 binary: density from REF + OFFSET times */
	pRen = paintFile("examples/ex18_juno_waves_wfrm.d3b",
		"2013-10-09T15:30:59.875", "2013-10-09T15:33:00.124", 997);
	CHECK(pRen != NULL, "waveform read");
	describe("waveform", pRen);
	CHECK(DasRender_kind(pRen) == DASRENDER_DENSITY, "waveform is a density plot");
	CHECK(!DasRender_isLog(pRen, 0), "waveform amplitude is linear");
	CHECK(isnan(DasRender_range(pRen, 1, 0)), "density has no color range");
	pRgba = DasRender_colorize(pRen);
	nCols = paintedCols(pRgba, &nLast);
	printf("INFO: waveform: %d of %d columns painted\n", nCols, WIDTH);
	CHECK(nCols > 0, "waveform painted something");
	writePpm("waveform", pRgba);
	del_DasRender(pRen);

	/* 4. Ragged Cassini waveforms: a different length per record */
	pRen = paintFile("examples/ex19_cassini_ragged_wfrm.d3t", "2004-03-28T03:00", "2004-03-28T03:20", 997);
	CHECK(pRen != NULL, "ragged read");
	describe("ragged", pRen);
	CHECK(DasRender_kind(pRen) == DASRENDER_DENSITY, "ragged waveform is a density plot");
	del_DasRender(pRen);

	/* 5. No x range: nothing painted, and nothing breaks */
	DasWasmRdr* pRdr = new_DasWasmRdr();
	pRen = new_DasRender(WIDTH, HEIGHT);
	DasRender_attach(pRen, pRdr);
	FILE* pFile = fopen(sSurvey, "rb");
	CHECK(pFile != NULL, "survey open");
	static ubyte aBuf[4096];
	size_t uRead;
	while((uRead = fread(aBuf, 1, sizeof(aBuf), pFile)) > 0)
		CHECK(DasWasmRdr_feed(pRdr, aBuf, (int)uRead) == 0, "feed without x range");
	fclose(pFile);
	CHECK(DasWasmRdr_end(pRdr) == 0, "end without x range");
	del_DasWasmRdr(pRdr);
	pRgba = DasRender_colorize(pRen);
	CHECK(paintedCols(pRgba, &nLast) == 0, "nothing painted without an x range");
	CHECK(DasRender_setX(pRen, sSBeg, sSEnd) != 0, "x range refused after data");
	del_DasRender(pRen);

	printf("INFO: All render checks passed\n");
	return 0;
}
