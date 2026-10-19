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

#include <das3/core.h>
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
	DasIO_model(pThis->pIo, 3);  /* foreign callers only see the das3 model */

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

DasAry* daswasm_var_qube(DasVar* pVar)
{
	ptrdiff_t aShape[VARIDX_MAX] = VARIDX_INIT_UNUSED;
	int nRank = DasVar_shape(pVar, aShape);
	return DasVar_materializeQube(pVar, nRank, NULL, NULL, NULL);
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

double* daswasm_ary_times(DasAry* pAry)
{
	size_t uVals = 0;
	if(DasAry_valType(pAry) != vtTime)
		return NULL;
	const das_time* pTimes = DasAry_getTimesIn(pAry, DIM0, &uVals);
	if(pTimes == NULL)
		return NULL;

	double* pOut = (double*)malloc(uVals * sizeof(double));
	if(pOut == NULL){
		das_error(DASERR_ARRAY, "Couldn't allocate %zu doubles", uVals);
		return NULL;
	}
	for(size_t u = 0; u < uVals; ++u)
		pOut[u] = dt_ttime(pTimes + u);
	return pOut;
}

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
