/**
 * Custom error hierarchy for Flash Code. These let the provider layer, key
 * pool, and agent loop make precise retry/cooldown decisions instead of
 * string-matching error messages.
 */

export class FlashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Provider returned 429 (or equivalent). `retryAfterMs` drives key cooldown. */
export class RateLimitError extends FlashError {
  constructor(public readonly retryAfterMs: number, message = 'Rate limited') {
    super(message);
  }
}

/** Provider returned 500/503/overloaded — retry the same key with back-off. */
export class OverloadError extends FlashError {
  constructor(message = 'Provider overloaded') {
    super(message);
  }
}

/** Provider returned 401/403 — the key is bad; disable it for a long cooldown. */
export class AuthError extends FlashError {
  constructor(message = 'Authentication failed') {
    super(message);
  }
}

/** No usable API key is configured for the active provider. */
export class NoKeyError extends FlashError {
  constructor(message = 'No API key configured') {
    super(message);
  }
}

/** The operation was cancelled (user abort). */
export class CancelledError extends FlashError {
  constructor(message = 'Cancelled') {
    super(message);
  }
}

/** A tool received invalid arguments from the model. */
export class ToolArgumentError extends FlashError {
  constructor(message: string) {
    super(message);
  }
}

export function isAbort(e: unknown): boolean {
  return (e instanceof Error && e.name === 'AbortError') || e instanceof CancelledError;
}
