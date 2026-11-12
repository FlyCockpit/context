/** Capture subprocess evidence without exposing form values or error argv.
 * Supply every fixture credential (including wrong answers) via secretFiles.
 * Read requests on stdin so credentials never appear in the wrapper's argv.
 * Screenshots are deliberately outside this text-only API: clear secrets first.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function redactCapture(text, secrets) {
  // AX snapshots nest multiline textarea values beneath their textbox. Remove
  // all textbox values, regardless of translated labels or password masking.
  let hiddenIndent;
  const lines = [];
  for (const line of text.split("\n")) {
    const indent = line.search(/\S/);
    if (hiddenIndent !== undefined && (!/^\s*- /.test(line) || indent > hiddenIndent)) continue;
    hiddenIndent = undefined;
    if (/^\s*- (?:textbox|searchbox)\b/.test(line)) {
      hiddenIndent = indent;
      lines.push(line.replace(/(: |: ?$).*$/, ": [redacted]"));
    } else lines.push(line);
  }
  let safe = lines.join("\n");
  // Longest first: a key or JSON-escaped key must disappear before fragments.
  const needles = new Set();
  for (const secret of secrets) {
    if (!secret) continue;
    needles.add(secret);
    needles.add(JSON.stringify(secret).slice(1, -1));
    for (const line of secret.split(/\r?\n/)) {
      // Keep unknown PEM boundaries visible to the fail-closed check below.
      if (line.length > 0 && !line.startsWith("-----")) needles.add(line);
    }
  }
  for (const needle of [...needles].sort((a, b) => b.length - a.length))
    safe = safe.split(needle).join("[redacted]");
  // Unregistered private-key material is a configuration failure, not evidence.
  if (/PRIVATE KEY|cockpit_context_[A-Za-z0-9_-]{16,}/.test(safe))
    throw new Error("Unsafe capture refused.");
  return safe;
}

export function captureCommand({ command, args = [], secretFiles, outputFile }) {
  try {
    if (!Array.isArray(secretFiles) || secretFiles.length === 0)
      throw new Error("Missing fixture credentials.");
    const secrets = secretFiles.map((path) => readFileSync(path, "utf8"));
    const result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Never propagate subprocess errors, stdout, stderr, stack, cause or argv
    // after failure (including ENOENT, timeout and maxBuffer failures).
    if (result.error || result.signal || result.status !== 0) throw new Error("Subprocess failed.");
    const safe = redactCapture(result.stdout + result.stderr, secrets);
    if (outputFile) writeFileSync(outputFile, safe, { mode: 0o600 });
    return safe;
  } catch {
    throw new Error("Evidence command failed; arguments and output withheld.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(captureCommand(JSON.parse(readFileSync(0, "utf8"))));
  } catch {
    process.stderr.write("Evidence command failed; arguments and output withheld.\n");
    process.exitCode = 1;
  }
}
