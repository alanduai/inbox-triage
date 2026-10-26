/** Gmail's answer for a message or thread that no longer exists, for example one you deleted for good. */
export function isNotFound(err: unknown): boolean {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null;
  return e?.status === 404 || e?.response?.status === 404;
}

// Gmail calls give up after this long, so one call that hangs never stops the service.
export const GMAIL_TIMEOUT_MS = 60_000;
export const ATTACHMENT_TIMEOUT_MS = 180_000;
