/* Copyright (C) 2026 Chris Piker
 *
 * This file is part of das2js, das stream utilities for browsers.
 * See the LICENSE file in the repository root for terms.
 *
 * das2js statically links das2C, which is LGPL 2.1; distributions of the
 * compiled WebAssembly module carry das2C's terms as well as these.
 */

/* Raster painter, see render.h for the contract.
 *
 * Data access:
 *   - Values come from DasVar_subset() one record at a time.  For array
 *     backed variables that's a view, no copy.  One record per call also
 *     covers ragged waveforms without a separate path.
 *   - Waveform times are REF + OFFSET.  The upconverter also gives such a
 *     time dimension a CENTER binop, but subsetting a binop evaluates it
 *     item by item, so the parts are read separately and added here.
 *   - All times become us2000 doubles internally.  Microsecond steps on an
 *     8e14 magnitude leave plenty of precision for pixel placement.
 *
 * Grids:
 *   - Spectrogram: float per pixel holding the peak value in axis space
 *     (log10 for log axes), -INFINITY when empty.  Raw values, not color
 *     indices, so a Z refit only changes the colorize pass.
 *   - Density: uint32 count per pixel.  A float stops counting exactly at
 *     2^24, which a hot pixel of a long waveform day can approach.
 *
 * Errors: callbacks always return DAS_OKAY.  A picture that can't be drawn
 * must not stop the parse; the reason goes to sNote instead.
 */

#define _POSIX_C_SOURCE 200112L

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <stdint.h>
#include <stdarg.h>
#include <math.h>
#include <time.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <das3/core.h>

#include "render.h"

#define DR_MIN_SZ     16
#define DR_MAX_SZ     8192
#define DR_NOTE_SZ    256
#define DR_DIM_SZ     64
#define DR_HIST       1024   /* refit resolution, in bins over the range */
#define DR_SPAN_CAP   8      /* max rows a y bin stretches each way */
#define DR_OUT_FRAC   0.05   /* outlier fraction that forces a refit */
#define DR_MIN_PTS    256    /* don't judge outliers on fewer points */
#define DR_NARROW_AT  0.10   /* fraction of width painted before the narrowing refit */
#define DR_TAIL       0.001  /* percentile clipped from each end on refit */
#define DR_PAD        0.05   /* fraction of span added to each end on refit */

/* ************************************************************************* */
/* Default color map: sampled from the color bar of a das2 desktop
 * spectrogram plot (Juno Waves survey), low to high,
 * linearly resampled from 232 rows to 256 entries. */

static const ubyte g_aDefMap[256*4] = {
	  0,  0,124,255,   0,  2,129,255,   0,  4,136,255,   0,  5,141,255,
	  0,  7,147,255,   0,  9,152,255,   0, 11,158,255,   0, 12,164,255,
	  0, 13,169,255,   0, 15,175,255,   0, 17,181,255,   0, 19,187,255,
	  0, 22,192,255,   0, 24,196,255,   0, 27,200,255,   0, 30,204,255,
	  0, 33,208,255,   0, 38,215,255,   0, 45,222,255,   0, 54,228,255,
	  0, 58,231,255,   0, 62,234,255,   0, 67,237,255,   0, 72,240,255,
	  0, 77,242,255,   0, 81,244,255,   0, 84,247,255,   0, 88,249,255,
	  0, 91,251,255,   0, 95,253,255,   0,100,255,255,   0,103,255,255,
	  0,107,255,255,   0,110,255,255,   0,115,255,255,   0,118,255,255,
	  0,121,255,255,   0,124,255,255,   0,126,255,255,   0,129,255,255,
	  0,131,255,255,   0,133,255,255,   0,136,255,255,   0,139,255,255,
	  0,142,255,255,   0,144,255,255,   0,147,255,255,   0,150,255,255,
	  0,152,255,255,   0,154,255,255,   0,157,253,255,   0,160,251,255,
	  0,164,249,255,   0,165,247,255,   0,166,245,255,   0,168,243,255,
	  0,170,241,255,   0,171,239,255,   0,172,237,255,   0,173,236,255,
	  0,174,234,255,   0,175,233,255,   0,176,232,255,   0,178,230,255,
	  0,179,228,255,   0,180,226,255,   0,181,225,255,   0,182,224,255,
	  0,184,221,255,   0,186,219,255,   0,186,217,255,   0,188,215,255,
	  0,189,214,255,   0,190,213,255,   0,191,211,255,   0,192,209,255,
	  0,194,207,255,   0,195,206,255,   0,196,205,255,   0,197,203,255,
	  0,198,202,255,   0,199,200,255,   0,200,198,255,   0,201,197,255,
	  0,202,195,255,   0,204,194,255,   0,206,190,255,   0,207,188,255,
	  0,208,187,255,   0,210,186,255,   0,211,184,255,   0,212,183,255,
	  0,214,182,255,   0,215,182,255,   0,216,182,255,   0,217,181,255,
	  0,218,181,255,   0,220,181,255,   5,221,181,255,  14,222,180,255,
	 23,223,180,255,  33,224,180,255,  48,226,180,255,  64,227,181,255,
	 74,228,182,255,  84,230,182,255,  94,231,183,255, 104,232,183,255,
	115,233,185,255, 124,234,186,255, 132,235,188,255, 142,237,190,255,
	151,237,191,255, 160,238,194,255, 167,240,197,255, 172,241,200,255,
	179,242,203,255, 185,243,206,255, 191,244,210,255, 197,246,212,255,
	206,247,218,255, 213,249,222,255, 218,250,225,255, 224,251,228,255,
	229,252,232,255, 233,253,236,255, 239,255,241,255, 245,255,245,255,
	254,255,255,255, 255,255,255,255, 255,255,248,255, 255,255,241,255,
	255,255,233,255, 255,255,226,255, 255,255,219,255, 255,255,212,255,
	255,255,203,255, 255,255,190,255, 255,255,183,255, 255,255,176,255,
	255,255,168,255, 255,255,161,255, 255,255,154,255, 255,255,147,255,
	255,255,139,255, 255,255,132,255, 255,255,125,255, 255,255,118,255,
	255,255,110,255, 255,255,103,255, 255,253, 96,255, 255,251, 89,255,
	255,249, 81,255, 255,247, 74,255, 255,243, 63,255, 255,240, 53,255,
	255,237, 45,255, 255,236, 38,255, 255,234, 31,255, 255,231, 24,255,
	255,229, 16,255, 255,227,  9,255, 255,225,  2,255, 255,223,  0,255,
	255,219,  0,255, 255,216,  0,255, 255,214,  0,255, 255,212,  0,255,
	255,210,  0,255, 255,208,  0,255, 255,205,  0,255, 255,201,  0,255,
	255,199,  0,255, 255,197,  0,255, 255,195,  0,255, 255,192,  0,255,
	255,190,  0,255, 255,188,  0,255, 255,186,  0,255, 255,184,  0,255,
	255,182,  0,255, 255,179,  0,255, 255,177,  0,255, 255,175,  0,255,
	255,173,  0,255, 255,171,  0,255, 255,169,  0,255, 255,167,  0,255,
	255,164,  0,255, 255,160,  0,255, 255,158,  0,255, 255,156,  0,255,
	255,153,  0,255, 255,151,  0,255, 255,150,  0,255, 255,147,  0,255,
	255,145,  0,255, 255,143,  0,255, 255,141,  0,255, 255,138,  0,255,
	255,136,  0,255, 255,132,  0,255, 255,130,  0,255, 255,128,  0,255,
	255,126,  0,255, 255,121,  0,255, 255,119,  0,255, 255,117,  0,255,
	255,115,  0,255, 255,112,  0,255, 255,111,  0,255, 255,109,  0,255,
	255,106,  0,255, 255,104,  0,255, 255,102,  0,255, 255,100,  0,255,
	255, 98,  0,255, 255, 95,  0,255, 255, 93,  0,255, 255, 91,  0,255,
	255, 89,  0,255, 255, 87,  0,255, 255, 84,  0,255, 253, 80,  0,255,
	252, 78,  0,255, 251, 76,  0,255, 250, 74,  0,255, 249, 72,  0,255,
	248, 69,  0,255, 246, 67,  0,255, 243, 65,  0,255, 240, 63,  0,255,
	239, 61,  0,255, 237, 59,  0,255, 234, 57,  0,255, 230, 54,  0,255,
	225, 52,  0,255, 218, 49,  0,255, 213, 46,  0,255, 206, 42,  0,255,
	200, 39,  0,255, 196, 37,  0,255, 192, 35,  0,255, 188, 33,  0,255,
	184, 31,  0,255, 180, 28,  0,255, 177, 26,  0,255, 172, 24,  0,255,
	168, 22,  0,255, 164, 20,  0,255, 160, 18,  0,255, 156, 16,  0,255,
	153, 13,  0,255, 148, 11,  0,255, 145,  9,  0,255, 140,  7,  0,255,
};

/* ************************************************************************* */
/* Per dataset state */

typedef struct dr_ds {
	DasDs*  pDs;
	int     nPainted;      /* records painted so far */

	DasVar* pTime;         /* time point var, NULL when REF+OFFSET */
	DasVar* pRef;
	DasVar* pOff;
	bool    bOffVaries;    /* offsets differ record to record */

	DasVar* pY;            /* spectrogram y coordinate */
	DasVar* pData;

	bool    bFill;
	double  rFill;         /* fill, through the same double conversion as data */

	/* Spectrogram bins: edges in y axis space, then rows in the image */
	int     nBins;
	double* pLo;
	double* pHi;
	double* pMid;
	int*    pRow0;         /* first row, inclusive, 0 at the top */
	int*    pRow1;         /* last row, exclusive */

	/* Density offset cache, pixels from the reference time */
	int     nOff;
	double* pOffPx;
} dr_ds;

struct das_render {
	StreamHandler hndlr;
	int nW;
	int nH;
	int nKind;

	bool   bHaveX;
	double rT0;            /* us2000 */
	double rT1;
	double rPxPerUs;

	ubyte  aMap[256*4];
	float*    pVal;        /* spectrogram grid */
	uint32_t* pCount;      /* density grid */
	uint32_t  uMaxCount;
	ubyte*    pRgba;
	bool      bDirty;

	double rPaintMs;
	double rValues;        /* values painted, repaints included */
	int    nRescales;
	int    nSkipped;
	char   sNote[DR_NOTE_SZ];

	/* Signature of the first dataset, by DasDim_dim names */
	char sTimeDim[DR_DIM_SZ];
	char sYDim[DR_DIM_SZ];
	char sDataDim[DR_DIM_SZ];

	/* Vertical axis, in axis space (log10 when log) */
	bool   bYLog;
	bool   bYSet;
	double rYMin;
	double rYMax;
	das_units yUnits;

	/* Color axis, spectrograms only */
	bool   bZLog;
	bool   bZSet;
	double rZMin;
	double rZMax;
	das_units zUnits;

	/* Density outlier tracking since the last refit */
	uint64_t nPts;
	uint64_t nBelow;
	uint64_t nAbove;

	int  nMinCol;           /* leftmost column painted */
	int  nMaxCol;           /* rightmost column painted */
	bool bNarrowDue;        /* crossed DR_NARROW_AT, refit not yet done */
	bool bNarrowed;

	dr_ds* pDs;
	int    nDs;
	int    nDsAlloc;
};

/* ************************************************************************* */
/* Small helpers */

static double _now_ms(void)
{
#ifdef __EMSCRIPTEN__
	return emscripten_get_now();
#else
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1e3 + ts.tv_nsec * 1e-6;
#endif
}

static void _note(DasRender* pThis, const char* sFmt, ...)
{
	va_list ap;
	va_start(ap, sFmt);
	vsnprintf(pThis->sNote, DR_NOTE_SZ, sFmt, ap);
	va_end(ap);
}

/* Inline the two types that matter; anything else goes through das2C */
static inline bool _val(const ubyte* p, das_val_type vt, double* pOut)
{
	switch(vt){
	case vtFloat:  *pOut = *((const float*)p);  return true;
	case vtDouble: *pOut = *((const double*)p); return true;
	default: return das_elem_asDouble((das_elem_type)vt, p, pOut);
	}
}

static bool _toUs2000(const ubyte* p, das_val_type vt, das_units units, double* pOut)
{
	if(vt == vtTime){
		*pOut = Units_convertFromDt(UNIT_US2000, (const das_time*)p);
		return true;
	}
	double r;
	if(!_val(p, vt, &r)) return false;
	*pOut = Units_convertTo(UNIT_US2000, r, units);
	return true;
}

/* Lend the elements of a subset; NULL with *pN = 0 if empty */
static const ubyte* _elems(const DasAry* pAry, size_t* pN)
{
	*pN = 0;
	if(pAry == NULL) return NULL;
	return DasAry_getIn(pAry, DasAry_valType(pAry), DIM0, pN);
}

/* One record of a variable, all items.  nItems ignored for rank 1. */
static DasAry* _record(const DasVar* pVar, int nRank, ptrdiff_t iRec, ptrdiff_t nItems)
{
	ptrdiff_t aMin[2] = {iRec, 0};
	ptrdiff_t aMax[2] = {iRec + 1, nItems};
	return DasVar_subset(pVar, nRank, aMin, aMax, NULL);
}

/* One value at a record, for things degenerate in index 1.  A subset
 * can't do this: das2C refuses to output a rank 0 array.  One DasVar_get
 * per record is cheap; it's per sample that would hurt. */
static bool _timeAt(const DasVar* pVar, ptrdiff_t iRec, double* pUs)
{
	ptrdiff_t aLoc[VARIDX_MAX] = {0};
	aLoc[0] = iRec;
	das_byte_seq work = {NULL, 0};
	das_datum dm;
	if(DasVar_get(pVar, aLoc, work, &dm) != 0) return false;
	return das_datum_toEpoch(&dm, UNIT_US2000, pUs);
}

static bool _valAt(const DasVar* pVar, ptrdiff_t iRec, double* pOut)
{
	ptrdiff_t aLoc[VARIDX_MAX] = {0};
	aLoc[0] = iRec;
	das_byte_seq work = {NULL, 0};
	das_datum dm;
	if(DasVar_get(pVar, aLoc, work, &dm) != 0) return false;
	return das_datum_toDbl(&dm, pOut);
}

static ptrdiff_t _nRecs(const DasDs* pDs)
{
	ptrdiff_t aShape[VARIDX_MAX];
	DasDs_shape(pDs, aShape);
	return aShape[0] < 0 ? 0 : aShape[0];
}

static ptrdiff_t _nItems(const DasDs* pDs, ptrdiff_t iRec)
{
	if(DasDs_rank(pDs) < 2) return 1;
	ptrdiff_t aLoc[1] = {iRec};
	return DasDs_lengthIn(pDs, 1, aLoc);
}

static const char* _axis(const DasDim* pDim)
{
	const char* s = DasDim_getAxis(pDim, 0);
	return s == NULL ? "" : s;
}

/* Log or linear: the dimension's own scaleType, else the stream's
 * <axis>ScaleType.  das3 streams keep it on the stream; the das2
 * upconverter has already moved it onto the dimension. */
static bool _isLog(const DasDim* pDim, const DasStream* pSd)
{
	const char* s = DasDesc_getStr((const DasDesc*)pDim, "scaleType");
	if((s == NULL)&&(pSd != NULL)&&(_axis(pDim)[0] != '\0')){
		char sName[32];
		snprintf(sName, sizeof(sName), "%sScaleType", _axis(pDim));
		s = DasDesc_getStr((const DasDesc*)pSd, sName);
	}
	return (s != NULL)&&(strcasecmp(s, "log") == 0);
}

/* ************************************************************************* */
/* Construction */

DasRender* new_DasRender(int nWidth, int nHeight)
{
	if((nWidth < DR_MIN_SZ)||(nWidth > DR_MAX_SZ)||(nHeight < DR_MIN_SZ)||(nHeight > DR_MAX_SZ)){
		das_error(DASERR_VALUE, "Image size %d x %d is outside %d to %d", nWidth,
			nHeight, DR_MIN_SZ, DR_MAX_SZ);
		return NULL;
	}
	DasRender* pThis = (DasRender*)calloc(1, sizeof(DasRender));
	size_t uPx = (size_t)nWidth * (size_t)nHeight;
	if(pThis != NULL){
		pThis->pVal   = (float*)malloc(uPx * sizeof(float));
		pThis->pCount = (uint32_t*)calloc(uPx, sizeof(uint32_t));
		pThis->pRgba  = (ubyte*)malloc(uPx * 4);
	}
	if((pThis == NULL)||(pThis->pVal == NULL)||(pThis->pCount == NULL)||(pThis->pRgba == NULL)){
		das_error(DASERR_VALUE, "Couldn't allocate a %d x %d image", nWidth, nHeight);
		del_DasRender(pThis);
		return NULL;
	}
	pThis->nW = nWidth;
	pThis->nH = nHeight;
	for(size_t u = 0; u < uPx; ++u){
		pThis->pVal[u] = -INFINITY;
		pThis->pRgba[u*4] = pThis->pRgba[u*4+1] = pThis->pRgba[u*4+2] = 0;
		pThis->pRgba[u*4+3] = 255;
	}
	memcpy(pThis->aMap, g_aDefMap, sizeof(pThis->aMap));
	pThis->nMinCol = INT32_MAX;
	pThis->nMaxCol = -1;
	return pThis;
}

static void _freeDs(dr_ds* p)
{
	free(p->pLo); free(p->pHi); free(p->pMid); free(p->pRow0); free(p->pRow1);
	free(p->pOffPx);
	memset(p, 0, sizeof(dr_ds));
}

void del_DasRender(DasRender* pThis)
{
	if(pThis == NULL) return;
	for(int i = 0; i < pThis->nDs; ++i) _freeDs(pThis->pDs + i);
	free(pThis->pDs);
	free(pThis->pVal);
	free(pThis->pCount);
	free(pThis->pRgba);
	free(pThis);
}

int DasRender_setMap(DasRender* pThis, const ubyte* pRgba)
{
	if(pRgba == NULL) return das_error(DASERR_VALUE, "NULL color map");
	memcpy(pThis->aMap, pRgba, sizeof(pThis->aMap));
	pThis->bDirty = true;
	return DAS_OKAY;
}

/* ************************************************************************* */
/* Painting, spectrogram */

/* Row spans for one dataset's bins under the current y range.  Spans
 * reach halfway to neighbors (already in pLo/pHi) but at most DR_SPAN_CAP
 * rows each way from the center row, and always cover the center row. */
static void _spanRows(DasRender* pThis, dr_ds* pD)
{
	double rSpan = pThis->rYMax - pThis->rYMin;
	int nH = pThis->nH;
	for(int b = 0; b < pD->nBins; ++b){
		if(isnan(pD->pMid[b]) || (rSpan <= 0)){
			pD->pRow0[b] = pD->pRow1[b] = 0;
			continue;
		}
		int nMid = (int)floor((pThis->rYMax - pD->pMid[b]) / rSpan * nH);
		int n0 = (int)floor((pThis->rYMax - pD->pHi[b]) / rSpan * nH);
		int n1 = (int)ceil((pThis->rYMax - pD->pLo[b]) / rSpan * nH);
		if(nMid >= nH) nMid = nH - 1;   /* the bottom edge itself */
		if(n0 < nMid - DR_SPAN_CAP) n0 = nMid - DR_SPAN_CAP;
		if(n1 > nMid + DR_SPAN_CAP + 1) n1 = nMid + DR_SPAN_CAP + 1;
		if(n0 > nMid) n0 = nMid;
		if(n1 <= nMid) n1 = nMid + 1;
		if(n0 < 0) n0 = 0;
		if(n1 > nH) n1 = nH;
		pD->pRow0[b] = n0;
		pD->pRow1[b] = n1;
	}
}

static int _cmpDbl(const void* a, const void* b)
{
	double x = *(const double*)a, y = *(const double*)b;
	return (x < y) ? -1 : ((x > y) ? 1 : 0);
}

/* Bin edges in axis space, halfway to each neighbor.  How far a bin may
 * actually stretch is limited in pixels, by _spanRows(), since that's
 * what "short distance" means on screen.  Returns false if no usable
 * centers. */
static bool _binEdges(DasRender* pThis, dr_ds* pD, const double* pCtr, int nBins)
{
	pD->nBins = nBins;
	pD->pLo   = (double*)malloc(nBins * sizeof(double));
	pD->pHi   = (double*)malloc(nBins * sizeof(double));
	pD->pMid  = (double*)malloc(nBins * sizeof(double));
	pD->pRow0 = (int*)calloc(nBins, sizeof(int));
	pD->pRow1 = (int*)calloc(nBins, sizeof(int));
	double* pSorted = (double*)malloc(nBins * sizeof(double));
	if(!pD->pLo || !pD->pHi || !pD->pMid || !pD->pRow0 || !pD->pRow1 || !pSorted){
		free(pSorted);
		return false;
	}

	int nGood = 0;
	for(int b = 0; b < nBins; ++b){
		double r = pCtr[b];
		if(pThis->bYLog) r = (r > 0) ? log10(r) : NAN;
		pD->pMid[b] = r;
		if(!isnan(r)) pSorted[nGood++] = r;
	}
	if(nGood == 0){ free(pSorted); return false; }
	qsort(pSorted, nGood, sizeof(double), _cmpDbl);

	/* For each bin find its sorted neighbors by value.  Bins are few (tens
	 * to a few hundred) and this runs once per header, so a search is fine. */
	for(int b = 0; b < nBins; ++b){
		double r = pD->pMid[b];
		if(isnan(r)) continue;
		double rBelow = NAN, rAbove = NAN;
		for(int i = 0; i < nGood; ++i){
			if(pSorted[i] < r) rBelow = pSorted[i];
			else if((pSorted[i] > r)&&isnan(rAbove)) rAbove = pSorted[i];
		}
		double rDn = isnan(rBelow) ? NAN : (r - rBelow)/2;
		double rUp = isnan(rAbove) ? NAN : (rAbove - r)/2;
		if(isnan(rDn)) rDn = isnan(rUp) ? 0 : rUp;   /* outer bins mirror */
		if(isnan(rUp)) rUp = rDn;
		pD->pLo[b] = r - rDn;
		pD->pHi[b] = r + rUp;
	}
	free(pSorted);
	return true;
}

static void _paintSpectro(DasRender* pThis, dr_ds* pD, ptrdiff_t iRec)
{
	int nRank = DasDs_rank(pD->pDs);

	DasVar* pT = (pD->pTime != NULL) ? pD->pTime : pD->pRef;
	double rT;
	if(!_timeAt(pT, iRec, &rT)) return;
	size_t uN = 0;

	int nCol = (int)floor((rT - pThis->rT0) * pThis->rPxPerUs);
	if((nCol < 0)||(nCol >= pThis->nW)) return;

	DasAry* pZAry = _record(pD->pData, nRank, iRec, pD->nBins);
	const ubyte* pZ = _elems(pZAry, &uN);
	if(pZ == NULL){ if(pZAry) dec_DasAry(pZAry); return; }
	das_val_type vt = DasAry_valType(pZAry);
	size_t uSz = das_vt_size(vt);
	if(uN > (size_t)pD->nBins) uN = pD->nBins;

	int nW = pThis->nW;
	float* pGrid = pThis->pVal;
	bool bAny = false;
	for(size_t b = 0; b < uN; ++b){
		double r;
		if(!_val(pZ + b*uSz, vt, &r) || isnan(r)) continue;
		if(pD->bFill && (r == pD->rFill)) continue;
		if(pThis->bZLog){
			if(r <= 0) continue;
			r = log10(r);
		}
		float f = (float)r;
		++(pThis->rValues);
		for(int nRow = pD->pRow0[b]; nRow < pD->pRow1[b]; ++nRow){
			float* p = pGrid + (size_t)nRow*nW + nCol;
			if(f > *p) *p = f;
		}
		bAny = true;
	}
	dec_DasAry(pZAry);

	if(bAny){
		pThis->bDirty = true;
		if(nCol > pThis->nMaxCol) pThis->nMaxCol = nCol;
		if(nCol < pThis->nMinCol) pThis->nMinCol = nCol;
	}
}

/* ************************************************************************* */
/* Painting, density */

/* Offsets of one record in pixels; cached while they don't vary */
static bool _offsets(DasRender* pThis, dr_ds* pD, ptrdiff_t iRec, ptrdiff_t nItems)
{
	if(!pD->bOffVaries && (pD->nOff == nItems) && (pD->pOffPx != NULL))
		return true;

	if(nItems == 1){
		double r;
		double* pNew = (double*)realloc(pD->pOffPx, sizeof(double));
		if((pNew == NULL)||!_valAt(pD->pOff, pD->bOffVaries ? iRec : 0, &r)) return false;
		pD->pOffPx = pNew;
		pNew[0] = Units_convertTo(UNIT_MICROSECONDS, r, DasVar_units(pD->pOff)) * pThis->rPxPerUs;
		pD->nOff = 1;
		return true;
	}

	int nRank = DasDs_rank(pD->pDs);
	DasAry* pAry = _record(pD->pOff, nRank, pD->bOffVaries ? iRec : 0, nItems);
	size_t uN = 0;
	const ubyte* p = _elems(pAry, &uN);
	if((p == NULL)||(uN < (size_t)nItems)){
		if(pAry) dec_DasAry(pAry);
		return false;
	}
	das_val_type vt = DasAry_valType(pAry);
	size_t uSz = das_vt_size(vt);
	das_units units = DasVar_units(pD->pOff);

	double* pNew = (double*)realloc(pD->pOffPx, nItems * sizeof(double));
	if(pNew == NULL){ dec_DasAry(pAry); return false; }
	pD->pOffPx = pNew;
	for(ptrdiff_t i = 0; i < nItems; ++i){
		double r = 0;
		_val(p + i*uSz, vt, &r);
		pNew[i] = Units_convertTo(UNIT_MICROSECONDS, r, units) * pThis->rPxPerUs;
	}
	pD->nOff = (int)nItems;
	dec_DasAry(pAry);
	return true;
}

static inline void _densityPoint(DasRender* pThis, double rX, double r)
{
	int nCol = (int)floor(rX);
	if((nCol < 0)||(nCol >= pThis->nW)) return;

	++(pThis->nPts);
	++(pThis->rValues);
	double rSpan = pThis->rYMax - pThis->rYMin;
	if(r < pThis->rYMin){ ++(pThis->nBelow); return; }
	if(r > pThis->rYMax){ ++(pThis->nAbove); return; }

	double rFrac = (pThis->rYMax - r) / rSpan;   /* 0 at the top */
	int nRow = (int)(rFrac * pThis->nH);
	if(nRow >= pThis->nH) nRow = pThis->nH - 1;

	uint32_t* p = pThis->pCount + (size_t)nRow*pThis->nW + nCol;
	if(++(*p) > pThis->uMaxCount) pThis->uMaxCount = *p;
	if(nCol > pThis->nMaxCol) pThis->nMaxCol = nCol;
	if(nCol < pThis->nMinCol) pThis->nMinCol = nCol;
}

static void _paintDensity(DasRender* pThis, dr_ds* pD, ptrdiff_t iRec)
{
	int nRank = DasDs_rank(pD->pDs);
	ptrdiff_t nItems = _nItems(pD->pDs, iRec);
	if(nItems <= 0) return;

	/* One item per record (a plain time series) can't be subset, see
	 * _timeAt(), so read it as a datum */
	DasAry* pVAry = NULL;
	size_t uN = 0;
	const ubyte* pV = NULL;
	double rOne;
	das_val_type vt = vtDouble;
	if(nItems == 1){
		if(!_valAt(pD->pData, iRec, &rOne)) return;
		pV = (const ubyte*)&rOne;
		uN = 1;
	}
	else{
		pVAry = _record(pD->pData, nRank, iRec, nItems);
		pV = _elems(pVAry, &uN);
		if(pV == NULL){ if(pVAry) dec_DasAry(pVAry); return; }
		vt = DasAry_valType(pVAry);
		if(uN > (size_t)nItems) uN = nItems;
	}
	size_t uSz = das_vt_size(vt);

	/* Time: base per record, plus offsets or per-item times */
	double rBase = 0;
	DasAry* pTAry = NULL;
	const ubyte* pT = NULL;
	das_val_type vtT = vtUnknown;
	size_t uTSz = 0;
	bool bOk = true;

	if(pD->pRef != NULL){
		bOk = _timeAt(pD->pRef, iRec, &rBase) && _offsets(pThis, pD, iRec, (ptrdiff_t)uN);
	}
	else if((nRank < 2)||(nItems == 1)||DasVar_degenerate(pD->pTime, 1)){
		bOk = _timeAt(pD->pTime, iRec, &rBase);
	}
	else{
		/* Times that vary within the record: the slow path */
		pTAry = _record(pD->pTime, nRank, iRec, nItems);
		size_t uTN = 0;
		pT = _elems(pTAry, &uTN);
		bOk = (pT != NULL) && (uTN >= uN);
		if(bOk){ vtT = DasAry_valType(pTAry); uTSz = das_vt_size(vtT); }
	}
	if(!bOk){
		if(pTAry) dec_DasAry(pTAry);
		if(pVAry) dec_DasAry(pVAry);
		return;
	}

	double rBasePx = (rBase - pThis->rT0) * pThis->rPxPerUs;
	das_units tUnits = (pD->pTime != NULL) ? DasVar_units(pD->pTime) : NULL;
	bool bLog = pThis->bYLog;

	uint64_t nBefore = pThis->nPts;
	for(size_t i = 0; i < uN; ++i){
		double r;
		if(!_val(pV + i*uSz, vt, &r) || isnan(r)) continue;
		if(pD->bFill && (r == pD->rFill)) continue;
		if(bLog){
			if(r <= 0) continue;
			r = log10(r);
		}
		double rX;
		if(pD->pRef != NULL)
			rX = rBasePx + pD->pOffPx[i];
		else if(pT != NULL){
			double rT;
			if(!_toUs2000(pT + i*uTSz, vtT, tUnits, &rT)) continue;
			rX = (rT - pThis->rT0) * pThis->rPxPerUs;
		}
		else
			rX = rBasePx;
		_densityPoint(pThis, rX, r);
	}
	if(pThis->nPts > nBefore) pThis->bDirty = true;

	if(pTAry) dec_DasAry(pTAry);
	if(pVAry) dec_DasAry(pVAry);
}

/* ************************************************************************* */
/* Ranges */

/* Value range of the new records of a dataset, for the very first density
 * range.  Ignores X so a stream starting before the window still seeds.
 * With pHist NULL finds min and max; otherwise histograms the values over
 * the [*pMin, *pMax] found by a first call, for a percentile fit that
 * keeps a single spike from setting the scale. */
static bool _scanRange(DasRender* pThis, dr_ds* pD, ptrdiff_t iBeg, ptrdiff_t iEnd,
	uint32_t* pHist, double* pMin, double* pMax)
{
	double rW = pHist ? (*pMax - *pMin) / DR_HIST : 0;
	int nRank = DasDs_rank(pD->pDs);
	bool bAny = false;
	for(ptrdiff_t iRec = iBeg; iRec < iEnd; ++iRec){
		ptrdiff_t nItems = _nItems(pD->pDs, iRec);
		if(nItems <= 0) continue;
		DasAry* pAry = NULL;
		size_t uN = 0;
		const ubyte* p = NULL;
		double rOne;
		das_val_type vt = vtDouble;
		if(nItems == 1){
			if(_valAt(pD->pData, iRec, &rOne)){ p = (const ubyte*)&rOne; uN = 1; }
		}
		else{
			pAry = _record(pD->pData, nRank, iRec, nItems);
			p = _elems(pAry, &uN);
			if(pAry) vt = DasAry_valType(pAry);
		}
		if(p != NULL){
			size_t uSz = das_vt_size(vt);
			for(size_t i = 0; i < uN; ++i){
				double r;
				if(!_val(p + i*uSz, vt, &r) || isnan(r)) continue;
				if(pD->bFill && (r == pD->rFill)) continue;
				if(pThis->bYLog){
					if(r <= 0) continue;
					r = log10(r);
				}
				if(pHist){
					int iBin = (rW > 0) ? (int)((r - *pMin) / rW) : 0;
					if(iBin >= DR_HIST) iBin = DR_HIST - 1;
					if(iBin >= 0) ++pHist[iBin];
				}
				else{
					if(!bAny || (r < *pMin)) *pMin = r;
					if(!bAny || (r > *pMax)) *pMax = r;
				}
				bAny = true;
			}
		}
		if(pAry) dec_DasAry(pAry);
	}
	return bAny;
}

/* Pad a fitted range; a flat one gets a nominal width */
static void _padRange(double* pMin, double* pMax)
{
	double rSpan = *pMax - *pMin;
	if(rSpan <= 0){
		rSpan = fabs(*pMin) > 0 ? fabs(*pMin) * 0.2 : 1.0;
		*pMin -= rSpan/2;
		*pMax += rSpan/2;
		return;
	}
	*pMin -= rSpan * DR_PAD;
	*pMax += rSpan * DR_PAD;
}

/* Percentile span of a histogram over [rLo, rHi] */
static void _histFit(
	const uint32_t* pHist, int nBins, double rLo, double rHi, double* pMin, double* pMax
){
	uint64_t nTot = 0;
	for(int i = 0; i < nBins; ++i) nTot += pHist[i];
	uint64_t nCut = (uint64_t)(nTot * DR_TAIL);
	double rW = (rHi - rLo) / nBins;

	*pMin = rLo;
	*pMax = rHi;
	uint64_t nCum = 0;
	for(int i = 0; i < nBins; ++i){
		nCum += pHist[i];
		if(nCum > nCut){ *pMin = rLo + i*rW; break; }
	}
	nCum = 0;
	for(int i = nBins - 1; i >= 0; --i){
		nCum += pHist[i];
		if(nCum > nCut){ *pMax = rLo + (i+1)*rW; break; }
	}
	_padRange(pMin, pMax);
}

/* Exact percentile fit over records [iBeg, iEnd) of every dataset, iEnd < 0
 * meaning all painted records.  Two passes: extremes, then a histogram
 * between them.  A refit is followed by a full repaint, so reading
 * everything twice more costs the same order as the repaint itself. */
static bool _densityFit(DasRender* pThis, dr_ds* pOnly, ptrdiff_t iBeg, ptrdiff_t iEnd,
	double* pMin, double* pMax)
{
	bool bAny = false;
	double rMin = 0, rMax = 0;
	for(int i = 0; i < pThis->nDs; ++i){
		dr_ds* pD = pThis->pDs + i;
		if(pOnly && (pD != pOnly)) continue;
		double rLo, rHi;
		if(!_scanRange(pThis, pD, iBeg, (iEnd < 0) ? pD->nPainted : iEnd, NULL, &rLo, &rHi))
			continue;
		if(!bAny || (rLo < rMin)) rMin = rLo;
		if(!bAny || (rHi > rMax)) rMax = rHi;
		bAny = true;
	}
	if(!bAny) return false;

	uint32_t* pHist = (uint32_t*)calloc(DR_HIST, sizeof(uint32_t));
	if(pHist == NULL) return false;
	for(int i = 0; i < pThis->nDs; ++i){
		dr_ds* pD = pThis->pDs + i;
		if(pOnly && (pD != pOnly)) continue;
		double rLo = rMin, rHi = rMax;
		_scanRange(pThis, pD, iBeg, (iEnd < 0) ? pD->nPainted : iEnd, pHist, &rLo, &rHi);
	}
	_histFit(pHist, DR_HIST, rMin, rMax, pMin, pMax);
	free(pHist);
	return true;
}

static void _resetDensityStats(DasRender* pThis)
{
	pThis->nPts = pThis->nBelow = pThis->nAbove = 0;
}

/* Clear the grids and paint every retained record again.  Used after
 * anything that moves pixels: a wider y coordinate or a density value
 * refit.  Only ever called from inside a stream callback, where the
 * datasets are known to be alive. */
static void _repaint(DasRender* pThis)
{
	size_t uPx = (size_t)pThis->nW * pThis->nH;
	if(pThis->nKind == DASRENDER_SPECTRO){
		for(size_t u = 0; u < uPx; ++u) pThis->pVal[u] = -INFINITY;
	}
	else{
		memset(pThis->pCount, 0, uPx * sizeof(uint32_t));
		pThis->uMaxCount = 0;
		_resetDensityStats(pThis);
	}
	pThis->nMinCol = INT32_MAX;
	pThis->nMaxCol = -1;
	pThis->bDirty = true;

	for(int i = 0; i < pThis->nDs; ++i){
		dr_ds* pD = pThis->pDs + i;
		pD->nOff = 0;      /* pixel scale may have changed */
		pD->nPainted = 0;
		if(!pThis->bHaveX || !pThis->bYSet) continue;
		ptrdiff_t nRecs = _nRecs(pD->pDs);
		for(ptrdiff_t r = 0; r < nRecs; ++r){
			if(pThis->nKind == DASRENDER_SPECTRO) _paintSpectro(pThis, pD, r);
			else _paintDensity(pThis, pD, r);
		}
		pD->nPainted = (int)nRecs;
	}
}

/* Has the paint covered DR_NARROW_AT of the width?  Measured from the
 * first column painted, not the left edge: data may start late in the
 * window, and narrowing on the first record alone would be premature. */
static void _checkNarrow(DasRender* pThis)
{
	if(!pThis->bNarrowed && (pThis->nMaxCol >= 0)
	   && (pThis->nMaxCol - pThis->nMinCol >= pThis->nW * DR_NARROW_AT))
		pThis->bNarrowDue = true;
}

/* Density outlier rule and the one-time narrowing; run after each packet */
static void _densityCheck(DasRender* pThis)
{
	_checkNarrow(pThis);

	uint64_t nOut = pThis->nBelow + pThis->nAbove;
	bool bWiden = (pThis->nPts >= DR_MIN_PTS) && (nOut > pThis->nPts * DR_OUT_FRAC);
	if(!bWiden && !pThis->bNarrowDue) return;

	double rMin, rMax;
	if(!_densityFit(pThis, NULL, 0, -1, &rMin, &rMax)) return;

	if(pThis->bNarrowDue){
		pThis->bNarrowDue = false;
		pThis->bNarrowed = true;
		/* Skip a refit that would barely move anything */
		double rOld = pThis->rYMax - pThis->rYMin;
		if(!bWiden && (fabs(rMin - pThis->rYMin) < rOld*0.1) && (fabs(rMax - pThis->rYMax) < rOld*0.1))
			return;
	}
	pThis->rYMin = rMin;
	pThis->rYMax = rMax;
	++(pThis->nRescales);
	_repaint(pThis);
}

/* Spectrogram color range from the painted pixels themselves, run at
 * colorize time.  Returns false if nothing is painted. */
static bool _spectroZCheck(DasRender* pThis)
{
	size_t uPx = (size_t)pThis->nW * pThis->nH;
	const float* pGrid = pThis->pVal;
	uint64_t nPainted = 0, nOut = 0;
	float fMin = INFINITY, fMax = -INFINITY;
	for(size_t u = 0; u < uPx; ++u){
		float f = pGrid[u];
		if(f == -INFINITY) continue;
		++nPainted;
		if(f < fMin) fMin = f;
		if(f > fMax) fMax = f;
		if((f < pThis->rZMin)||(f > pThis->rZMax)) ++nOut;
	}
	if(nPainted == 0) return false;

	_checkNarrow(pThis);

	bool bFit = !pThis->bZSet || pThis->bNarrowDue
		|| ((nPainted >= DR_MIN_PTS)&&(nOut > nPainted * DR_OUT_FRAC));
	if(!bFit) return true;

	/* Exact percentiles: histogram over the painted min to max */
	uint32_t aHist[DR_HIST] = {0};
	double rW = ((double)fMax - fMin) / DR_HIST;
	for(size_t u = 0; u < uPx; ++u){
		float f = pGrid[u];
		if(f == -INFINITY) continue;
		int i = (rW > 0) ? (int)((f - fMin) / rW) : 0;
		if(i >= DR_HIST) i = DR_HIST - 1;
		++aHist[i];
	}
	double rMin, rMax;
	_histFit(aHist, DR_HIST, fMin, fMax, &rMin, &rMax);

	if(pThis->bNarrowDue){ pThis->bNarrowDue = false; pThis->bNarrowed = true; }
	pThis->rZMin = rMin;
	pThis->rZMax = rMax;
	pThis->bZSet = true;
	++(pThis->nRescales);
	return true;
}

/* ************************************************************************* */
/* Stream callbacks */

static DasDim* _dimByName(DasDs* pDs, const char* sDim, enum dim_type dt)
{
	size_t uDims = DasDs_numDims(pDs, dt);
	for(size_t u = 0; u < uDims; ++u){
		DasDim* pDim = DasDs_getDimByIdx(pDs, u, dt);
		if(strcmp(DasDim_dim(pDim), sDim) == 0) return pDim;
	}
	return NULL;
}

/* The time coordinate: axis x if marked, else a dimension named time */
static DasDim* _timeDim(DasDs* pDs)
{
	size_t uDims = DasDs_numDims(pDs, DASDIM_COORD);
	for(size_t u = 0; u < uDims; ++u){
		DasDim* pDim = DasDs_getDimByIdx(pDs, u, DASDIM_COORD);
		if(strcmp(_axis(pDim), "x") == 0) return pDim;
	}
	return DasDs_getDim(pDs, "time", DASDIM_COORD);
}

static DasDim* _yDim(DasDs* pDs, const DasDim* pTime)
{
	size_t uDims = DasDs_numDims(pDs, DASDIM_COORD);
	for(size_t u = 0; u < uDims; ++u){
		DasDim* pDim = DasDs_getDimByIdx(pDs, u, DASDIM_COORD);
		if((pDim != pTime)&&(strcmp(_axis(pDim), "y") == 0)) return pDim;
	}
	return NULL;
}

/* First data dimension with numeric values */
static DasDim* _dataDim(DasDs* pDs)
{
	size_t uDims = DasDs_numDims(pDs, DASDIM_DATA);
	for(size_t u = 0; u < uDims; ++u){
		DasDim* pDim = DasDs_getDimByIdx(pDs, u, DASDIM_DATA);
		DasVar* pVar = DasDim_getPointVar(pDim);
		if((pVar != NULL)&&DasVar_isNumeric(pVar)&&(DasVar_valType(pVar) != vtTime))
			return pDim;
	}
	return NULL;
}

/* Fill in the per dataset variables; sets sNote and returns false if this
 * dataset can't be painted */
static bool _bindDs(DasRender* pThis, DasDs* pDs, DasDim* pTDim, DasDim* pYDim,
	DasDim* pZDim, dr_ds* pD)
{
	memset(pD, 0, sizeof(dr_ds));
	pD->pDs = pDs;

	if(DasDs_rank(pDs) > 2){
		_note(pThis, "%s: rank %d datasets aren't painted", DasDs_id(pDs), DasDs_rank(pDs));
		return false;
	}

	/* Prefer REF + OFFSET over the point var, which for waveforms is a
	 * binop and slow to read in bulk */
	pD->pRef = DasDim_getVar(pTDim, DASVAR_REF);
	pD->pOff = DasDim_getVar(pTDim, DASVAR_OFFSET);
	if((pD->pRef == NULL)||(pD->pOff == NULL)){
		pD->pRef = pD->pOff = NULL;
		pD->pTime = DasDim_getPointVar(pTDim);
	}
	else
		pD->bOffVaries = !DasVar_degenerate(pD->pOff, 0);

	DasVar* pTVar = pD->pTime ? pD->pTime : pD->pRef;
	if((pTVar == NULL)||!Units_haveCalRep(DasVar_units(pTVar))){
		_note(pThis, "%s: no calendar time coordinate", DasDs_id(pDs));
		return false;
	}

	pD->pData = DasDim_getPointVar(pZDim);
	DasAry* pAry = DasVar_getAry(pD->pData);
	if(pAry != NULL){
		const ubyte* pFill = DasAry_getFill(pAry);
		if(pFill != NULL)
			pD->bFill = _val(pFill, DasAry_valType(pAry), &(pD->rFill));
	}

	if(pYDim == NULL) return true;

	/* Spectrogram: y coordinate values from the header */
	pD->pY = DasDim_getPointVar(pYDim);
	if((pD->pY == NULL)||(DasDs_rank(pDs) < 2)){
		_note(pThis, "%s: no usable y coordinate", DasDs_id(pDs));
		return false;
	}
	if(!DasVar_degenerate(pD->pY, 0)){
		_note(pThis, "%s: y coordinates that vary by record aren't painted yet", DasDs_id(pDs));
		return false;
	}
	ptrdiff_t aShape[VARIDX_MAX];
	DasVar_shape(pD->pY, aShape);
	if(aShape[1] <= 0){
		_note(pThis, "%s: ragged y coordinates aren't painted", DasDs_id(pDs));
		return false;
	}
	int nBins = (int)aShape[1];
	DasAry* pYAry = _record(pD->pY, 2, 0, nBins);
	size_t uN = 0;
	const ubyte* p = _elems(pYAry, &uN);
	double* pCtr = (double*)malloc(nBins * sizeof(double));
	bool bOk = (p != NULL) && (uN >= (size_t)nBins) && (pCtr != NULL);
	if(bOk){
		das_val_type vt = DasAry_valType(pYAry);
		size_t uSz = das_vt_size(vt);
		das_units units = DasVar_units(pD->pY);
		bool bConv = (pThis->yUnits != NULL)&&(units != pThis->yUnits)
		             && Units_canConvert(units, pThis->yUnits);
		for(int b = 0; b < nBins; ++b){
			double r = NAN;
			_val(p + b*uSz, vt, &r);
			pCtr[b] = bConv ? Units_convertTo(pThis->yUnits, r, units) : r;
		}
		bOk = _binEdges(pThis, pD, pCtr, nBins);
	}
	free(pCtr);
	if(pYAry) dec_DasAry(pYAry);
	if(!bOk){
		_freeDs(pD);
		_note(pThis, "%s: y coordinates unreadable", DasDs_id(pDs));
		return false;
	}
	return true;
}

/* Decide the picture from the first dataset */
static bool _classify(DasRender* pThis, DasStream* pSd, DasDs* pDs)
{
	DasDim* pT = _timeDim(pDs);
	DasDim* pZ = _dataDim(pDs);
	if((pT == NULL)||(pZ == NULL)){
		_note(pThis, "%s: needs a time coordinate and numeric data", DasDs_id(pDs));
		return false;
	}
	DasDim* pY = _yDim(pDs, pT);

	snprintf(pThis->sTimeDim, DR_DIM_SZ, "%s", DasDim_dim(pT));
	snprintf(pThis->sDataDim, DR_DIM_SZ, "%s", DasDim_dim(pZ));
	DasVar* pZVar = DasDim_getPointVar(pZ);

	if(pY != NULL){
		pThis->nKind = DASRENDER_SPECTRO;
		snprintf(pThis->sYDim, DR_DIM_SZ, "%s", DasDim_dim(pY));
		pThis->bYLog = _isLog(pY, pSd);
		DasVar* pYVar = DasDim_getPointVar(pY);
		pThis->yUnits = (pYVar != NULL) ? DasVar_units(pYVar) : NULL;
		pThis->bZLog = _isLog(pZ, pSd);
		pThis->zUnits = DasVar_units(pZVar);
	}
	else{
		pThis->nKind = DASRENDER_DENSITY;
		pThis->bYLog = _isLog(pZ, pSd);
		pThis->yUnits = DasVar_units(pZVar);
	}
	return true;
}

static DasErrCode _onDsDesc(DasStream* pSd, int nPktId, DasDs* pDs, void* pUser)
{
	DasRender* pThis = (DasRender*)pUser;
	if(pThis->nKind == DASRENDER_UNUSABLE) return DAS_OKAY;

	if(pThis->nKind == DASRENDER_NONE){
		if(!_classify(pThis, pSd, pDs)){
			pThis->nKind = DASRENDER_UNUSABLE;
			return DAS_OKAY;
		}
	}

	/* Same physical dimensions as the first, or skip */
	DasDim* pT = _dimByName(pDs, pThis->sTimeDim, DASDIM_COORD);
	DasDim* pZ = _dimByName(pDs, pThis->sDataDim, DASDIM_DATA);
	DasDim* pY = NULL;
	if(pThis->nKind == DASRENDER_SPECTRO)
		pY = _dimByName(pDs, pThis->sYDim, DASDIM_COORD);
	if((pT == NULL)||(pZ == NULL)||((pThis->nKind == DASRENDER_SPECTRO)&&(pY == NULL))
	   ||(DasDim_getPointVar(pZ) == NULL)){
		++(pThis->nSkipped);
		_note(pThis, "%s: dimensions differ from the first dataset, skipped", DasDs_id(pDs));
		return DAS_OKAY;
	}

	if(pThis->nDs == pThis->nDsAlloc){
		int nNew = pThis->nDsAlloc ? pThis->nDsAlloc * 2 : 8;
		dr_ds* p = (dr_ds*)realloc(pThis->pDs, nNew * sizeof(dr_ds));
		if(p == NULL){ ++(pThis->nSkipped); return DAS_OKAY; }
		pThis->pDs = p;
		pThis->nDsAlloc = nNew;
	}
	dr_ds* pD = pThis->pDs + pThis->nDs;
	if(!_bindDs(pThis, pDs, pT, pY, pZ, pD)){
		/* The first dataset failing makes the picture unusable, later ones
		 * are just skipped */
		if(pThis->nDs == 0) pThis->nKind = DASRENDER_UNUSABLE;
		else ++(pThis->nSkipped);
		return DAS_OKAY;
	}
	++(pThis->nDs);

	/* Spectrogram y range is the union of bin edges; widening repaints */
	if(pThis->nKind == DASRENDER_SPECTRO){
		double rLo = INFINITY, rHi = -INFINITY;
		for(int b = 0; b < pD->nBins; ++b){
			if(isnan(pD->pMid[b])) continue;
			if(pD->pLo[b] < rLo) rLo = pD->pLo[b];
			if(pD->pHi[b] > rHi) rHi = pD->pHi[b];
		}
		if(!pThis->bYSet || (rLo < pThis->rYMin) || (rHi > pThis->rYMax)){
			bool bHadData = pThis->bYSet;
			if(!pThis->bYSet || (rLo < pThis->rYMin)) pThis->rYMin = rLo;
			if(!pThis->bYSet || (rHi > pThis->rYMax)) pThis->rYMax = rHi;
			pThis->bYSet = true;
			for(int i = 0; i < pThis->nDs; ++i) _spanRows(pThis, pThis->pDs + i);
			if(bHadData){
				double t0 = _now_ms();
				_repaint(pThis);
				pThis->rPaintMs += _now_ms() - t0;
				++(pThis->nRescales);
			}
		}
		else
			_spanRows(pThis, pD);
	}
	return DAS_OKAY;
}

static DasErrCode _onDsData(DasStream* pSd, int nPktId, DasDs* pDs, void* pUser)
{
	DasRender* pThis = (DasRender*)pUser;
	if(pThis->nKind <= DASRENDER_NONE) return DAS_OKAY;

	dr_ds* pD = NULL;
	for(int i = 0; i < pThis->nDs; ++i)
		if(pThis->pDs[i].pDs == pDs){ pD = pThis->pDs + i; break; }
	if(pD == NULL) return DAS_OKAY;   /* a skipped dataset */

	ptrdiff_t nRecs = _nRecs(pDs);
	if(nRecs <= pD->nPainted) return DAS_OKAY;

	double t0 = _now_ms();

	/* The first density data set the value range */
	if((pThis->nKind == DASRENDER_DENSITY) && !pThis->bYSet){
		double rMin, rMax;
		if(_densityFit(pThis, pD, pD->nPainted, nRecs, &rMin, &rMax)){
			pThis->rYMin = rMin;
			pThis->rYMax = rMax;
			pThis->bYSet = true;
			_resetDensityStats(pThis);
		}
	}

	if(pThis->bHaveX && pThis->bYSet){
		for(ptrdiff_t r = pD->nPainted; r < nRecs; ++r){
			if(pThis->nKind == DASRENDER_SPECTRO) _paintSpectro(pThis, pD, r);
			else _paintDensity(pThis, pD, r);
		}
		pD->nPainted = (int)nRecs;
		if(pThis->nKind == DASRENDER_DENSITY) _densityCheck(pThis);
	}

	pThis->rPaintMs += _now_ms() - t0;
	return DAS_OKAY;
}

/* The descriptor is about to be freed; forget it.  Its pixels stay, but a
 * later repaint can't redraw them. */
static DasErrCode _onRedef(DasStream* pSd, DasDesc* pDesc, void* pUser)
{
	DasRender* pThis = (DasRender*)pUser;
	for(int i = 0; i < pThis->nDs; ++i){
		if((DasDesc*)(pThis->pDs[i].pDs) != pDesc) continue;
		_freeDs(pThis->pDs + i);
		memmove(pThis->pDs + i, pThis->pDs + i + 1, (pThis->nDs - i - 1) * sizeof(dr_ds));
		--(pThis->nDs);
		break;
	}
	return DAS_OKAY;
}

int DasRender_attach(DasRender* pThis, DasWasmRdr* pRdr)
{
	StreamHandler_init(&(pThis->hndlr), pThis);
	/* StreamHandler_init installs default exception and comment handlers;
	 * the reader's own capture handlers already deal with both */
	pThis->hndlr.exceptionHandler = NULL;
	pThis->hndlr.commentHandler   = NULL;
	pThis->hndlr.dsDescHandler    = _onDsDesc;
	pThis->hndlr.dsDataHandler    = _onDsData;
	pThis->hndlr.pktRedefHandler  = _onRedef;
	return DasWasmRdr_addProcessor(pRdr, &(pThis->hndlr));
}

/* ************************************************************************* */
/* Caller controls and read-outs */

int DasRender_setX(DasRender* pThis, const char* sBeg, const char* sEnd)
{
	das_time dtBeg, dtEnd;
	if((sBeg == NULL)||(sEnd == NULL)||!dt_parsetime(&dtBeg, sBeg)||!dt_parsetime(&dtEnd, sEnd))
		return das_error(DASERR_VALUE, "Couldn't parse time range '%s' to '%s'",
			sBeg ? sBeg : "(null)", sEnd ? sEnd : "(null)");

	double rT0 = Units_convertFromDt(UNIT_US2000, &dtBeg);
	double rT1 = Units_convertFromDt(UNIT_US2000, &dtEnd);
	if(rT1 <= rT0)
		return das_error(DASERR_VALUE, "Time range '%s' to '%s' is empty", sBeg, sEnd);

	/* Repainting here would read datasets outside a stream callback, and
	 * by now the reader that owns them may be gone */
	if(pThis->nDs > 0)
		return das_error(DASERR_VALUE, "Set the time range before data arrive");

	pThis->rT0 = rT0;
	pThis->rT1 = rT1;
	pThis->rPxPerUs = pThis->nW / (rT1 - rT0);
	pThis->bHaveX = true;
	return DAS_OKAY;
}

const ubyte* DasRender_colorize(DasRender* pThis)
{
	size_t uPx = (size_t)pThis->nW * pThis->nH;
	ubyte* pOut = pThis->pRgba;
	const ubyte* pMap = pThis->aMap;

	if(pThis->nKind == DASRENDER_SPECTRO){
		if(_spectroZCheck(pThis)){
			const float* pGrid = pThis->pVal;
			float fMin = (float)pThis->rZMin;
			float fScale = 255.0f / (float)(pThis->rZMax - pThis->rZMin);
			for(size_t u = 0; u < uPx; ++u, pOut += 4){
				float f = pGrid[u];
				if(f == -INFINITY){ pOut[0] = pOut[1] = pOut[2] = 0; pOut[3] = 255; continue; }
				int i = (int)((f - fMin) * fScale);
				if(i < 0) i = 0;
				if(i > 255) i = 255;
				memcpy(pOut, pMap + i*4, 4);
			}
		}
	}
	else if(pThis->nKind == DASRENDER_DENSITY){
		const uint32_t* pGrid = pThis->pCount;
		double rScale = (pThis->uMaxCount > 1) ? 255.0 / log((double)pThis->uMaxCount) : 0;
		for(size_t u = 0; u < uPx; ++u, pOut += 4){
			uint32_t c = pGrid[u];
			if(c == 0){ pOut[0] = pOut[1] = pOut[2] = 0; pOut[3] = 255; continue; }
			int i = (rScale > 0) ? (int)(log((double)c) * rScale) : 255;
			if(i > 255) i = 255;
			memcpy(pOut, pMap + i*4, 4);
		}
	}
	pThis->bDirty = false;
	return pThis->pRgba;
}

int DasRender_kind(const DasRender* pThis){ return pThis->nKind; }

int DasRender_dirty(const DasRender* pThis){ return pThis->bDirty ? 1 : 0; }

double DasRender_paintMs(const DasRender* pThis){ return pThis->rPaintMs; }

double DasRender_values(const DasRender* pThis){ return pThis->rValues; }

int DasRender_rescales(const DasRender* pThis){ return pThis->nRescales; }

int DasRender_skipped(const DasRender* pThis){ return pThis->nSkipped; }

const char* DasRender_note(const DasRender* pThis){ return pThis->sNote; }

double DasRender_range(const DasRender* pThis, int bColor, int bMax)
{
	bool bSet, bLog;
	double r;
	if(bColor){
		if(pThis->nKind != DASRENDER_SPECTRO) return NAN;
		bSet = pThis->bZSet; bLog = pThis->bZLog;
		r = bMax ? pThis->rZMax : pThis->rZMin;
	}
	else{
		bSet = pThis->bYSet; bLog = pThis->bYLog;
		r = bMax ? pThis->rYMax : pThis->rYMin;
	}
	if(!bSet) return NAN;
	return bLog ? pow(10.0, r) : r;
}

int DasRender_isLog(const DasRender* pThis, int bColor)
{
	return (bColor ? pThis->bZLog : pThis->bYLog) ? 1 : 0;
}

const char* DasRender_units(const DasRender* pThis, int bColor)
{
	das_units u = bColor ? pThis->zUnits : pThis->yUnits;
	return (u == NULL) ? "" : Units_toStr(u);
}
