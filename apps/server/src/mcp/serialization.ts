/**
 * JSON-safe serialization for MCP tool output (ported from ws-model-proxy's
 * `mcp/serialization.ts`), applied after the tools' projections and the
 * redactor:
 *
 * - `Date` → ISO string, `bigint` → decimal string;
 * - byte arrays → a fixed marker (bytes never cross the wire by accident);
 * - functions → a fixed marker;
 * - recursion depth is bounded, so a cycle cannot exhaust the stack.
 */

const MCP_BYTES_ELIDED = "[bytes-elided]";
const MCP_MAX_DEPTH_ELIDED = "[max-depth-elided]";
const MCP_FUNCTION_ELIDED = "[function-elided]";

const MAX_JSON_SAFE_DEPTH = 24;

export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_SAFE_DEPTH) return MCP_MAX_DEPTH_ELIDED;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return MCP_FUNCTION_ELIDED;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => toJsonSafe(entry, depth + 1));
  if (value instanceof Uint8Array) return MCP_BYTES_ELIDED;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = toJsonSafe(entry, depth + 1);
    }
    return out;
  }
  return null;
}
