import {
  MemoryArenaPublicError,
  type MemoryArenaErrorCode,
  type MemoryArenaOperationFailedRetrieval,
} from "../../benchmark/memoryarena-public/index.js";
import { memoryArenaPicorerFailureDiagnostics } from "../../benchmark/memoryarena-public/model/failure-diagnostics.js";

export interface MemoryArenaHttpError {
  status: number;
  code: MemoryArenaErrorCode | "internal_error";
  retryable: boolean;
  body: {
    detail: string;
    error_code: MemoryArenaErrorCode | "internal_error";
    retryable: boolean;
    diagnostics?: { retrieval: MemoryArenaOperationFailedRetrieval };
  };
}

/** Produces the stable public error envelope without exposing exception text. */
export function memoryArenaHttpError(error: unknown): MemoryArenaHttpError {
  if (error instanceof MemoryArenaPublicError) {
    const retrieval = memoryArenaPicorerFailureDiagnostics(error);
    return {
      status: error.httpStatus,
      code: error.code,
      retryable: error.retryable,
      body: {
        detail: error.message,
        error_code: error.code,
        retryable: error.retryable,
        ...(retrieval === undefined
          ? {}
          : { diagnostics: { retrieval } }),
      },
    };
  }
  return {
    status: 500,
    code: "internal_error",
    retryable: false,
    body: {
      detail: "Internal Server Error",
      error_code: "internal_error",
      retryable: false,
    },
  };
}
