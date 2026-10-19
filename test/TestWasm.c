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
		CHECK(daswasm_ds_shapeAt(pDs, 0) > 0, "dataset with no records");

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
					   bulk index it is either sized, ragged, or broadcast */
					for(int i = 0; i < nRank; ++i){
						int nExt = daswasm_var_shapeAt(pVar, i);
						CHECK((nExt > 0)||(nExt == daswasm_idxRagged())||
						      (nExt == daswasm_idxUnused()),
						      "variable shape entry out of contract");
					}

					/* Zero-copy path: array-backed variables expose real bytes */
					DasAry* pAry = daswasm_var_ary(pVar);
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
					if(daswasm_var_isNumeric(pVar)){
						DasAry* pQube = daswasm_var_qube(pVar);
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

int main(int argc, char** argv)
{
	daswasm_init(argv[0]);

	/* A vector das3 binary, a rank 2 string das3 stream, and a das2 text
	   stream that exercises the up-convert path and vtTime arrays */
	const char* aFiles[] = {
		"examples/ex17_vector_noframe.d3b",
		"examples/ex35_strings_rank2.d3b",
		"examples/ex01_polar_mfe.d2t",
		NULL
	};

	for(int i = 0; aFiles[i] != NULL; ++i){
		DasWasmRdr* pRdr = readFile(aFiles[i], 997);
		if(pRdr == NULL) return 64;

		if(walkStream(DasWasmRdr_stream(pRdr), aFiles[i]) != 0)
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
