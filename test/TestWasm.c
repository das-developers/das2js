/** @file TestWasm.c Native exercise of the flat FFI layer in das3/wasm.h
 *
 * The wasm.h functions exist so that a foreign runtime (JavaScript via
 * emscripten first) can read streams and reach decoded values without
 * touching macros, enums or struct layouts.  Everything is testable
 * natively: this program plays the role of the JS module, calling only
 * daswasm and DasWasmRdr functions for stream access and cross-checking
 * the answers against direct library calls.
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

#include <das3/core.h>
#include <das3/json.h>
#include "wasm.h"

#define CHECK(COND, MSG) \
	if(!(COND)){ printf("ERROR: %s (%s:%d)\n", MSG, __FILE__, __LINE__); return 1; }

/* Feed a whole file through a reader in small chunks, FFI calls only */
static DasWasmRdr* readFile(const char* sPath, size_t uChunk)
{
	FILE* pFile = fopen(sPath, "rb");
	if(pFile == NULL){
		printf("ERROR: Couldn't open %s\n", sPath);
		return NULL;
	}

	DasWasmRdr* pRdr = new_DasWasmRdr();
	ubyte aBuf[997];  /* odd size on purpose, stresses packet splits */
	if(uChunk > sizeof(aBuf)) uChunk = sizeof(aBuf);

	size_t uRead = 0;
	int nRet = 0;
	while((uRead = fread(aBuf, 1, uChunk, pFile)) > 0){
		if((nRet = DasWasmRdr_feed(pRdr, aBuf, (int)uRead)) != 0)
			break;
	}
	fclose(pFile);

	if(nRet == 0)
		nRet = DasWasmRdr_end(pRdr);

	if(nRet != 0){
		printf("ERROR: %s failed to parse: %s\n", sPath, daswasm_lastError());
		del_DasWasmRdr(pRdr);
		return NULL;
	}
	return pRdr;
}

/* For a variable that borrows an extent along some index, find a variable
   in the same dataset with a settled extent there: the first array-backed
   one that is sized or ragged along that index.  NULL if none borrows. */
static DasVar* shapeDonor(DasDs* pDs, DasVar* pVar)
{
	int nRank = daswasm_ds_rank(pDs);
	int iBorrow = -1;
	for(int i = 0; i < nRank; ++i)
		if(daswasm_var_shapeAt(pVar, i) == daswasm_idxBorrow()){ iBorrow = i; break; }
	if(iBorrow < 0) return NULL;

	for(int iKind = 0; iKind < 2; ++iKind){
		int nDims = daswasm_ds_dimCount(pDs, iKind);
		for(int iDim = 0; iDim < nDims; ++iDim){
			DasDim* pDim = daswasm_ds_dimAt(pDs, iDim, iKind);
			int nVars = daswasm_dim_varCount(pDim);
			for(int iVar = 0; iVar < nVars; ++iVar){
				DasVar* pOther = daswasm_dim_varAt(pDim, iVar);
				if(daswasm_var_ary(pOther) == NULL) continue;
				int nExt = daswasm_var_shapeAt(pOther, iBorrow);
				if((nExt > 0)||(nExt == daswasm_idxRagged())) return pOther;
			}
		}
	}
	return NULL;
}

/* Walk every dataset the way the JS module will, checking self-consistency */
static int walkStream(DasStream* pSd, const char* sPath)
{
	int nDs = daswasm_strm_dsCount(pSd);
	CHECK(nDs > 0, "stream has no datasets");

	for(int iDs = 0; iDs < nDs; ++iDs){
		DasDs* pDs = daswasm_strm_dsAt(pSd, iDs);
		CHECK(pDs != NULL, "dataset index in range but lookup failed");
		CHECK(daswasm_ds_id(pDs) != NULL, "dataset without an id");

		int nRank = daswasm_ds_rank(pDs);
		CHECK(nRank >= 1, "dataset with no bulk indices");

		/* A header without data is legal (ex08 declares packet id 06 and
		   never sends one); the metadata must still walk, values are empty */
		int nRecs = daswasm_ds_shapeAt(pDs, 0);
		CHECK(nRecs >= 0, "negative record count");
		if(nRecs == 0)
			printf("INFO: %s: dataset '%s' has a header but no records\n", sPath, daswasm_ds_id(pDs));

		int nCoord = daswasm_ds_dimCount(pDs, 1);
		int nData  = daswasm_ds_dimCount(pDs, 0);
		CHECK(nCoord + nData > 0, "dataset with no dimensions");

		for(int iKind = 0; iKind < 2; ++iKind){
			int nDims = iKind ? nCoord : nData;
			for(int iDim = 0; iDim < nDims; ++iDim){
				DasDim* pDim = daswasm_ds_dimAt(pDs, iDim, iKind);
				CHECK(pDim != NULL, "dim index in range but lookup failed");
				CHECK(daswasm_dim_id(pDim) != NULL, "dimension without an id");
				CHECK(daswasm_dim_isCoord(pDim) == iKind, "dimension kind mismatch");

				int nVars = daswasm_dim_varCount(pDim);
				CHECK(nVars > 0, "dimension with no variables");

				for(int iVar = 0; iVar < nVars; ++iVar){
					DasVar* pVar = daswasm_dim_varAt(pDim, iVar);
					CHECK(pVar != NULL, "var index in range but lookup failed");
					CHECK(daswasm_dim_roleAt(pDim, iVar) != NULL, "variable without a role");
					CHECK(daswasm_var_valType(pVar) != NULL, "variable without a value type");
					CHECK(daswasm_var_units(pVar) != NULL, "variable units may not be NULL");

					/* every variable answers over the whole dataset: along each
					   bulk index it is either sized, ragged, borrowing the
					   dataset's extent, or broadcast */
					for(int i = 0; i < nRank; ++i){
						int nExt = daswasm_var_shapeAt(pVar, i);
						CHECK((nExt >= 0)||(nExt == daswasm_idxRagged())||
						      (nExt == daswasm_idxBorrow())||(nExt == daswasm_idxUnused()),
						      "variable shape entry out of contract");
					}

					/* Zero-copy path: array-backed variables expose real bytes */
					DasAry* pAry = daswasm_var_ary(pVar);
					/* ...unless the variable does not vary along records at all:
					   a das2 frequency table is fully present with zero records */
					if((pAry != NULL)&&(nRecs == 0)&&
					   (daswasm_var_shapeAt(pVar, 0) != daswasm_idxUnused())){
						CHECK(daswasm_ary_size(pAry) == 0, "empty dataset with a non-empty record array");
						CHECK(daswasm_ary_data(pAry) == NULL, "empty array with a data pointer");
						if(DasAry_valType(pAry) == vtTime){
							double* pSec = daswasm_ary_times(pAry);
							CHECK(pSec != NULL, "time conversion of an empty array failed");
							daswasm_free(pSec);
						}
						continue;
					}
					if(pAry != NULL){
						CHECK(daswasm_ary_size(pAry) > 0, "backing array is empty");
						CHECK(daswasm_ary_valSize(pAry) > 0, "element size is zero");
						CHECK(daswasm_ary_data(pAry) != NULL, "no data pointer");

						/* the pointer must be the decoder's own buffer: compare
						   against a direct library call, no copies anywhere */
						size_t uDirect = 0;
						const ubyte* pDirect = DasAry_getIn(
							pAry, DasAry_valType(pAry), DIM0, &uDirect
						);
						CHECK(daswasm_ary_data(pAry) == pDirect, "data pointer is not zero-copy");
						CHECK((size_t)daswasm_ary_size(pAry) == uDirect, "element count mismatch");

						if(DasAry_valType(pAry) == vtText)
							CHECK(daswasm_ary_textAt(pAry, 0) != NULL, "no first string");

						/* Partial-index access must agree with the flat view at
						   the top, and the per-record sub-arrays must tile it
						   exactly, ragged or not */
						int nRecs = daswasm_ary_lengthAt(pAry, NULL, 0);
						CHECK(nRecs == daswasm_ary_shapeAt(pAry, 0), "lengthAt(0) is not the record count");
						CHECK(daswasm_ary_sizeAt(pAry, NULL, 0) == daswasm_ary_size(pAry), "sizeAt(0) is not the size");
						CHECK(daswasm_ary_dataAt(pAry, NULL, 0) == daswasm_ary_data(pAry), "dataAt(0) is not data");
						int nTiled = 0;
						const ubyte* pExpect = daswasm_ary_data(pAry);
						for(int iRec = 0; iRec < nRecs; ++iRec){
							int nSub = daswasm_ary_sizeAt(pAry, &iRec, 1);
							CHECK(nSub >= 0, "sizeAt(record) failed");
							if(nSub > 0)
								CHECK(daswasm_ary_dataAt(pAry, &iRec, 1) == pExpect, "record sub-array not contiguous with predecessor");
							pExpect += nSub * daswasm_ary_valSize(pAry);
							nTiled += nSub;
						}
						CHECK(nTiled == daswasm_ary_size(pAry), "record sub-arrays do not tile the array");

						if(DasAry_valType(pAry) == vtTime){
							double* pSec = daswasm_ary_times(pAry);
							CHECK(pSec != NULL, "time conversion failed");
							/* seconds since 1958: 0 (1958) to ~4.5e9 (2100) */
							CHECK((pSec[0] > 0.0)&&(pSec[0] < 4.5e9),
							      "converted time out of plausible range");
							daswasm_free(pSec);
						}
					}

					/* Universal fallback: a qube of any numeric variable */
					if(daswasm_var_isNumeric(pVar) && (nRecs > 0)){
						DasAry* pQube = daswasm_var_qubeLike(pVar, shapeDonor(pDs, pVar));
						if(pQube == NULL)
							printf("ERROR: %s\n", daswasm_lastError());
						CHECK(pQube != NULL, "numeric variable refused to materialize");
						CHECK(daswasm_ary_size(pQube) > 0, "materialized qube is empty");
						CHECK(daswasm_ary_data(pQube) != NULL, "qube without data");

						/* a non-broadcast, array-backed, non-ragged variable's qube
						   must hold exactly the zero-copy bytes */
						bool bStraight = (pAry != NULL)&&
							(DasAry_valType(pQube) == DasAry_valType(pAry));
						for(int i = 0; bStraight && (i < nRank); ++i)
							if(daswasm_var_shapeAt(pVar, i) <= 0)
								bStraight = false;
						for(int i = 0; bStraight && (i < daswasm_ary_rank(pAry)); ++i)
							if(daswasm_ary_shapeAt(pAry, i) == daswasm_idxRagged())
								bStraight = false;

						if(bStraight &&
						   (daswasm_ary_size(pQube) == daswasm_ary_size(pAry))){
							size_t uBytes = daswasm_ary_size(pAry) * daswasm_ary_valSize(pAry);
							CHECK(
								memcmp(daswasm_ary_data(pQube), daswasm_ary_data(pAry), uBytes) == 0,
								"qube bytes differ from zero-copy bytes"
							);
						}
						daswasm_ary_free(pQube);
					}
				}
			}
		}
	}

	printf("INFO: %s: %d dataset(s) walked clean over the FFI surface\n", sPath, nDs);
	return 0;
}


/* The JSON snapshot must agree with the per-field accessors, which are the
   oracle here: name, rank, dimension counts, roles, storage, and the
   properties of every descriptor.  Parsed with das2C's own JSON reader. */
static const char* jstr(const DasJdo* pJdo, const char* sPath)
{
	const DasJdo* p = DasJdo_get(pJdo, sPath);
	return (p != NULL) ? DasJdo_string(p) : NULL;
}

static int checkSnapshot(DasStream* pSd, const char* sPath)
{
	char* sJson = daswasm_desc_json((DasDesc*)pSd);
	CHECK(sJson != NULL, "stream props snapshot failed");
	DasJdo* pProps = das_json_parse(sJson, strlen(sJson));
	CHECK(pProps != NULL, "stream props snapshot is not valid JSON");
	const das_json_dict* pDict = DasJdo_dict(pProps);
	CHECK(pDict != NULL, "stream props snapshot is not an object");
	CHECK((int)pDict->length == daswasm_desc_propCount((DasDesc*)pSd), "stream property count differs from accessor");
	free(pProps);
	daswasm_free(sJson);

	int nDs = daswasm_strm_dsCount(pSd);
	for(int iDs = 0; iDs < nDs; ++iDs){
		DasDs* pDs = daswasm_strm_dsAt(pSd, iDs);
		sJson = daswasm_ds_json(pDs);
		CHECK(sJson != NULL, "dataset snapshot failed");
		DasJdo* pJdo = das_json_parse(sJson, strlen(sJson));
		if(pJdo == NULL) printf("ERROR: %s\n", sJson);
		CHECK(pJdo != NULL, "dataset snapshot is not valid JSON");

		const char* sName = jstr(pJdo, "name");
		CHECK((sName != NULL)&&(strcmp(sName, daswasm_ds_id(pDs)) == 0), "snapshot name differs from accessor");
		const DasJdo* pRank = DasJdo_get(pJdo, "rank");
		CHECK((pRank != NULL)&&(atoi(((das_json_num*)pRank->value)->number) == daswasm_ds_rank(pDs)), "snapshot rank differs");
		const DasJdo* pShape = DasJdo_get(pJdo, "shape");
		CHECK((pShape != NULL)&&(pShape->type == das_json_type_ary), "snapshot shape missing");
		CHECK((int)((das_json_ary*)pShape->value)->length == daswasm_ds_rank(pDs), "snapshot shape length is not the rank");

		const char* asKinds[] = {"data", "coords"};
		for(int iKind = 0; iKind < 2; ++iKind){
			const DasJdo* pDims = DasJdo_get(pJdo, asKinds[iKind]);
			CHECK((pDims != NULL)&&(pDims->type == das_json_type_ary), "snapshot dims missing");
			CHECK((int)((das_json_ary*)pDims->value)->length == daswasm_ds_dimCount(pDs, iKind), "snapshot dim count differs");
			int iDim = 0;
			for(const das_json_ary_el* pEl = DasJdo_aryFirst(pDims); pEl != NULL; pEl = pEl->next, ++iDim){
				DasDim* pDim = daswasm_ds_dimAt(pDs, iDim, iKind);
				const char* sDim = jstr(pEl->value, "name");
				CHECK((sDim != NULL)&&(strcmp(sDim, daswasm_dim_id(pDim)) == 0), "snapshot dim name differs");
				const char* sKind = jstr(pEl->value, "kind");
				CHECK((sKind != NULL)&&(strcmp(sKind, iKind ? "coord" : "data") == 0), "snapshot dim kind differs");
				const DasJdo* pVars = DasJdo_get(pEl->value, "vars");
				CHECK((pVars != NULL)&&(pVars->type == das_json_type_dict), "snapshot vars missing");
				CHECK((int)((das_json_dict*)pVars->value)->length == daswasm_dim_varCount(pDim), "snapshot var count differs");
				int iVar = 0;
				for(const das_json_dict_el* pV = DasJdo_dictFirst(pVars); pV != NULL; pV = pV->next, ++iVar){
					DasVar* pVar = daswasm_dim_varAt(pDim, iVar);
					CHECK(strcmp(pV->name->string, daswasm_dim_roleAt(pDim, iVar)) == 0, "snapshot role differs from accessor");
					const char* sRole = jstr(pV->value, "role");
					CHECK((sRole != NULL)&&(strcmp(sRole, pV->name->string) == 0), "snapshot var role differs from its key");
					const char* sSem = jstr(pV->value, "semantic");
					const char* sStore = jstr(pV->value, "storage");
					CHECK((sSem != NULL)&&(sStore != NULL)&&(sSem[0] != '\0')&&(sStore[0] != '\0'), "snapshot var without semantic/storage");
					/* byte runs report ubyte elements, everything else das_vt_toStr's name */
					const char* sVt = daswasm_var_valType(pVar);
					bool bBytes = (strcmp(sVt, "char*") == 0)||(strcmp(sVt, "ubyte*") == 0);
					CHECK(strcmp(sStore, bBytes ? "ubyte" : sVt) == 0, "snapshot storage differs from accessor");
					CHECK(bBytes == ((strcmp(sSem, "string") == 0)||(strcmp(sSem, "blob") == 0)), "snapshot semantic disagrees with byte run class");
					CHECK(bBytes == (DasJdo_get(pV->value, "ops") == NULL), "ops presence disagrees with byte run class");
					const char* sGen = jstr(pV->value, "source/kind");
					CHECK(sGen != NULL, "snapshot var without source kind");
					CHECK((strcmp(sGen, "array") == 0) == (daswasm_var_ary(pVar) != NULL), "source kind disagrees with backing array");
					const DasJdo* pSyms = DasJdo_get(pV->value, "symbols");
					CHECK((pSyms != NULL)&&(pSyms->type == das_json_type_ary), "snapshot var without symbols");
					if(!bBytes && (daswasm_var_intrRank(pVar) == 1) && (daswasm_var_compSym(pVar, 0) != NULL))
						CHECK((int)((das_json_ary*)pSyms->value)->length == daswasm_var_intrShapeAt(pVar, 0), "symbol count differs from inner extent");
					const DasJdo* pP = DasJdo_get(pV->value, "props");
					CHECK((pP != NULL)&&(pP->type == das_json_type_dict), "snapshot var without props");
					CHECK((int)((das_json_dict*)pP->value)->length == daswasm_desc_propCount((DasDesc*)pVar), "var property count differs");
				}
			}
		}
		free(pJdo);
		daswasm_free(sJson);
	}
	printf("INFO: %s: snapshot agrees with the accessors for %d dataset(s)\n", sPath, nDs);
	return 0;
}

int main(int argc, char** argv)
{
	daswasm_init(argv[0]);

	/* A vector das3 binary, a rank 2 string das3 stream, a das2 text
	   stream that exercises the up-convert path and vtTime arrays, and a
	   ragged waveform stream for the partial-index access */
	const char* aFiles[] = {
		"examples/ex17_vector_noframe.d3b",
		"examples/ex35_strings_rank2.d3b",
		"examples/ex01_polar_mfe.d2t",
		"examples/ex19_cassini_ragged_wfrm.d3t",
		"examples/ex08_cassini_rpws_survey.d2t",   /* headers after data */
		"examples/ex09_juno_waves_survey.d2t",
		NULL
	};

	for(int i = 0; aFiles[i] != NULL; ++i){
		DasWasmRdr* pRdr = readFile(aFiles[i], 997);
		if(pRdr == NULL) return 64;

		if(walkStream(DasWasmRdr_stream(pRdr), aFiles[i]) != 0)
			return 64;
		if(checkSnapshot(DasWasmRdr_stream(pRdr), aFiles[i]) != 0)
			return 64;

		/* stream-level properties flow through the descriptor calls */
		DasStream* pSd = DasWasmRdr_stream(pRdr);
		int nProps = daswasm_desc_propCount((DasDesc*)pSd);
		for(int j = 0; j < nProps; ++j){
			if((daswasm_desc_propName((DasDesc*)pSd, j) == NULL)||
			   (daswasm_desc_propValue((DasDesc*)pSd, j) == NULL)||
			   (daswasm_desc_propType((DasDesc*)pSd, j) == NULL)){
				printf("ERROR: property %d of %s has NULL parts\n", j, aFiles[i]);
				return 64;
			}
		}

		del_DasWasmRdr(pRdr);
	}

	/* Ownership handoff: take the stream, kill the reader, walk, free */
	DasWasmRdr* pRdr = readFile(aFiles[0], 997);
	if(pRdr == NULL) return 64;
	DasStream* pSd = DasWasmRdr_take(pRdr);
	del_DasWasmRdr(pRdr);
	if(walkStream(pSd, "taken stream") != 0) return 64;
	daswasm_stream_free(pSd);

	/* Error path: garbage must fail loud and leave a message */
	printf("INFO: ERROR log lines below are intentional, provoked by negative checks\n");
	pRdr = new_DasWasmRdr();
	if(DasWasmRdr_feed(pRdr, (const ubyte*)"not a das stream", 16) == 0){
		printf("ERROR: garbage input accepted\n");
		return 64;
	}
	if(daswasm_lastError()[0] == '\0'){
		printf("ERROR: parse failure left no error message\n");
		return 64;
	}
	(void)DasWasmRdr_end(pRdr);
	del_DasWasmRdr(pRdr);

	printf("INFO: All FFI layer checks passed\n");
	return 0;
}
