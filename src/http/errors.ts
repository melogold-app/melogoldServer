/**
 * `AppError`: the only way services refuse a request (API §2). The HTTP status and the default message come from the
 * registry (`error-codes.ts`); details are typed per code, so `device_limit_reached` cannot be thrown without
 * `deviceLimit` and `deviceCount`.
 *
 * ```ts
 * throw new AppError("login_taken");
 * throw new AppError("device_limit_reached", { details: { deviceLimit: 20, deviceCount: 20 } });
 * throw new AppError("server_busy", { details: { retryAfterSeconds: 5 } });
 * ```
 *
 * Services never import this module's types into the database layer; `src/db/errors.ts` maps driver errors on its
 * own and the error handler turns them into `server_busy` / `unavailable` / `storage_full`.
 */
import { ERROR_CODES } from "./error-codes.ts";
import type { CodeWithRequiredDetails, ErrorCode, ErrorDetailValues, ErrorDetailsFor } from "./error-codes.ts";

export type AppErrorOptions<C extends ErrorCode> = {
  /** English text for logs (4xx only; 5xx always send the generic message of the code). */
  message?: string;
  details?: ErrorDetailsFor<C>;
  /** Extra response headers. `Retry-After` is derived from `retryAfterSeconds` automatically. */
  headers?: Readonly<Record<string, string>>;
  cause?: unknown;
};

type AppErrorArgs<C extends ErrorCode> = C extends CodeWithRequiredDetails
  ? [options: AppErrorOptions<C> & { details: ErrorDetailsFor<C> }]
  : [options?: AppErrorOptions<C>];

export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly statusCode: number;
  readonly details: Readonly<Partial<ErrorDetailValues>>;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: C, ...[options]: AppErrorArgs<C>) {
    const spec = Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code] : undefined;
    if (spec === undefined) throw new TypeError(`"${code}" is not a registered error code (src/http/error-codes.ts)`);
    super(options?.message ?? spec.message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.statusCode = spec.status;
    const details: Partial<ErrorDetailValues> | undefined = options?.details;
    this.details = Object.freeze({ ...details });
    this.headers = Object.freeze({ ...options?.headers });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
