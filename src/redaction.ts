const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "apikey",
  "apiKey",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
]);

export function redactHeaders(
  headers: Record<string, string>,
  redactAuthorization: boolean,
): Record<string, string> {
  if (!redactAuthorization) {
    return { ...headers };
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    next[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return next;
}

function redactString(value: string, redactAuthorization: boolean): string {
  if (!redactAuthorization) {
    return value;
  }
  if (/^Bearer\s+/i.test(value)) {
    return "[REDACTED]";
  }
  return value;
}

export function redactValue(value: unknown, redactAuthorization: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, redactAuthorization));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactString(value, redactAuthorization) : value;
  }

  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    next[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactValue(entry, redactAuthorization);
  }
  return next;
}
