/** Invite markers are parsed as numbers by the router's JSON search parser. */
export function parseResetPasswordSearch(search: Record<string, unknown>) {
  return {
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    invite: search.invite === "1" || search.invite === 1 ? true : undefined,
  };
}
