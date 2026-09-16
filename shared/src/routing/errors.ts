/**
 * TASK-701 - failure taxonomy for the routing service.
 *
 * Coded, like MediaPipelineError and CmsIngestError, because the callers need
 * to act differently on each and must not regex a message to find out which:
 *
 *   - the stops cannot be joined          -> tell the CMS operator which stop
 *   - the provider is throttling us       -> back off, keep the bundled route
 *   - the provider is down or slow        -> retry later, keep the bundled route
 *   - the key or URL is wrong             -> a deployment problem, do not retry
 *
 * `retryable` is decided here, once, so an Edge Function and a CMS script can't
 * disagree about whether a 400 is worth a second request (it never is).
 */

export type RoutingErrorCode =
  /** VALHALLA_ROUTE_URL is unusable, or the provider needs a key and none is set. */
  | 'not_configured'
  /** The caller passed something structurally wrong: < 2 stops, NaN, lat 91. Nothing was sent. */
  | 'invalid_request'
  /** More stops than the provider accepts in one request. Nothing useful comes of retrying. */
  | 'too_many_locations'
  /**
   * Valhalla understood the request and could not route it: a stop too far from
   * any road or path for this profile, or stops in unconnected regions (an
   * island, a pedestrian-only precinct for `auto`). Fix the stops, not the code.
   */
  | 'unroutable'
  /** The route exists but exceeds the provider's distance limit for this profile. */
  | 'distance_exceeded'
  /** 401/403. Missing, wrong or revoked STADIA_API_KEY. */
  | 'unauthorized'
  /** 429. `retryAfterMs` carries the provider's Retry-After when it sent one. */
  | 'rate_limited'
  /** No response within the timeout. The request may still have been billed. */
  | 'timeout'
  /** The caller's AbortSignal fired. Not a failure of the provider; do not retry. */
  | 'aborted'
  /** DNS, TLS, connection reset - fetch itself threw. */
  | 'network'
  /** 5xx, or any status this module does not recognise. */
  | 'upstream_error'
  /** 200, but not a trip we can use: bad JSON, no shape, a shape that won't decode. */
  | 'invalid_response';

const RETRYABLE: ReadonlySet<RoutingErrorCode> = new Set(['rate_limited', 'timeout', 'network', 'upstream_error']);

export interface RoutingErrorOptions {
  /** Operator-facing context: the provider's own message, a status code. */
  detail?: string;
  /** HTTP status, when the failure came from a response. */
  status?: number;
  /** Valhalla's numeric `error_code` (e.g. 171, 442), when the body had one. */
  providerCode?: number;
  /** From Retry-After on a 429. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class RoutingError extends Error {
  readonly code: RoutingErrorCode;
  readonly retryable: boolean;
  readonly detail: string | undefined;
  readonly status: number | undefined;
  readonly providerCode: number | undefined;
  readonly retryAfterMs: number | undefined;

  // Explicit assignment, not parameter properties: `erasableSyntaxOnly`.
  constructor(code: RoutingErrorCode, message: string, options: RoutingErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'RoutingError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.detail = options.detail;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isRoutingError(value: unknown): value is RoutingError {
  return value instanceof RoutingError;
}
