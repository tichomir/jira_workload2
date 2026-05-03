/**
 * authErrorChannel — lightweight pub/sub for HTTP auth errors surfaced by the
 * canonical API client.  Components subscribe while mounted and unsubscribe on
 * teardown; the API layer calls emitAuthError when a 401 or 403 is received.
 */

export type AuthErrorCode = 401 | 403;

type AuthErrorHandler = (code: AuthErrorCode) => void;

const subscribers: Set<AuthErrorHandler> = new Set();

/**
 * Subscribe to auth errors.
 * Returns an unsubscribe function — call it in a useEffect cleanup.
 */
export function subscribeAuthError(handler: AuthErrorHandler): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

/** Emit an auth error to all current subscribers. */
export function emitAuthError(code: AuthErrorCode): void {
  subscribers.forEach((h) => h(code));
}
