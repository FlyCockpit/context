/**
 * Validate a `redirectTo` search param so it can only point back into the
 * current locale's own routes (never to an external origin, never back to the
 * auth pages themselves). Falls back to the locale's Ongoing page (the signed-in home).
 */
export function safeRedirectTo(value: unknown, lang: string): string {
  if (typeof value !== "string") return `/${lang}/ongoing`;
  if (!value.startsWith(`/${lang}/`)) return `/${lang}/ongoing`;
  if (value.startsWith(`/${lang}/login`)) return `/${lang}/ongoing`;
  if (value.startsWith(`/${lang}/signup`)) return `/${lang}/ongoing`;
  return value;
}
