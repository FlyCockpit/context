import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url);
const DOCKER_DEFAULT_SECRET_SHA256 =
  "7b392ad9b78b37bfede6f3c8d35f7a26c4f2641ebff21f7599b7fe2a6387fd9d";
const DATABASE_USERS = new Set(["postgres"]);
const DATABASE_PASSWORDS = new Set(["password", "test", "drill"]);
const DATABASE_PORTS = new Set(["", "5432", "55432"]);

const PATTERNS = [
  {
    kind: "application-secret",
    expression:
      "(^|[[:space:]])(BETTER_AUTH_SECRET|VAPID_PRIVATE_KEY)[[:space:]]*=[[:space:]]*[^[:space:]#]+",
  },
  {
    kind: "database-credential",
    expression:
      "DATABASE_URL[[:space:]]*=[[:space:]]*postgres(ql)?://[^[:space:]]+:[^[:space:]@]+@",
  },
  { kind: "private-key", expression: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secretAssignments(line) {
  return [...line.matchAll(/\b(BETTER_AUTH_SECRET|VAPID_PRIVATE_KEY)\s*=\s*([^\s#]+)/g)].map(
    (match) => ({ key: match[1], value: match[2] }),
  );
}

function databasePlaceholders(line) {
  const matches = [...line.matchAll(/\bDATABASE_URL\s*=\s*(postgres(?:ql)?:\/\/[^\s`"'\\]+)/g)];
  if (matches.length === 0) return false;
  return matches.every((match) => databasePlaceholder(match[1] ?? ""));
}

function databasePlaceholder(value) {
  if (!value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
    parsed.hostname === "localhost" &&
    DATABASE_USERS.has(parsed.username) &&
    DATABASE_PASSWORDS.has(parsed.password) &&
    DATABASE_PORTS.has(parsed.port) &&
    // The database name is product identity, not a credential. Permit one
    // ordinary local identifier so a rebrand does not require editing this
    // scanner, while retaining exact disposable host/user/password semantics.
    /^[A-Za-z0-9_-]+$/.test(parsed.pathname.slice(1)) &&
    !parsed.search &&
    !parsed.hash
  );
}

/**
 * These are semantic placeholders, not path/prefix exemptions. A matching
 * detector line is still rejected unless its value itself is one of the small,
 * documented non-credential forms below. The docker default is pinned by hash
 * so changing it requires an intentional review of this allowlist.
 */
function documentedSecretAssignment(file, assignment) {
  if (
    file === ".env.docker.defaults" &&
    assignment.key === "BETTER_AUTH_SECRET" &&
    sha256(assignment.value) === DOCKER_DEFAULT_SECRET_SHA256
  ) {
    return true;
  }
  if (assignment.key === "VAPID_PRIVATE_KEY" && assignment.value === "…") return true;
  if (assignment.key !== "BETTER_AUTH_SECRET") return false;
  return new Set([
    '"your-secret-min-32-chars"',
    "$(openssl",
    "<openssl",
    ["$", "{{server.BETTER_AUTH_SECRET}}"].join(""),
  ]).has(assignment.value);
}

export function isDocumentedPlaceholder(finding) {
  if (finding.kind === "database-credential") return databasePlaceholders(finding.text);
  if (finding.kind === "private-key") return false;
  const assignments = secretAssignments(finding.text);
  return (
    assignments.length > 0 &&
    assignments.every((assignment) => documentedSecretAssignment(finding.file, assignment))
  );
}

function parseGitGrep(output) {
  const findings = [];
  for (const entry of output.split("\n")) {
    if (!entry) continue;
    const match = /^([^:\n]+):(\d+):(.*)$/.exec(entry);
    if (!match) throw new Error("git grep returned an unreadable finding");
    const [, file, lineText, text] = match;
    const line = Number(lineText);
    if (!file || text === undefined) continue;
    if (!Number.isInteger(line) || line < 1) {
      throw new Error("git grep returned an unreadable line number");
    }
    findings.push({ file, line, text });
  }
  return findings;
}

function scanPattern(pattern) {
  const result = spawnSync("git", ["grep", "-n", "-E", "-e", pattern.expression, "--", "."], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `could not run the tracked-file template secret scan (${result.error?.code ?? result.status ?? "unknown"})`,
    );
  }
  return parseGitGrep(result.stdout).map((finding) => ({ ...finding, kind: pattern.kind }));
}

export function collectResidualFindings(findings) {
  return findings.filter((finding) => !isDocumentedPlaceholder(finding));
}

function selfTest() {
  const database = ["post", "gresql://postgres:password@localhost:5432/cockpit_context"].join("");
  const authKey = ["BETTER_AUTH", "_SECRET"].join("");
  const vapidKey = ["VAPID_PRIVATE", "_KEY"].join("");
  const assignment = (key, value) => [key, "=", value].join("");
  const safe = [
    {
      file: ".env.example",
      line: 1,
      text: `DATABASE_URL=${database}`,
      kind: "database-credential",
    },
    {
      file: ".env.example",
      line: 2,
      text: `DATABASE_URL=${database.replace("cockpit_context", "renamed_app")}`,
      kind: "database-credential",
    },
    {
      file: ".env.docker.defaults",
      line: 1,
      text: assignment(
        authKey,
        ["docker_dev_placeholder_do_not_use_in_production_", "1234567890abcdef"].join(""),
      ),
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 1,
      text: assignment(authKey, '"your-secret-min-32-chars"'),
      kind: "application-secret",
    },
    { file: "README.md", line: 1, text: assignment(vapidKey, "…"), kind: "application-secret" },
  ];
  if (collectResidualFindings(safe).length !== 0) {
    throw new Error("documented semantic placeholders should be accepted");
  }
  const unsafe = safe.concat([
    {
      file: "example.example",
      line: 2,
      text: `DATABASE_URL=${database.replace("password", "not-a-placeholder")}`,
      kind: "database-credential",
    },
    {
      file: "example.example",
      line: 3,
      text: `${`DATABASE_URL=${database.replace("cockpit_context", "renamed_app?sslmode=require")}`}`,
      kind: "database-credential",
    },
    {
      file: ".env.docker.defaults",
      line: 2,
      text: assignment(authKey, "changed-value"),
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 2,
      text: assignment(vapidKey, "not-a-placeholder"),
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 3,
      text: `DATABASE_URL=${database} ${assignment(authKey, "not-a-placeholder")}`,
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 4,
      text: `DATABASE_URL=${database} ${["-----BE", "GIN PRIVATE KEY-----"].join("")}`,
      kind: "private-key",
    },
    {
      file: "README.md",
      line: 5,
      text: `${assignment(authKey, '"your-secret-min-32-chars"')} ${assignment(authKey, "not-a-placeholder")}`,
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 6,
      text: `DATABASE_URL=${database} DATABASE_URL=${database.replace("password", "not-a-placeholder")}`,
      kind: "database-credential",
    },
  ]);
  if (collectResidualFindings(unsafe).length !== 8) {
    throw new Error(
      "each matched credential occurrence must satisfy its own semantic placeholder check",
    );
  }
  console.log("template secret-pattern self-test OK");
}

function main() {
  const findings = PATTERNS.flatMap(scanPattern);
  const residual = collectResidualFindings(findings);
  if (residual.length > 0) {
    for (const finding of residual) {
      console.error(`::error file=${finding.file},line=${finding.line}::Potential ${finding.kind}`);
    }
    console.error(
      "::error::Potential private secret committed. Rotate the secret and remove it from git history if it was real.",
    );
    process.exit(1);
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  main();
}
