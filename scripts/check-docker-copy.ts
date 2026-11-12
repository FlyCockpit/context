/** Static Docker/Compose contract checks. No Docker daemon or credentials needed. */
import { deepStrictEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// Workspace members that legitimately have no pre-install COPY line.
const ALLOWLIST = new Set(["apps/cli", "apps/native"]);

// Stages whose COPY lists we verify. The runner stages are intentionally left
// out (they copy only what a running image needs, not the install closure).
const BUILDER = "builder";
const PROD_DEPS = "prod-deps";

/** Discover on-disk workspace members: `apps/*` / `packages/*` with a package.json. */
function discoverMembers(): Set<string> {
  const members = new Set<string>();
  for (const group of ["apps", "packages"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, group), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const id = `${group}/${name}`;
      try {
        readFileSync(resolve(ROOT, group, name, "package.json"));
        members.add(id);
      } catch {
        // no package.json → not a workspace member (e.g. an assets-only dir)
      }
    }
  }
  return members;
}

/**
 * Yield Dockerfile *logical* lines: physical lines with trailing-backslash
 * continuations folded into one, reported at the line number the instruction
 * starts on. Without this, any multi-line `RUN`/`COPY` reads as several
 * unrelated fragments — see `installRe` for why that matters.
 */
function* logicalLines(text: string): Generator<{ line: string; lineNo: number }> {
  const physical = text.split("\n");
  let buffer = "";
  let startLine = 0;

  for (let i = 0; i < physical.length; i++) {
    const raw = (physical[i] ?? "").trim();
    // A `\` continues the instruction onto the next physical line.
    const continues = raw.endsWith("\\");
    const piece = continues ? raw.slice(0, -1).trim() : raw;

    if (buffer === "") startLine = i + 1;
    buffer = buffer === "" ? piece : `${buffer} ${piece}`;

    if (continues) continue;
    yield { line: buffer, lineNo: startLine };
    buffer = "";
  }
  // A file ending on a dangling continuation still yields what it accumulated.
  if (buffer !== "") yield { line: buffer, lineNo: startLine };
}

/**
 * Split a Dockerfile into stages keyed by their `AS <name>` label and collect
 * the `COPY <group>/<name>/package.json <group>/<name>/` members in each.
 */
function parseStages(dockerfile: string): Map<string, Set<string>> {
  const text = readFileSync(resolve(ROOT, dockerfile), "utf8");
  const stages = new Map<string, Set<string>>();
  let current: Set<string> | null = null;

  // `FROM --platform=… <image> AS <stage>`: the flags between FROM and the
  // image are optional, and `AS` is case-insensitive in Dockerfile syntax.
  const stageRe = /^FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i;
  const copyRe =
    /^COPY\s+((?:apps|packages)\/[^/]+)\/package\.json\s+((?:apps|packages)\/[^/]+)\//i;
  // The whole point of the hand-enumerated COPY lines is that they land before
  // the install, so the lockfile's importers and workspace symlinks resolve
  // against real package.json files. A COPY that drifts below this breaks
  // `docker build` at install time and nothing else in CI would catch it.
  //
  // Matched against JOINED logical lines (see below), not physical ones. The
  // install is single-line today, but the standard BuildKit cache-mount form
  // splits it:
  //
  //     RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  //         pnpm install --frozen-lockfile
  //
  // A physical-line match would silently stop finding the install there, and
  // invariant 3 would check nothing while still reporting "in sync" — the exact
  // vacuous pass the other two invariants guard against.
  const installRe = /^RUN\s[\s\S]*pnpm\s+install/i;

  let currentStage = "";
  let installSeenAt = -1;

  for (const { line, lineNo } of logicalLines(text)) {
    const stageMatch = stageRe.exec(line);
    if (stageMatch) {
      current = new Set<string>();
      currentStage = stageMatch[1] ?? "";
      installSeenAt = -1;
      stages.set(currentStage, current);
      continue;
    }
    if (!current) continue;
    if (installRe.test(line)) {
      installSeenAt = lineNo;
      continue;
    }
    const copyMatch = copyRe.exec(line);
    if (copyMatch) {
      if (installSeenAt !== -1) {
        errors.push(
          `${dockerfile} (${currentStage}): COPY line for "${copyMatch[1]}" on line ${lineNo} ` +
            `comes AFTER \`pnpm install\` on line ${installSeenAt}. It must precede the install, ` +
            `or the install resolves against a missing package.json and \`docker build\` fails.`,
        );
      }
      // Both sides of the COPY must reference the same member; a mismatch is a
      // typo worth surfacing (e.g. a bad copy/paste of the destination path).
      if (copyMatch[1] !== copyMatch[2]) {
        errors.push(
          `${dockerfile}: COPY line mismatch — source "${copyMatch[1]}" but destination "${copyMatch[2]}".`,
        );
      }
      current.add(copyMatch[1] ?? "");
    }
  }
  return stages;
}

/** Require the actual source-to-destination mapping in the final runner stage. */
function runtimeScriptCopies(text: string): Set<string> {
  const copied = new Set<string>();
  let runner = false;
  for (const { line } of logicalLines(text)) {
    if (/^FROM\s/i.test(line)) {
      runner = /\sAS\s+runner$/i.test(line);
      continue;
    }
    if (!runner || !/^COPY\s/i.test(line)) continue;
    const body = line.replace(/^COPY\s+/i, "").replace(/^(?:--\S+\s+)*/, "");
    const parts: string[] = body.startsWith("[") ? JSON.parse(body) : body.split(/\s+/);
    const destination = parts.pop();
    if (!destination) continue;
    for (const source of parts) {
      const script = source.replace(/^\/app\//, "").replace(/^\.\//, "");
      if (source.startsWith("scripts/") && source.endsWith("/")) {
        const sourceDir = resolve(ROOT, source);
        const targetDir = resolve("/app", destination);
        if (targetDir === `/app/${source.replace(/\/$/, "")}` && existsSync(sourceDir)) {
          for (const entry of readdirSync(sourceDir, { recursive: true })) {
            const file = String(entry);
            if (/\.(?:mjs|sh|ts)$/.test(file)) copied.add(`${source}${file}`);
          }
        }
        continue;
      }
      if (!/^scripts\/.+\.(?:mjs|sh|ts)$/.test(script)) continue;
      const target = resolve(
        "/app",
        destination,
        parts.length > 1 || destination.endsWith("/") ? basename(source) : "",
      );
      const expected =
        script === "scripts/docker-entrypoint.sh"
          ? "/usr/local/bin/docker-entrypoint.sh"
          : `/app/${script}`;
      if (target === expected) copied.add(script);
    }
  }
  return copied;
}

/** Inventory shell siblings, Node root-relative helpers, and local ESM imports. */
function runtimeScriptReferences(script: string, text: string): Set<string> {
  const references = new Set<string>();
  for (const match of text.matchAll(
    /(?:\$\(dirname "\$0"\)|\$ROOT\/scripts|\/app\/scripts)\/([A-Za-z0-9._/-]+\.(?:mjs|sh|ts))/g,
  )) {
    references.add(`scripts/${match[1]}`);
  }
  for (const match of text.matchAll(/["'](scripts\/[A-Za-z0-9._/-]+\.(?:mjs|sh|ts))["']/g)) {
    references.add(match[1]!);
  }
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+\.(?:mjs|sh|ts))["']/g,
  )) {
    references.add(relative(ROOT, resolve(ROOT, dirname(script), match[1]!)));
  }
  return references;
}

/**
 * HEALTHCHECK `--start-period=<N>s` in seconds, or null when the directive (or
 * the flag) is absent. Reads logical lines so the standard two-line
 * `HEALTHCHECK … \ CMD …` form parses as one instruction.
 */
function healthcheckStartPeriod(text: string): number | null {
  for (const { line } of logicalLines(text)) {
    if (!/^HEALTHCHECK\s/i.test(line)) continue;
    const seconds = line.match(/--start-period=(\d+)s/i)?.[1];
    return seconds ? Number(seconds) : null;
  }
  return null;
}

/** Logical lines of one named stage (`FROM … AS <stage>`), in order. */
function stageLines(text: string, stage: string): string[] {
  const lines: string[] = [];
  let inStage = false;
  for (const { line } of logicalLines(text)) {
    const match = /^FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (match) {
      inStage = match[1] === stage;
      continue;
    }
    if (inStage) lines.push(line);
  }
  return lines;
}

/** Packages named by `apt-get install` in one stage (flags dropped). */
function aptPackages(text: string, stage: string): Set<string> {
  const packages = new Set<string>();
  for (const line of stageLines(text, stage)) {
    if (!/^RUN\s/i.test(line)) continue;
    for (const command of line.replace(/^RUN\s+/i, "").split(/&&|;/)) {
      const match = /\bapt-get\s+install\s+(.*)$/.exec(command.trim());
      if (!match?.[1]) continue;
      for (const token of match[1].split(/\s+/)) {
        if (token && !token.startsWith("-")) packages.add(token);
      }
    }
  }
  return packages;
}

/** The runtime tools Cockpit Context needs in the app image (docs/hosting.md). */
const COCKPIT_CONTEXT_RUNTIME_PACKAGES = ["git", "openssh-client", "ripgrep"];
/** Build-only packages that must never reach the runtime `base` (the runner inherits it). */
const BUILD_ONLY_PACKAGES = ["gcc", "libc6-dev", "build-essential", "cc", "clang"];
/** Where the runner installs the Landlock helper (packages/explore/src/lsp/sandbox.ts). */
const LANDLOCK_HELPER_PATH = "/usr/local/libexec/cockpit-context/cockpit-context-landlock";

/** Errors for the Cockpit Context runtime-tool invariants of one Dockerfile's text. */
function runtimeToolErrors(dockerfile: string, text: string): string[] {
  const errors: string[] = [];
  const base = aptPackages(text, "base");
  for (const name of COCKPIT_CONTEXT_RUNTIME_PACKAGES) {
    if (!base.has(name)) {
      errors.push(
        `${dockerfile} (base): apt-get install must include ${name} — the runner stage inherits ` +
          "base, and Cockpit Context's git layer and investigation agent run it at runtime.",
      );
    }
  }
  for (const name of BUILD_ONLY_PACKAGES) {
    if (base.has(name)) {
      errors.push(
        `${dockerfile} (base): must not install ${name} — a compiler never ships in the runtime ` +
          "image; the Landlock helper is compiled in the landlock-build stage.",
      );
    }
  }
  const landlockCopy = stageLines(text, "runner").some(
    (line) =>
      /^COPY\s.*--from=landlock-build\b/i.test(line) &&
      line.trim().endsWith(` ${LANDLOCK_HELPER_PATH}`) &&
      /--chown=root:root\b/.test(line) &&
      /--chmod=0?755\b/.test(line),
  );
  if (!landlockCopy) {
    errors.push(
      `${dockerfile} (runner): no \`COPY --from=landlock-build --chown=root:root --chmod=0755 … ${LANDLOCK_HELPER_PATH}\` — ` +
        "without the helper COCKPIT_CONTEXT_LSP_SANDBOX=required leaves the LSP tools off.",
    );
  }
  if (
    !stageLines(text, "runner").some((line) =>
      /^RUN\s.*scripts\/check-runtime-tools\.mjs/i.test(line),
    )
  ) {
    errors.push(
      `${dockerfile} (runner): no RUN of scripts/check-runtime-tools.mjs — the build must prove ` +
        "the runtime tools and both language servers resolve from the bundled server.",
    );
  }
  if (stageLines(text, PROD_DEPS).some((line) => /^RUN\s.*\brm\b.*typescript/i.test(line))) {
    errors.push(
      `${dockerfile} (${PROD_DEPS}): removes TypeScript from the production tree, but TypeScript 7 ` +
        "is Cockpit Context's TypeScript/JavaScript language server (packages/explore/src/lsp/specs.ts).",
    );
  }
  return errors;
}

/**
 * The lines of one service block under top-level `services:` in a compose
 * file, or null when the service is absent. Indentation-based: the service key
 * sits at two spaces, its body deeper. Comments are dropped.
 */
function composeServiceBlock(text: string, service: string): string[] | null {
  const lines = text.split("\n");
  let inServices = false;
  let body: string[] | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, "");
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      if (body) return body;
      inServices = /^services:\s*$/.test(line);
      continue;
    }
    if (!inServices) continue;
    const key = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (key) {
      if (body) return body;
      if (key[1] === service) body = [];
      continue;
    }
    body?.push(line);
  }
  return body;
}

function appSecurityErrors(file: string, app: string[]): string[] {
  const errors: string[] = [];
  /** `- item` values under each 4-space key of the service. */
  const lists = new Map<string, string[]>();
  let key = "";
  for (const line of app) {
    const keyMatch = /^ {4}([A-Za-z_]+):/.exec(line);
    if (keyMatch?.[1]) {
      key = keyMatch[1];
      continue;
    }
    const item = /^\s+-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (item?.[1] && key) lists.set(key, [...(lists.get(key) ?? []), item[1]]);
  }
  if (app.some((line) => /^\s+privileged:\s*["']?true/.test(line))) {
    errors.push(`${file} (app): must not be privileged.`);
  }
  const securityOpt = lists.get("security_opt") ?? [];
  if (securityOpt.some((opt) => /^(?:seccomp|apparmor)[=:]/.test(opt))) {
    errors.push(
      `${file} (app): must keep Docker's default seccomp and AppArmor profiles (no seccomp=/apparmor= option).`,
    );
  }
  if ((lists.get("cap_add") ?? []).length > 0) {
    errors.push(`${file} (app): must not add capabilities (cap_add).`);
  }
  if (!(lists.get("cap_drop") ?? []).includes("ALL")) {
    errors.push(`${file} (app): must drop every capability (cap_drop: [ALL]).`);
  }
  if (!securityOpt.some((opt) => /^no-new-privileges(?::true)?$/.test(opt))) {
    errors.push(`${file} (app): must set security_opt no-new-privileges:true.`);
  }
  return errors;
}

const NODE_IMAGE =
  "node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc";
const PG_IMAGE =
  "postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42";
const MAIL_IMAGE =
  "axllent/mailpit:v1.33.0@sha256:9b3a463be15354c0f0eba91697d80e3e0d8a5623ef0e627cacc836bc17fd5231";
const errors: string[] = [];

/** The runner's timed steps, plus the template's 120s backup/DDL slack. */
function startupRequirement(text: string): number | null {
  const value = (name: string) => {
    const match = text.match(new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`))?.[1];
    return match ? Number(match.replaceAll("_", "")) : null;
  };
  let ms = 120_000;
  for (const name of [
    "WAIT_TIMEOUT_MS",
    "PREDEPLOY_CATALOG_TIMEOUT_MS",
    "CONTRACT_RUN_BUDGET_MS",
    "CONTRACT_PREAMBLE_TIMEOUT_MS",
    "IMAGE_SCHEMA_TIMEOUT_MS",
    "CONTRACTS_CATALOG_TIMEOUT_MS",
    "REGISTER_TIMEOUT_MS",
  ]) {
    const part = value(name);
    if (part === null) return null;
    ms += part;
  }
  const steps = value("RUNTIME_STEPS");
  const stepMs = value("RUNTIME_STEP_TIMEOUT_MS");
  return steps === null || stepMs === null ? null : (ms + steps * stepMs) / 1000;
}

function imageErrors(file: string, text: string, dev = false): string[] {
  const found: string[] = [];
  const lines = [...logicalLines(text)]
    .map(({ line }) => line)
    .filter((line) => !line.startsWith("#"));
  const instructions = lines.join("\n");
  const nodeImages = lines.filter((line) => /^FROM node:/i.test(line));
  if (nodeImages.length !== 1 || !nodeImages.every((line) => line.split(/\s+/)[1] === NODE_IMAGE))
    found.push(`${file}: Node must use the exact Node 26 trixie digest.`);
  if (/\bcorepack\s+(?:enable|prepare)/i.test(instructions))
    found.push(`${file}: use the verified installer.`);
  if (
    !instructions.includes("COPY package.json scripts/install-pnpm.mjs /tmp/pnpm-bootstrap/") ||
    !instructions.includes(
      "node /tmp/pnpm-bootstrap/install-pnpm.mjs /tmp/pnpm-bootstrap/package.json",
    )
  )
    found.push(`${file}: missing SHA-512 verified pnpm bootstrap.`);
  if (!/^ENV SERVER_PORT=3000$/m.test(instructions)) found.push(`${file}: pin SERVER_PORT=3000.`);
  if (dev) return found;
  found.push(...runtimeToolErrors(file, text));
  const runner = stageLines(text, "runner").join("\n");
  if (!/^ARG PG_MAJOR=18$/m.test(instructions)) found.push(`${file}: PG_MAJOR must be 18.`);
  if (
    !/COPY scripts\/db\/ \.\/scripts\/db\//.test(runner) ||
    !/COPY scripts\/backup\/ \.\/scripts\/backup\//.test(runner)
  )
    found.push(`${file}: ship migration and backup script trees.`);
  if (!/COPY .*\/packages\/db\/prisma \.\/packages\/db\/prisma/.test(runner))
    found.push(`${file}: ship Prisma schema, fixtures and migrations.`);
  if (
    !/COPY .*\/packages\/db\/prisma.config.ts/.test(runner) ||
    !runner.includes("./packages/db/node_modules") ||
    !runner.includes("node_modules/prisma/build/index.js validate")
  )
    found.push(`${file}: ship and validate the Prisma CLI closure.`);
  if (!/--prod[^\n]*--include-workspace-root/.test(instructions))
    found.push(`${file}: include root production dependencies for backup scripts.`);
  if (!instructions.includes("node scripts/build-commit.mjs . > apps/server/dist/BUILD_COMMIT"))
    found.push(`${file}: write BUILD_COMMIT into the server artifact.`);
  for (const [key, value] of Object.entries({
    title: "Cockpit Context",
    source: "https://github.com/FlyCockpit/cockpit-context",
    licenses: "MIT",
    vendor: "FlyCockpit LLC",
    url: "https://github.com/FlyCockpit/cockpit-context",
    version: "$IMAGE_VERSION",
    revision: "$VCS_REF",
  })) {
    if (!runner.includes(`org.opencontainers.image.${key}="${value}"`))
      found.push(`${file}: missing OCI ${key} label.`);
  }
  if (!runner.includes("COPY LICENSE THIRD-PARTY-LICENSES.md"))
    found.push(`${file}: ship license notices.`);
  if (!runner.includes("chmod 0700 /data") || !runner.includes("chown node:node /data"))
    found.push(`${file}: /data must be node-owned, mode 0700.`);
  if (!/^USER node$/m.test(runner)) found.push(`${file}: runtime must use USER node.`);
  const grace = healthcheckStartPeriod(text);
  const required = startupRequirement(
    [
      readFileSync(resolve(ROOT, "scripts/db/migrate-runtime.mjs"), "utf8"),
      readFileSync(resolve(ROOT, "scripts/db/lib/contracts.mjs"), "utf8"),
    ].join("\n"),
  );
  if (grace === null || required === null || grace <= required)
    found.push(
      `${file}: health startup grace must exceed the migration startup budget (${required}s).`,
    );
  if (/APPLY_SCHEMA|WAIT_FOR_SCHEMA|DB_APPLIER_MODE|db-applier/.test(instructions))
    found.push(`${file}: obsolete schema-applier contract.`);
  return found;
}

function composeErrors(file: string, text: string, production = false): string[] {
  const found: string[] = [];
  const postgres = composeServiceBlock(text, "postgres") ?? [];
  if (!postgres.some((line) => line.trim() === `image: ${PG_IMAGE}`))
    found.push(`${file}: pin PostgreSQL 18 trixie by digest.`);
  if (!postgres.some((line) => line.includes("PGDATA: /var/lib/postgresql/18/docker")))
    found.push(`${file}: explicit PG18 PGDATA required.`);
  if (text.includes("/var/lib/postgresql/data"))
    found.push(`${file}: mount the PG18 parent directory.`);
  if (/^\s+container_name:/m.test(text))
    found.push(`${file}: container_name prevents project isolation.`);
  if (!production) {
    const mailpit = composeServiceBlock(text, "mailpit") ?? [];
    if (!mailpit.some((line) => line.trim() === `image: ${MAIL_IMAGE}`))
      found.push(`${file}: pin Mailpit by digest.`);
    return found;
  }
  if (/^\s+ports:/m.test(text))
    found.push(`${file}: base production stack must publish no host ports.`);
  if (/APPLY_SCHEMA|WAIT_FOR_SCHEMA|DB_APPLIER_MODE|db-applier|db-backup/.test(text))
    found.push(`${file}: obsolete schema-applier contract.`);
  const app = composeServiceBlock(text, "app") ?? [];
  for (const line of app) {
    const replicas = /^\s+(?:replicas|scale):\s*["']?(\d+)/.exec(line)?.[1];
    if (replicas !== undefined && Number(replicas) !== 1)
      found.push(`${file}: exactly one app replica is required.`);
  }
  found.push(...appSecurityErrors(file, app));
  if (!app.some((line) => /^\s+SERVER_PORT: "3000"$/.test(line)))
    found.push(`${file}: app listener must be 3000.`);
  if (!app.some((line) => /MIGRATE_ON_START:/.test(line)))
    found.push(`${file}: set the migration startup policy.`);
  if (!app.some((line) => /cockpit-context-data:\/data/.test(line)))
    found.push(`${file}: persist /data.`);
  if (!postgres.some((line) => /cockpit-context-postgres:\/var\/lib\/postgresql$/.test(line)))
    found.push(`${file}: use a project-scoped PG18 parent volume.`);
  if (!postgres.some((line) => line.trim() === "- cockpit-context-postgres"))
    found.push(`${file}: private unique database alias required.`);
  // The DB block must have only its private network mapping, never egress/proxy.
  const networkStart = postgres.findIndex((line) => line.trim() === "networks:");
  const networkLines =
    postgres
      .slice(networkStart + 1)
      .join("\n")
      .split(/^ {4}\w/m)[0] ?? "";
  if (
    networkStart < 0 ||
    !/^ {6}internal:/m.test(networkLines) ||
    /^ {6}(?!internal:|aliases:)[\w-]+:/m.test(networkLines)
  )
    found.push(`${file}: database must use only the internal network.`);
  const backup = composeServiceBlock(text, "backup") ?? [];
  if (
    !backup.some((line) => line.trim() === "profiles: [backup]") ||
    !backup.some((line) => line.includes('command: ["backup-schedule"]'))
  )
    found.push(`${file}: optional backup profile must run backup-schedule.`);
  if (
    !backup.some((line) =>
      line.includes('test: ["CMD", "node", "scripts/backup/schedule.mjs", "health"]'),
    )
  )
    found.push(`${file}: backup healthcheck must inspect scheduler status.`);
  const appImage = app.find((line) => /^ {4}image:/.test(line));
  if (!appImage || backup.find((line) => /^ {4}image:/.test(line)) !== appImage)
    found.push(`${file}: backup must use the app image.`);
  if (backup.some((line) => /^ {4}env_file:/.test(line)))
    found.push(`${file}: backup must receive only explicit backup env.`);
  for (const line of backup) {
    const key = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line)?.[1];
    if (key && !/^(?:DATABASE_URL|BACKUP_(?!MONITOR_)[A-Z0-9_]+)$/.test(key))
      found.push(`${file}: backup cannot receive ${key}.`);
  }
  for (const block of [app, backup]) {
    if (
      !block.some((line) =>
        /DATABASE_URL:.*@cockpit-context-postgres:5432\/cockpit_context/.test(line),
      )
    )
      found.push(`${file}: use the private qualified DB hostname.`);
  }
  if (!/^ {2}internal:\n {4}internal: true$/m.test(text))
    found.push(`${file}: private network must be internal.`);
  for (const volume of ["data", "postgres", "backups"]) {
    if (!new RegExp(`^  cockpit-context-${volume}:$`, "m").test(text))
      found.push(`${file}: project-scoped ${volume} volume missing.`);
  }
  return found;
}

function verify(): string[] {
  const found: string[] = [];
  const members = discoverMembers();
  for (const id of ALLOWLIST) members.delete(id);
  const text = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
  const stages = parseStages("Dockerfile");
  const builder = stages.get(BUILDER) ?? new Set<string>();
  const prod = stages.get(PROD_DEPS) ?? new Set<string>();
  for (const id of members) if (!builder.has(id)) found.push(`Dockerfile: builder missing ${id}.`);
  for (const id of builder)
    if (!members.has(id)) found.push(`Dockerfile: builder references absent member ${id}.`);
  if (!prod.size) found.push("Dockerfile: empty prod-deps COPY list.");
  for (const id of prod)
    if (!builder.has(id))
      found.push(`Dockerfile: prod-deps references absent builder member ${id}.`);
  found.push(
    ...imageErrors("Dockerfile", text),
    ...imageErrors("Dockerfile.dev", readFileSync(resolve(ROOT, "Dockerfile.dev"), "utf8"), true),
  );
  if (existsSync(resolve(ROOT, "Dockerfile.db-applier")))
    found.push("Remove the separate schema-applier image.");
  const shipped = runtimeScriptCopies(text);
  for (const script of shipped) {
    for (const ref of runtimeScriptReferences(
      script,
      readFileSync(resolve(ROOT, script), "utf8"),
    )) {
      if (!shipped.has(ref)) found.push(`Dockerfile: ${script} references unshipped ${ref}.`);
    }
  }
  for (const name of ["migrations", "fixtures", "schema"])
    if (!existsSync(resolve(ROOT, "packages/db/prisma", name)))
      found.push(`Missing Prisma ${name}.`);
  for (const file of ["compose.yaml", "docker-compose.dev.yml", "docker-compose.agent.yml"])
    found.push(
      ...composeErrors(file, readFileSync(resolve(ROOT, file), "utf8"), file === "compose.yaml"),
    );
  const vps = readFileSync(resolve(ROOT, "compose.vps.yaml"), "utf8");
  if (
    vps.trim() !==
    '# Loopback HTTP for a host reverse proxy such as Caddy.\nservices:\n  app:\n    ports: ["127.0.0.1:${COCKPIT_CONTEXT_HTTP_PORT:-3000}:3000"]'
  )
    found.push("compose.vps.yaml: overlay may add only the loopback app port.");
  const ignore = readFileSync(resolve(ROOT, ".dockerignore"), "utf8");
  for (const item of [".docker-volumes/", "!LICENSE", "!THIRD-PARTY-LICENSES.md"])
    if (!ignore.split("\n").includes(item)) found.push(`.dockerignore: missing ${item}.`);
  return [...errors, ...found];
}

if (process.argv.includes("--self-test")) {
  const text = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
  deepStrictEqual(imageErrors("Dockerfile", text), []);
  for (const [before, after] of [
    [NODE_IMAGE, "node:26-trixie-slim"],
    ["ARG PG_MAJOR=18", "ARG PG_MAJOR=17"],
    ["ENV SERVER_PORT=3000", "ENV SERVER_PORT=9000"],
    ['org.opencontainers.image.licenses="MIT"', 'org.opencontainers.image.licenses="unknown"'],
    ["COPY scripts/db/ ./scripts/db/", ""],
    ["COPY scripts/backup/ ./scripts/backup/", ""],
    ["--start-period=510s", "--start-period=300s"],
    ["chmod 0700 /data", "chmod 0777 /data"],
    ["COPY package.json scripts/install-pnpm.mjs /tmp/pnpm-bootstrap/", ""],
  ]) {
    if (imageErrors("fixture", text.replace(before!, after!)).length === 0)
      throw new Error(`Mutation escaped: ${before}`);
  }
  const compose = readFileSync(resolve(ROOT, "compose.yaml"), "utf8");
  deepStrictEqual(composeErrors("compose.yaml", compose, true), []);
  for (const mutation of [
    compose.replace(PG_IMAGE, "postgres:17"),
    compose.replace("    restart:", '    ports: ["3000:3000"]\n    restart:'),
    compose.replace("@cockpit-context-postgres:", "@postgres:"),
    compose.replace("      BACKUP_KEEP:", "      BETTER_AUTH_SECRET:"),
    compose.replace("    internal: true", "    internal: false"),
    compose.replace("      internal:\n        aliases:", "      egress:\n        aliases:"),
    compose.replace("      - ALL", "      - NET_RAW"),
    compose.replace("  app:", "  app:\n    deploy:\n      replicas: 2"),
    compose.replace("no-new-privileges:true", "seccomp:unconfined"),
  ])
    if (composeErrors("fixture", mutation, true).length === 0)
      throw new Error("Compose mutation escaped");
  deepStrictEqual(
    [
      ...runtimeScriptReferences(
        "scripts/db/main.mjs",
        'import { x } from "./lib/x.mjs"; node /app/scripts/backup/pre-migrate.sh',
      ),
    ].sort(),
    ["scripts/backup/pre-migrate.sh", "scripts/db/lib/x.mjs"],
  );
  console.log("Docker/Compose contract self-tests passed.");
}
const failures = verify();
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log("Docker COPY, runtime and Compose contracts passed.");
