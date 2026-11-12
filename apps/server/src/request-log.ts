import type { MiddlewareHandler } from "hono";

/**
 * Path segments that follow these prefixes are credentials (Better-Auth's
 * emailed password-reset link is `/api/auth/reset-password/<token>`).
 */
const SECRET_PATH_PREFIXES = ["/api/auth/reset-password/"];

/**
 * The part of a request URL that is safe to write to the server log: the path
 * only, never the query string (verification links, OAuth codes and signed
 * OAuth queries travel there), with credential path segments replaced.
 * The privacy notice (`/$lang/privacy`) states what the log holds; keep the
 * two in step.
 */
export function loggablePath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    const pathStart = url.indexOf("/", url.indexOf("//") + 2);
    pathname = (pathStart === -1 ? "/" : url.slice(pathStart)).split(/[?#]/)[0] ?? "/";
  }
  for (const prefix of SECRET_PATH_PREFIXES) {
    if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
      return `${prefix}[redacted]`;
    }
  }
  return pathname;
}

function elapsed(start: number): string {
  const ms = Date.now() - start;
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * Access log in Hono's `logger()` format (`<-- GET /path`, then
 * `--> GET /path 200 12ms`) through `print`, minus the query string and any
 * credential path segment. No client IP, headers or bodies are logged.
 */
export function requestLog(print: (message: string) => void): MiddlewareHandler {
  return async (c, next) => {
    const { method } = c.req;
    const path = loggablePath(c.req.url);
    print(`<-- ${method} ${path}`);
    const start = Date.now();
    await next();
    print(`--> ${method} ${path} ${c.res.status} ${elapsed(start)}`);
  };
}
