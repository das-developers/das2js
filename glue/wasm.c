/* Copyright (C) 2026 Chris Piker
 *
 * This file is part of das2js, das stream utilities for browsers.
 * See the LICENSE file in the repository root for terms.
 */

/* Implementation of the flat FFI layer, see wasm.h for the contract.
 *
 * Everything here is a projection: no logic beyond bounds checks lives in
 * this file, so a fix in the object model is automatically a fix here.
 */

#define _POSIX_C_SOURCE 200112L

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <math.h>

#include <das3/core.h>
#include <das3/gen_priv.h>
#include <das3/form.h>
#include "wasm.h"

/* ************************************************************************* */
/* Library level */

#define DASWASM_ERR_SZ 1024

void daswasm_init(const char* sProgName)
{
	/* The buffer size argument both sizes the message store and turns on
	 * error saving; without it das_get_error has nothing to report */
	das_init(sProgName, DASERR_DIS_RET, DASWASM_ERR_SZ, DASLOG_WARN, NULL);
}

const char* daswasm_lastError(void)
{
	/* das_get_error returns a heap copy each call; fold it into a static
	 * so the foreign caller borrows rather than owns.  The wasm target is
	 * single threaded, so a static is fine. */
	static char sBuf[DASWASM_ERR_SZ] = {'\0'};

	das_error_msg* pMsg = das_get_error();
	sBuf[0] = '\0';
	if(pMsg != NULL){
		if(pMsg->message != NULL){
			strncpy(sBuf, pMsg->message, DASWASM_ERR_SZ - 1);
			sBuf[DASWASM_ERR_SZ - 1] = '\0';
		}
		das_error_free(pMsg);
	}
	return sBuf;
}

int daswasm_idxRagged(void){ return VARIDX_RAGGED; }

int daswasm_idxUnused(void){ return VARIDX_UNUSED; }

int daswasm_idxBorrow(void){ return VARIDX_BORROW; }

/* ************************************************************************* */
/* Reader context */

#define DASWASM_EXCEPT_SZ 1024

struct das_wasm_rdr {
	DasIO* pIo;
	DasDsBldr* pBldr;
	StreamHandler oobs;        /* progress & exception capture callbacks */
	int nTaskSize;
	int nProgress;
	char sExcept[DASWASM_EXCEPT_SZ];
};

static DasErrCode _DasWasmRdr_onComment(OobComment* pCmt, void* pUser)
{
	DasWasmRdr* pThis = (DasWasmRdr*)pUser;

	if((pCmt->sType == NULL)||(pCmt->sVal == NULL))
		return DAS_OKAY;

	if(strcmp(pCmt->sType, "taskProgress") == 0)
		sscanf(pCmt->sVal, "%d", &(pThis->nProgress));
	else if(strcmp(pCmt->sType, "taskSize") == 0)
		sscanf(pCmt->sVal, "%d", &(pThis->nTaskSize));

	return DAS_OKAY;
}

static DasErrCode _DasWasmRdr_onExcept(OobExcept* pEx, void* pUser)
{
	DasWasmRdr* pThis = (DasWasmRdr*)pUser;

	if(pEx->sMsg != NULL){
		strncpy(pThis->sExcept, pEx->sMsg, DASWASM_EXCEPT_SZ - 1);
		pThis->sExcept[DASWASM_EXCEPT_SZ - 1] = '\0';
	}
	return DAS_OKAY;
}

DasWasmRdr* new_DasWasmRdr(void)
{
	DasWasmRdr* pThis = (DasWasmRdr*)calloc(1, sizeof(DasWasmRdr));
	pThis->nTaskSize = -1;
	pThis->nProgress = -1;

	if((pThis->pIo = new_DasIO_feed("daswasm", "r")) == NULL){
		free(pThis);
		return NULL;
	}
	DasIO_setModel(pThis->pIo, STREAM_MODEL_V3);  /* foreign callers only see the das3 model */

	pThis->pBldr = new_DasDsBldr();
	DasIO_addProcessor(pThis->pIo, (StreamHandler*)pThis->pBldr);

	pThis->oobs.commentHandler = _DasWasmRdr_onComment;
	pThis->oobs.exceptionHandler = _DasWasmRdr_onExcept;
	pThis->oobs.userData = pThis;
	DasIO_addProcessor(pThis->pIo, &(pThis->oobs));

	return pThis;
}

int DasWasmRdr_feed(DasWasmRdr* pThis, const ubyte* pData, int nLen)
{
	if(nLen < 0)
		return das_error(DASERR_IO, "Negative chunk length");
	return DasIO_feed(pThis->pIo, pData, (size_t)nLen);
}

int DasWasmRdr_end(DasWasmRdr* pThis)
{
	return DasIO_feedEnd(pThis->pIo);
}

DasStream* DasWasmRdr_stream(DasWasmRdr* pThis)
{
	return DasDsBldr_getStream(pThis->pBldr);
}

DasStream* DasWasmRdr_take(DasWasmRdr* pThis)
{
	DasStream* pSd = DasDsBldr_getStream(pThis->pBldr);
	DasDsBldr_release(pThis->pBldr);
	return pSd;
}

int DasWasmRdr_progress(const DasWasmRdr* pThis){ return pThis->nProgress; }

int DasWasmRdr_taskSize(const DasWasmRdr* pThis){ return pThis->nTaskSize; }

const char* DasWasmRdr_exception(const DasWasmRdr* pThis){ return pThis->sExcept; }

void del_DasWasmRdr(DasWasmRdr* pThis)
{
	del_DasIO(pThis->pIo);
	del_DasDsBldr(pThis->pBldr);  /* frees the stream too, unless taken */
	free(pThis);
}

int DasWasmRdr_addProcessor(DasWasmRdr* pThis, StreamHandler* pProc)
{
	/* DasIO_addProcessor returns a slot count or a negated error */
	int nRet = DasIO_addProcessor(pThis->pIo, pProc);
	return (nRet < 0) ? -nRet : DAS_OKAY;
}

void daswasm_stream_free(DasStream* pSd){ del_DasStream(pSd); }

/* ************************************************************************* */
/* Tree walk */

int daswasm_strm_dsCount(DasStream* pSd)
{
	int nPktId = 0, nSets = 0;
	DasDesc* pDesc = NULL;
	while((pDesc = DasStream_nextDesc(pSd, &nPktId)) != NULL){
		if(pDesc->type == DATASET)
			++nSets;
	}
	return nSets;
}

DasDs* daswasm_strm_dsAt(DasStream* pSd, int i)
{
	int nPktId = 0, nSets = 0;
	DasDesc* pDesc = NULL;
	while((pDesc = DasStream_nextDesc(pSd, &nPktId)) != NULL){
		if(pDesc->type != DATASET)
			continue;
		if(nSets == i)
			return (DasDs*)pDesc;
		++nSets;
	}
	return NULL;
}

int daswasm_desc_propCount(const DasDesc* pDesc)
{
	return (int)DasDesc_length(pDesc);
}

const char* daswasm_desc_propName(const DasDesc* pDesc, int i)
{
	const DasProp* pProp = DasDesc_getPropByIdx(pDesc, (size_t)i);
	return (pProp != NULL) ? DasProp_name(pProp) : NULL;
}

const char* daswasm_desc_propValue(const DasDesc* pDesc, int i)
{
	const DasProp* pProp = DasDesc_getPropByIdx(pDesc, (size_t)i);
	return (pProp != NULL) ? DasProp_value(pProp) : NULL;
}

const char* daswasm_desc_propType(const DasDesc* pDesc, int i)
{
	const DasProp* pProp = DasDesc_getPropByIdx(pDesc, (size_t)i);
	return (pProp != NULL) ? DasProp_typeStr3(pProp) : NULL;
}

const char* daswasm_ds_id(const DasDs* pDs){ return DasDs_id(pDs); }

const char* daswasm_ds_group(const DasDs* pDs){ return DasDs_group(pDs); }

int daswasm_ds_rank(const DasDs* pDs){ return DasDs_rank(pDs); }

int daswasm_ds_shapeAt(const DasDs* pDs, int i)
{
	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	int nRank = DasDs_shape(pDs, aShape);
	if((i < 0)||(i >= nRank))
		return VARIDX_UNUSED;
	return (int)aShape[i];
}

int daswasm_ds_dimCount(const DasDs* pDs, int bCoord)
{
	return (int)DasDs_numDims(pDs, bCoord ? DASDIM_COORD : DASDIM_DATA);
}

DasDim* daswasm_ds_dimAt(DasDs* pDs, int i, int bCoord)
{
	if(i < 0) return NULL;
	return DasDs_getDimByIdx(pDs, (size_t)i, bCoord ? DASDIM_COORD : DASDIM_DATA);
}

const char* daswasm_dim_id(const DasDim* pDim){ return DasDim_id(pDim); }

int daswasm_dim_isCoord(const DasDim* pDim)
{
	return (DasDim_type(pDim) == DASDIM_COORD) ? 1 : 0;
}

int daswasm_dim_varCount(const DasDim* pDim){ return (int)DasDim_numVars(pDim); }

DasVar* daswasm_dim_varAt(DasDim* pDim, int i)
{
	if(i < 0) return NULL;
	return DasDim_getVarByIdx(pDim, (size_t)i);
}

const char* daswasm_dim_roleAt(DasDim* pDim, int i)
{
	if(i < 0) return NULL;
	return DasDim_getRoleByIdx(pDim, (size_t)i);
}

/* ************************************************************************* */
/* Variables */

const char* daswasm_var_units(const DasVar* pVar)
{
	const char* sUnits = (const char*)DasVar_units(pVar);
	return (sUnits != NULL) ? sUnits : "";
}

const char* daswasm_var_valType(const DasVar* pVar)
{
	das_val_type vt = DasVar_valType(pVar);

	/* A composite (vector, matrix, complex...) is a run of simple storage
	 * elements plus a formalism; the type a foreign caller must map to a
	 * typed array is the ELEMENT type.  Geometry comes from the intrinsic
	 * shape, meaning from the form -- neither changes the bytes. */
	if(vt == vtComposite)
		vt = (das_val_type)DasVar_elemType(pVar);

	return das_vt_toStr(vt);
}

int daswasm_var_shapeAt(const DasVar* pVar, int i)
{
	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	int nRank = DasVar_shape(pVar, aShape);
	if((i < 0)||(i >= nRank))
		return VARIDX_UNUSED;
	return (int)aShape[i];
}

int daswasm_var_intrRank(const DasVar* pVar)
{
	ptrdiff_t aShape[VARIDX_MAX - 1] = {0};
	return DasVar_intrShape(pVar, aShape);
}

int daswasm_var_intrShapeAt(const DasVar* pVar, int i)
{
	ptrdiff_t aShape[VARIDX_MAX - 1] = {0};
	int nRank = DasVar_intrShape(pVar, aShape);
	if((i < 0)||(i >= nRank))
		return VARIDX_UNUSED;
	return (int)aShape[i];
}

const char* daswasm_var_compSym(const DasVar* pVar, int i)
{
	return DasVar_compSym(pVar, i);
}

int daswasm_var_isNumeric(const DasVar* pVar)
{
	return DasVar_isNumeric(pVar) ? 1 : 0;
}

DasAry* daswasm_var_ary(DasVar* pVar){ return DasVar_getAry(pVar); }

DasAry* daswasm_var_qubeLike(DasVar* pVar, const DasVar* pShapeFrom)
{
	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	int nRank = DasVar_shape(pVar, aShape);
	return DasVar_materializeQube(pVar, nRank, NULL, NULL, pShapeFrom);
}

DasAry* daswasm_var_qube(DasVar* pVar)
{
	return daswasm_var_qubeLike(pVar, NULL);
}

/* ************************************************************************* */
/* Arrays */

const char* daswasm_ary_valType(const DasAry* pAry)
{
	return DasAry_valTypeStr(pAry);
}

int daswasm_ary_valSize(const DasAry* pAry){ return (int)DasAry_valSize(pAry); }

int daswasm_ary_rank(const DasAry* pAry)
{
	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	return DasAry_shape(pAry, aShape);
}

int daswasm_ary_shapeAt(const DasAry* pAry, int i)
{
	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	int nRank = DasAry_shape(pAry, aShape);
	if((i < 0)||(i >= nRank))
		return VARIDX_UNUSED;
	return (int)aShape[i];
}

int daswasm_ary_size(const DasAry* pAry){ return (int)DasAry_size(pAry); }

const ubyte* daswasm_ary_data(DasAry* pAry)
{
	size_t uVals = 0;
	return DasAry_getIn(pAry, DasAry_valType(pAry), DIM0, &uVals);
}

const char* daswasm_ary_textAt(DasAry* pAry, int i)
{
	size_t uVals = 0;
	if(DasAry_valType(pAry) != vtText)
		return NULL;
	char** pStrs = (char**)DasAry_getIn(pAry, vtText, DIM0, &uVals);
	if((pStrs == NULL)||(i < 0)||((size_t)i >= uVals))
		return NULL;
	return pStrs[i];
}

/* The foreign side speaks int; das2C indexes with ptrdiff_t.  Widen into
 * a fixed local, bounded by the maximum array rank das2C supports. */
static int _daswasm_loc(const DasAry* pAry, const int* pLoc, int nLoc, ptrdiff_t* aLoc)
{
	if((nLoc < 0)||(nLoc > ARYIDX_MAX)||(nLoc > DasAry_rank(pAry))){
		das_error(DASERR_ARRAY, "Partial index of length %d out of range for rank %d array",
		          nLoc, DasAry_rank(pAry));
		return -1;
	}
	for(int i = 0; i < nLoc; ++i)
		aLoc[i] = pLoc[i];
	return nLoc;
}

int daswasm_ary_lengthAt(const DasAry* pAry, const int* pLoc, int nLoc)
{
	ptrdiff_t aLoc[ARYIDX_MAX];
	if(_daswasm_loc(pAry, pLoc, nLoc, aLoc) < 0)
		return -1;
	/* a complete index has nothing below it */
	if(nLoc == DasAry_rank(pAry))
		return 1;
	return (int)DasAry_lengthIn(pAry, nLoc, aLoc);
}

int daswasm_ary_sizeAt(DasAry* pAry, const int* pLoc, int nLoc)
{
	ptrdiff_t aLoc[ARYIDX_MAX];
	size_t uVals = 0;
	if(_daswasm_loc(pAry, pLoc, nLoc, aLoc) < 0)
		return -1;
	if(DasAry_getIn(pAry, DasAry_valType(pAry), nLoc, aLoc, &uVals) == NULL)
		return 0;
	return (int)uVals;
}

const ubyte* daswasm_ary_dataAt(DasAry* pAry, const int* pLoc, int nLoc)
{
	ptrdiff_t aLoc[ARYIDX_MAX];
	size_t uVals = 0;
	if(_daswasm_loc(pAry, pLoc, nLoc, aLoc) < 0)
		return NULL;
	return DasAry_getIn(pAry, DasAry_valType(pAry), nLoc, aLoc, &uVals);
}

double* daswasm_ary_times(DasAry* pAry)
{
	size_t uVals = 0;
	if(DasAry_valType(pAry) != vtTime)
		return NULL;
	const das_time* pTimes = DasAry_getTimesIn(pAry, DIM0, &uVals);

	/* An empty time array (header landed, no data yet) has no element
	 * pointer, and malloc(0) may legally return NULL too.  Neither is a
	 * failure, so hand back a real buffer of zero useful doubles. */
	if((pTimes == NULL)&&(DasAry_size(pAry) != 0))
		return NULL;
	if(pTimes == NULL)
		uVals = 0;

	double* pOut = (double*)malloc((uVals > 0 ? uVals : 1) * sizeof(double));
	if(pOut == NULL){
		das_error(DASERR_ARRAY, "Couldn't allocate %zu doubles", uVals);
		return NULL;
	}
	for(size_t u = 0; u < uVals; ++u)
		pOut[u] = dt_ttime(pTimes + u);
	return pOut;
}

/* One typed pass of daswasm_ary_doubles.  DIFF is spelled per type by the
   caller because the exactness argument differs: integer elements widen to
   int64 and subtract there, so a TT2000 axis re-based on its own first
   sample never meets a double until the residual is small; float elements
   subtract as doubles.  The fill test is a bitwise-equal compare in the
   element type, which is what das2C itself does when it asks "is this
   fill", and is why a NaN fill on a real array falls through: NaN != NaN,
   but the cast then yields NaN anyway. */
#define _DASWASM_TO_DBL(T, DIFF) do{ \
	const T* pIn = (const T*)pData; \
	const T fill = *((const T*)pFill); \
	const T ref = (pRef != NULL) ? *((const T*)pRef) : (T)0; \
	for(size_t u = 0; u < uVals; ++u) \
		pOut[u] = (pIn[u] == fill) ? NAN : ((double)(DIFF)) * rScale; \
}while(0)

double* daswasm_ary_doubles(DasAry* pAry, const ubyte* pRef, double rScale)
{
	das_val_type vt = DasAry_valType(pAry);
	if((vt < vtUByte)||(vt > vtDouble)){
		das_error(DASERR_ARRAY, "No double conversion for arrays of %s elements",
		          das_vt_toStr(vt));
		return NULL;
	}

	/* Same empty-array contract as daswasm_ary_times: a header with no
	   records yet is not an error, answer with a real (if useless) buffer */
	size_t uVals = 0;
	const ubyte* pData = DasAry_getIn(pAry, vt, DIM0, &uVals);
	if((pData == NULL)&&(DasAry_size(pAry) != 0))
		return NULL;
	if(pData == NULL)
		uVals = 0;

	double* pOut = (double*)malloc((uVals > 0 ? uVals : 1) * sizeof(double));
	if(pOut == NULL){
		das_error(DASERR_ARRAY, "Couldn't allocate %zu doubles", uVals);
		return NULL;
	}
	if(uVals == 0)
		return pOut;

	const ubyte* pFill = DasAry_getFill(pAry);

	/* The two 64-bit cases subtract as uint64 and reinterpret: signed
	   overflow is undefined in C, unsigned wrap is defined, and the wrapped
	   bit pattern read as int64 is the right signed difference whenever
	   that difference fits, which for a time axis it always does */
	switch(vt){
	case vtUByte:  _DASWASM_TO_DBL(uint8_t,  (int64_t)pIn[u] - (int64_t)ref); break;
	case vtByte:   _DASWASM_TO_DBL(int8_t,   (int64_t)pIn[u] - (int64_t)ref); break;
	case vtUShort: _DASWASM_TO_DBL(uint16_t, (int64_t)pIn[u] - (int64_t)ref); break;
	case vtShort:  _DASWASM_TO_DBL(int16_t,  (int64_t)pIn[u] - (int64_t)ref); break;
	case vtUInt:   _DASWASM_TO_DBL(uint32_t, (int64_t)pIn[u] - (int64_t)ref); break;
	case vtInt:    _DASWASM_TO_DBL(int32_t,  (int64_t)pIn[u] - (int64_t)ref); break;
	case vtULong:  _DASWASM_TO_DBL(uint64_t, (int64_t)(pIn[u] - ref)); break;
	case vtLong:   _DASWASM_TO_DBL(int64_t,  (int64_t)((uint64_t)pIn[u] - (uint64_t)ref)); break;
	case vtFloat:  _DASWASM_TO_DBL(float,    (double)pIn[u] - (double)ref); break;
	case vtDouble: _DASWASM_TO_DBL(double,   pIn[u] - ref); break;
	default: break;  /* excluded above */
	}
	return pOut;
}

#undef _DASWASM_TO_DBL

void daswasm_ary_free(DasAry* pAry)
{
	if(pAry != NULL)
		dec_DasAry(pAry);
}

void daswasm_free(void* pBuf)
{
	if(pBuf != NULL)
		free(pBuf);
}

/* ************************************************************************* */
/* Metadata snapshot
 *
 * One call per dataset returns its whole structure as JSON.  The structure
 * is fixed once the header packet has been parsed (only the record count
 * grows afterwards), so a foreign caller parses this once and keeps plain
 * objects, instead of making a C call per field per tick.  The key
 * vocabulary follows the das3 XML attribute names where they exist; see the
 * description in wasm.h.  Pointers ride along as "ptr" so the caller can
 * reach the live objects (record counts, value buffers) without re-walking.
 */

typedef struct jbuf {
	char* s;
	size_t len;
	size_t cap;
	int err;
} JBuf;

static int _jb_reserve(JBuf* b, size_t uMore)
{
	if(b->err) return 0;
	if(b->len + uMore + 1 <= b->cap) return 1;
	size_t uCap = (b->cap > 0) ? b->cap : 1024;
	while(uCap < b->len + uMore + 1) uCap *= 2;
	char* sNew = (char*)realloc(b->s, uCap);
	if(sNew == NULL){
		b->err = das_error(DASERR_DS, "Couldn't allocate %zu bytes for a snapshot", uCap);
		return 0;
	}
	b->s = sNew;
	b->cap = uCap;
	return 1;
}

static void _jb_raw(JBuf* b, const char* s)
{
	size_t n = strlen(s);
	if(!_jb_reserve(b, n)) return;
	memcpy(b->s + b->len, s, n);
	b->len += n;
	b->s[b->len] = '\0';
}

/* JSON needs a comma between siblings but not after an opener or a key.
   Looking at the previous byte is enough to tell the cases apart, which
   saves threading a "first item" flag through every emitter. */
static void _jb_item(JBuf* b)
{
	if(b->len == 0) return;
	char c = b->s[b->len - 1];
	if((c != '{')&&(c != '[')&&(c != ':'))
		_jb_raw(b, ",");
}

/* Quoted and escaped.  UTF-8 passes through untouched, JSON is UTF-8. */
static void _jb_str(JBuf* b, const char* s)
{
	_jb_item(b);
	if(s == NULL) s = "";
	if(!_jb_reserve(b, strlen(s) * 6 + 2)) return;
	b->s[b->len++] = '"';
	for(const unsigned char* p = (const unsigned char*)s; *p != '\0'; ++p){
		switch(*p){
		case '"':  b->s[b->len++] = '\\'; b->s[b->len++] = '"';  break;
		case '\\': b->s[b->len++] = '\\'; b->s[b->len++] = '\\'; break;
		case '\n': b->s[b->len++] = '\\'; b->s[b->len++] = 'n';  break;
		case '\r': b->s[b->len++] = '\\'; b->s[b->len++] = 'r';  break;
		case '\t': b->s[b->len++] = '\\'; b->s[b->len++] = 't';  break;
		default:
			if(*p < 0x20)
				b->len += (size_t)snprintf(b->s + b->len, 7, "\\u%04x", (unsigned)*p);
			else
				b->s[b->len++] = (char)*p;
		}
	}
	b->s[b->len++] = '"';
	b->s[b->len] = '\0';
}

static void _jb_key(JBuf* b, const char* k)
{
	_jb_str(b, k);
	_jb_raw(b, ":");
}

static void _jb_int(JBuf* b, long long n)
{
	char sTmp[32];
	_jb_item(b);
	snprintf(sTmp, sizeof(sTmp), "%lld", n);
	_jb_raw(b, sTmp);
}

/* An int64 as a JSON STRING: JSON numbers are doubles on the far side and
   lose integers past 2^53, where TT2000 lives.  The caller converts to a
   BigInt by the type tag beside it. */
static void _jb_int64str(JBuf* b, long long n)
{
	char sTmp[32];
	snprintf(sTmp, sizeof(sTmp), "%lld", n);
	_jb_str(b, sTmp);
}

static void _jb_uint64str(JBuf* b, unsigned long long n)
{
	char sTmp[32];
	snprintf(sTmp, sizeof(sTmp), "%llu", n);
	_jb_str(b, sTmp);
}

/* JSON has no NaN or infinity; null is the honest substitute */
static void _jb_real(JBuf* b, double d)
{
	char sTmp[32];
	_jb_item(b);
	if(!isfinite(d)){ _jb_raw(b, "null"); return; }
	snprintf(sTmp, sizeof(sTmp), "%.17g", d);
	_jb_raw(b, sTmp);
}

static void _jb_bool(JBuf* b, int bVal)
{
	_jb_item(b);
	_jb_raw(b, bVal ? "true" : "false");
}

static void _jb_null(JBuf* b)
{
	_jb_item(b);
	_jb_raw(b, "null");
}

static void _jb_open(JBuf* b, const char* s){ _jb_item(b); _jb_raw(b, s); }

static void _jb_shape(JBuf* b, const ptrdiff_t* pShape, int nRank)
{
	_jb_open(b, "[");
	for(int i = 0; i < nRank; ++i)
		_jb_int(b, (long long)pShape[i]);
	_jb_raw(b, "]");
}

/* The schema's storage token for an element type.  das_vt_toStr already
   says "das_time"; the two pointer spellings never describe elements, a
   byte run's elements are ubytes. */
static const char* _storage_tok(das_val_type vt)
{
	if((vt == vtText)||(vt == vtByteSeq)) return "ubyte";
	const char* s = das_vt_toStr(vt);
	return (s != NULL) ? s : "";
}

/* One typed value: {storage, units, value}.  The JS type of value follows
   storage: integers up to 32 bits and reals are JSON numbers, 64-bit
   integers are strings (see _jb_int64str), a das_time is ISO 8601. */
static void _jb_datum(JBuf* b, const ubyte* pVal, das_val_type vt, das_units units)
{
	char sTmp[48];
	_jb_open(b, "{");
	_jb_key(b, "storage"); _jb_str(b, _storage_tok(vt));
	_jb_key(b, "units");   _jb_str(b, (units != NULL) ? (const char*)units : "");
	_jb_key(b, "value");
	if(pVal == NULL){ _jb_null(b); }
	else switch(vt){
	case vtUByte:  _jb_int(b, *((const uint8_t*)pVal));  break;
	case vtByte:   _jb_int(b, *((const int8_t*)pVal));   break;
	case vtUShort: _jb_int(b, *((const uint16_t*)pVal)); break;
	case vtShort:  _jb_int(b, *((const int16_t*)pVal));  break;
	case vtUInt:   _jb_int(b, *((const uint32_t*)pVal)); break;
	case vtInt:    _jb_int(b, *((const int32_t*)pVal));  break;
	case vtULong:  _jb_uint64str(b, *((const uint64_t*)pVal)); break;
	case vtLong:   _jb_int64str(b, *((const int64_t*)pVal));   break;
	case vtFloat:  _jb_real(b, *((const float*)pVal));   break;
	case vtDouble: _jb_real(b, *((const double*)pVal));  break;
	case vtTime:
		dt_isoc((const das_time*)pVal, sTmp, sizeof(sTmp), 9);
		_jb_str(b, sTmp);
		break;
	case vtText:   _jb_str(b, (const char*)pVal); break;
	default:       _jb_null(b); break;
	}
	_jb_raw(b, "}");
}

/* Properties of any descriptor (stream, dataset, dimension, variable) as
   {name: {type, value, units, alt}}.  Every entry carries all four keys so
   a reader never tests for a missing one.  Range and array types become
   JSON arrays; integers are strings for the BigInt rule; datetimes stay
   the ISO text the producer wrote. */
static void _jb_props(JBuf* b, const DasDesc* pDesc)
{
	_jb_open(b, "{");
	size_t uProps = DasDesc_length(pDesc);
	for(size_t u = 0; u < uProps; ++u){
		const DasProp* pProp = DasDesc_getPropByIdx(pDesc, u);
		if((pProp == NULL)||(!DasProp_isValid(pProp))) continue;

		ubyte uType = DasProp_type(pProp);
		ubyte uBase = uType & DASPROP_TYPE_MASK;
		ubyte uMulti = uType & DASPROP_MULTI_MASK;

		/* A single value is used whole, straight from the property, no copy.
		   Sets and ranges go through the item splitter; each item can be as
		   long as the whole value, so size every slot to that */
		const char* sWhole = DasProp_value(pProp);
		int nItems = 1;
		char* pStore = NULL;
		char** psItems = NULL;
		const char* const* psVals = &sWhole;
		if(uMulti != DASPROP_SINGLE){
			nItems = DasProp_items(pProp);
			if(nItems < 0) nItems = 0;
			size_t uLenEa = strlen(sWhole) + 1;
			pStore = (char*)calloc((size_t)(nItems > 0 ? nItems : 1), uLenEa);
			psItems = (char**)calloc((size_t)(nItems > 0 ? nItems : 1), sizeof(char*));
			if((pStore == NULL)||(psItems == NULL)){
				free(pStore); free(psItems);
				b->err = das_error(DASERR_DS, "Couldn't allocate property item buffers");
				return;
			}
			for(int i = 0; i < nItems; ++i) psItems[i] = pStore + (size_t)i * uLenEa;
			int nGot = (nItems > 0) ? DasProp_extractItems(pProp, psItems, (size_t)nItems, uLenEa) : 0;
			if(nGot < nItems) nItems = (nGot > 0) ? nGot : 0;
			psVals = (const char* const*)psItems;
		}

		_jb_key(b, DasProp_name(pProp));
		_jb_open(b, "{");
		_jb_key(b, "type");  _jb_str(b, DasProp_typeStr3(pProp));
		_jb_key(b, "value");
		if(uMulti != DASPROP_SINGLE) _jb_open(b, "[");
		for(int i = 0; i < nItems; ++i){
			switch(uBase){
			case DASPROP_BOOL:
				_jb_bool(b, (strcmp(psVals[i], "true") == 0)||(strcmp(psVals[i], "1") == 0));
				break;
			case DASPROP_INT:
				_jb_str(b, psVals[i]);   /* digits as text, BigInt on the far side */
				break;
			case DASPROP_REAL:
				_jb_real(b, strtod(psVals[i], NULL));
				break;
			default:  /* string, datetime: as written */
				_jb_str(b, psVals[i]);
				break;
			}
		}
		if(uMulti != DASPROP_SINGLE) _jb_raw(b, "]");
		das_units units = DasProp_units(pProp);
		_jb_key(b, "units"); _jb_str(b, (units != NULL) ? (const char*)units : "");
		_jb_key(b, "alt");   _jb_open(b, "{"); _jb_raw(b, "}");
		_jb_raw(b, "}");

		free(pStore);
		free(psItems);
	}
	_jb_raw(b, "}");
}

/* One <ops> parameter as a plain JSON value, parsed by the type das2C
   reports.  Unlike _jb_props there is no {type, value, units} wrapper: a
   formalism's parameter set is small and fixed per kind, so JS reads
   ops.sysorder directly.  Integers are plain numbers here, not BigInt text;
   the only integer parameters are component slots (0 to 8).
   
   DasProp's own converters do the splitting, so this never needs to know
   that sysorder's items are separated by ';'. */
#define OPS_MAX_ITEMS 16
static void _jb_opsParam(JBuf* b, const DasProp* pProp)
{
	ubyte uType  = DasProp_type(pProp);
	ubyte uBase  = uType & DASPROP_TYPE_MASK;
	bool  bMulti = ((uType & DASPROP_MULTI_MASK) != DASPROP_SINGLE);

	_jb_key(b, DasProp_name(pProp));

	int n = 0;
	switch(uBase){
	case DASPROP_INT: {
		int64_t aVal[OPS_MAX_ITEMS];
		n = DasProp_convertInt(pProp, aVal, OPS_MAX_ITEMS);
		if(bMulti) _jb_open(b, "[");
		for(int i = 0; i < n; ++i) _jb_int(b, (long long)aVal[i]);
		if(bMulti) _jb_raw(b, "]");
		break;
	}
	case DASPROP_REAL: {
		double aVal[OPS_MAX_ITEMS];
		n = DasProp_convertReal(pProp, aVal, OPS_MAX_ITEMS);
		if(bMulti) _jb_open(b, "[");
		for(int i = 0; i < n; ++i) _jb_real(b, aVal[i]);
		if(bMulti) _jb_raw(b, "]");
		break;
	}
	case DASPROP_BOOL: {
		uint8_t aVal[OPS_MAX_ITEMS];
		n = DasProp_convertBool(pProp, aVal, OPS_MAX_ITEMS);
		if(bMulti) _jb_open(b, "[");
		for(int i = 0; i < n; ++i) _jb_bool(b, aVal[i]);
		if(bMulti) _jb_raw(b, "]");
		break;
	}
	default:
		/* string, and every parameter of a kind das2C does not know */
		_jb_str(b, DasProp_value(pProp));
		n = 1;
		break;
	}

	/* A scalar that failed to convert left a key with no value, which would
	   be invalid JSON.  das_error has already said why. */
	if((n < 1)&&(!bMulti)) _jb_null(b);
}

/* {kind, ...parameters}.  Every parameter the form holds, defaults included,
   so JS never has to know that a missing system= means cartesian. */
static void _jb_ops(JBuf* b, const DasForm* pForm)
{
	_jb_open(b, "{");
	_jb_key(b, "kind"); _jb_str(b, DasForm_kind(pForm));

	das_form_param_buf buf;
	const DasProp* pProp = NULL;
	for(int i = 0; (pProp = DasForm_paramAt(pForm, i, &buf)) != NULL; ++i)
		_jb_opsParam(b, pProp);

	_jb_raw(b, "}");
}

/* {kind} plus, for a sequence, the intercept and slopes as typed values.
   A das_time sequence keeps its slopes as doubles in seconds (das2C's
   affine rule), so their storage and units differ from the intercept's. */
static void _jb_source(JBuf* b, const DasVar* pVar, const ptrdiff_t* pShape, int nRank)
{
	const DasGen* pGen = DasVar_gen(pVar);
	_jb_open(b, "{");
	_jb_key(b, "kind");

	/* The one variable class with no leaf value source is an operation over
	   two other variables (das2 streams build time = reference + offset this
	   way).  Say what was combined, by role, so a caller can find the
	   operands in the same dimension. */
	if(pGen == NULL){
		const DasVarBin* pBin = (const DasVarBin*)pVar;
		const char* sOp = das_op_toStr(pBin->op, NULL);
		_jb_str(b, "binaryOp");
		_jb_key(b, "op");    _jb_str(b, (sOp != NULL) ? sOp : "");
		_jb_key(b, "left");  _jb_str(b, (pBin->pLeft != NULL) ? DasVar_role(pBin->pLeft) : "");
		_jb_key(b, "right"); _jb_str(b, (pBin->pRight != NULL) ? DasVar_role(pBin->pRight) : "");
		_jb_raw(b, "}");
		return;
	}

	switch(DasGen_type(pGen)){
	case gtArray: _jb_str(b, "array");    break;
	case gtSeq:   _jb_str(b, "sequence"); break;
	case gtConst: _jb_str(b, "const");    break;
	case gtUnop:  _jb_str(b, "unaryOp");  break;
	case gtBinop: _jb_str(b, "binaryOp"); break;
	default:      _jb_str(b, "");         break;
	}

	if(DasGen_type(pGen) == gtSeq){
		const DasGenSeq* pSeq = (const DasGenSeq*)pGen;
		das_val_type vt = (das_val_type)DasGen_elemType(pGen);
		das_units units = DasVar_units(pVar);
		das_val_type vtSlope = (vt == vtTime) ? vtDouble : vt;
		das_units uSlope = (vt == vtTime) ? UNIT_SECONDS : units;
		int nComps = (pSeq->nComps > 0) ? pSeq->nComps : 1;

		_jb_key(b, "minval");
		if(nComps > 1) _jb_open(b, "[");
		for(int c = 0; c < nComps; ++c)
			_jb_datum(b, DasGenSeq_intercept(pSeq, c), vt, units);
		if(nComps > 1) _jb_raw(b, "]");

		/* one slot per dataset index, null where the sequence does not run */
		_jb_key(b, "interval");
		if(nComps > 1) _jb_open(b, "[");
		for(int c = 0; c < nComps; ++c){
			_jb_open(b, "[");
			for(int i = 0; i < nRank; ++i){
				if(pShape[i] == VARIDX_UNUSED) _jb_null(b);
				else _jb_datum(b, DasGenSeq_interval(pSeq, c, i), vtSlope, uSlope);
			}
			_jb_raw(b, "]");
		}
		if(nComps > 1) _jb_raw(b, "]");
	}
	_jb_raw(b, "}");
}

static void _jb_var(JBuf* b, DasVar* pVar, int nDsRank)
{
	das_val_type vt = DasVar_valType(pVar);
	das_val_type et = (das_val_type)DasVar_elemType(pVar);
	das_units units = DasVar_units(pVar);
	bool bBytes = (vt == vtText)||(vt == vtByteSeq);

	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	DasVar_shape(pVar, aShape);
	ptrdiff_t aInner[VARIDX_MAX] = {0};
	int nInner = DasVar_intrShape(pVar, aInner);
	if(nInner < 0) nInner = 0;

	_jb_open(b, "{");
	_jb_key(b, "ptr");      _jb_int(b, (long long)(uintptr_t)pVar);
	_jb_key(b, "role");     _jb_str(b, DasVar_role(pVar));
	_jb_key(b, "units");    _jb_str(b, (units != NULL) ? (const char*)units : "");

	/* semantic is derived the way the das3 writer derives it: spent at parse
	   time, re-stated for the reader.  A byte run's meaning is its class. */
	_jb_key(b, "semantic");
	if(vt == vtText) _jb_str(b, "string");
	else if(vt == vtByteSeq) _jb_str(b, "blob");
	else{
		const char* sSem = das_sem_default(et, units);
		_jb_str(b, (sSem != NULL) ? sSem : "");
	}
	_jb_key(b, "storage");  _jb_str(b, _storage_tok(bBytes ? vt : et));
	_jb_key(b, "innerShape"); _jb_shape(b, aInner, nInner);
	_jb_key(b, "isNumeric"); _jb_bool(b, DasVar_isNumeric(pVar));
	_jb_key(b, "props");    _jb_props(b, (const DasDesc*)pVar);
	_jb_key(b, "source");   _jb_source(b, pVar, aShape, nDsRank);

	/* a byte run has no formalism by class, so no ops key at all */
	const DasForm* pForm = DasVar_form(pVar);
	if(pForm != NULL){
		_jb_key(b, "ops");  _jb_ops(b, pForm);
	}

	/* component symbols in storage order, null where the kind has none */
	_jb_key(b, "symbols"); _jb_open(b, "[");
	if(!bBytes && (nInner > 0)){
		long long nSyms = 1;
		for(int i = 0; i < nInner; ++i)
			nSyms = (aInner[i] > 0) ? nSyms * aInner[i] : 0;
		for(long long i = 0; i < nSyms; ++i){
			const char* sSym = DasVar_compSym(pVar, (int)i);
			if(sSym != NULL) _jb_str(b, sSym); else _jb_null(b);
		}
	}
	_jb_raw(b, "]");
	_jb_raw(b, "}");
}

static void _jb_dim(JBuf* b, DasDim* pDim, int nDsRank)
{
	_jb_open(b, "{");
	_jb_key(b, "ptr");     _jb_int(b, (long long)(uintptr_t)pDim);
	_jb_key(b, "name");    _jb_str(b, DasDim_id(pDim));
	_jb_key(b, "physDim"); _jb_str(b, DasDim_dim(pDim));
	_jb_key(b, "axes");    _jb_open(b, "[");
	for(int i = 0; i < DASDIM_NAXES; ++i){
		const char* sAxis = DasDim_getAxis(pDim, i);
		if(sAxis == NULL) break;
		_jb_str(b, sAxis);
	}
	_jb_raw(b, "]");
	_jb_key(b, "kind");    _jb_str(b, DasDim_typeName(pDim));
	_jb_key(b, "props");   _jb_props(b, (const DasDesc*)pDim);
	_jb_key(b, "vars");    _jb_open(b, "{");
	size_t uVars = DasDim_numVars(pDim);
	for(size_t u = 0; u < uVars; ++u){
		_jb_key(b, DasDim_getRoleByIdx(pDim, u));
		_jb_var(b, DasDim_getVarByIdx(pDim, u), nDsRank);
	}
	_jb_raw(b, "}");
	_jb_raw(b, "}");
}

static void _jb_dims(JBuf* b, DasDs* pDs, enum dim_type dt, int nDsRank)
{
	_jb_open(b, "[");
	size_t uDims = DasDs_numDims(pDs, dt);
	for(size_t u = 0; u < uDims; ++u)
		_jb_dim(b, DasDs_getDimByIdx(pDs, u, dt), nDsRank);
	_jb_raw(b, "]");
}

char* daswasm_ds_json(DasDs* pDs)
{
	JBuf b = {NULL, 0, 0, 0};
	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	int nRank = DasDs_shape(pDs, aShape);
	const char* sGroup = DasDs_group(pDs);

	_jb_open(&b, "{");
	_jb_key(&b, "ptr");    _jb_int(&b, (long long)(uintptr_t)pDs);
	_jb_key(&b, "name");   _jb_str(&b, DasDs_id(pDs));
	_jb_key(&b, "group");  _jb_str(&b, (sGroup != NULL) ? sGroup : "");
	_jb_key(&b, "rank");   _jb_int(&b, nRank);
	_jb_key(&b, "shape");  _jb_shape(&b, aShape, nRank);
	_jb_key(&b, "props");  _jb_props(&b, (const DasDesc*)pDs);
	_jb_key(&b, "coords"); _jb_dims(&b, pDs, DASDIM_COORD, nRank);
	_jb_key(&b, "data");   _jb_dims(&b, pDs, DASDIM_DATA, nRank);
	_jb_raw(&b, "}");

	if(b.err){ free(b.s); return NULL; }
	return b.s;
}

char* daswasm_desc_json(const DasDesc* pDesc)
{
	JBuf b = {NULL, 0, 0, 0};
	_jb_props(&b, pDesc);
	if(b.err){ free(b.s); return NULL; }
	return b.s;
}

/* ************************************************************************* */
/* Catalog node snapshot */

static const char* _node_kind_tok(das_node_type_e nt)
{
	switch(nt){
	case d2node_catalog:    return "catalog";
	case d2node_collection: return "collection";
	case d2node_srcset:     return "srcset";
	case d2node_stream_src: return "stream_src";
	case d2node_file_agg:   return "file_agg";
	case d2node_spdf_cat:   return "spdf_cat";
	case d2node_spase_cat:  return "spase_cat";
	default:                return "inv";
	}
}

/* _jb_str writes "" for NULL, but a node field that is absent and one that
   is empty mean different things to a caller */
static void _jb_strOrNull(JBuf* b, const char* s)
{
	if(s == NULL) _jb_null(b);
	else _jb_str(b, s);
}

/* The stub goes through as the server wrote it.  Fields beyond type and
   urls (provides, validRange, purpose ...) vary by server and age, and a
   tree view wants whichever ones are there. */
static void _jb_stub(JBuf* b, const DasJdo* pStub)
{
	size_t uLen = 0;
	char* sStub = (pStub == NULL) ? NULL : (char*)DasJdo_writeMinified(pStub, &uLen);
	if(sStub == NULL){ _jb_null(b); return; }
	_jb_item(b);
	_jb_raw(b, sStub);
	free(sStub);
}

char* daswasm_node_json(const DasNode* pNode)
{
	if(pNode == NULL) return NULL;
	JBuf b = {NULL, 0, 0, 0};

	const DasJdo* pType = DasNode_getJdo(pNode, D2FRAG_TYPE);

	_jb_open(&b, "{");
	_jb_key(&b, "ptr");         _jb_int(&b, (long long)(uintptr_t)pNode);
	_jb_key(&b, "kind");        _jb_str(&b, _node_kind_tok(DasNode_type(pNode)));
	_jb_key(&b, "type");        _jb_strOrNull(&b, pType ? DasJdo_string(pType) : NULL);
	_jb_key(&b, "version");     _jb_strOrNull(&b, DasNode_version(pNode));
	_jb_key(&b, "name");        _jb_strOrNull(&b, DasNode_name(pNode));
	_jb_key(&b, "label");       _jb_strOrNull(&b, DasNode_label(pNode));
	_jb_key(&b, "title");       _jb_strOrNull(&b, DasNode_title(pNode));
	_jb_key(&b, "description"); _jb_strOrNull(&b, DasNode_summary(pNode));
	_jb_key(&b, "uri");         _jb_strOrNull(&b, DasNode_pathUri(pNode));
	_jb_key(&b, "url");         _jb_str(&b, DasNode_srcUrl(pNode));
	_jb_key(&b, "separator");   _jb_strOrNull(&b, DasNode_pathSep(pNode));

	_jb_key(&b, "children");
	_jb_open(&b, "[");
	size_t uKids = DasNode_subCount(pNode);
	for(size_t u = 0; u < uKids; ++u){
		_jb_open(&b, "{");
		_jb_key(&b, "name"); _jb_str(&b, DasNode_subName(pNode, u));
		_jb_key(&b, "kind"); _jb_str(&b, _node_kind_tok(DasNode_subType(pNode, u)));
		_jb_key(&b, "stub"); _jb_stub(&b, DasNode_subStub(pNode, u));
		_jb_raw(&b, "}");
	}
	_jb_raw(&b, "]");

	/* Counted first: the names are borrowed, so only the pointer array is
	   allocated here */
	_jb_key(&b, "loadable");
	_jb_open(&b, "[");
	size_t uLoad = dassrc_loadable(pNode, NULL, 0);
	if(uLoad > 0){
		const char** aNames = (const char**)calloc(uLoad, sizeof(const char*));
		if(aNames == NULL){
			b.err = das_error(DASERR_DS, "Couldn't allocate a loadable list");
		}
		else{
			dassrc_loadable(pNode, aNames, uLoad);
			for(size_t u = 0; u < uLoad; ++u) _jb_str(&b, aNames[u]);
			free(aNames);
		}
	}
	_jb_raw(&b, "]");

	_jb_raw(&b, "}");

	if(b.err){ free(b.s); return NULL; }
	return b.s;
}
