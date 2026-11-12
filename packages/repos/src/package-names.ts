/**
 * Package identity rules (docs/product.md): the API
 * spelling of each ecosystem, the per-ecosystem name grammar, and the
 * `<ecosystem>:<name>` identifier agents pass to the MCP tools.
 *
 * Names are validated before they are ever put into a registry URL or a
 * stored identifier, so a name can never smuggle a path (`../`), a query or a
 * second identifier into either.
 */

/** API/MCP spellings; stored as `PackageEcosystem` (SCREAMING_SNAKE_CASE). */
export const ECOSYSTEMS = ["npm", "pypi", "cargo", "go", "git"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export type StoredEcosystem = "NPM" | "PYPI" | "CARGO" | "GO" | "GIT";

const TO_STORED: Record<Ecosystem, StoredEcosystem> = {
  npm: "NPM",
  pypi: "PYPI",
  cargo: "CARGO",
  go: "GO",
  git: "GIT",
};

export function toStoredEcosystem(ecosystem: Ecosystem): StoredEcosystem {
  return TO_STORED[ecosystem];
}

export function fromStoredEcosystem(stored: StoredEcosystem): Ecosystem {
  return stored.toLowerCase() as Ecosystem;
}

export function isEcosystem(value: string): value is Ecosystem {
  return (ECOSYSTEMS as readonly string[]).includes(value);
}

// npm: lowercase, optional scope, the registry's own character set.
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// PyPI (PEP 508 project names), normalized per PEP 503 below.
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// crates.io: ASCII letter first, then letters, digits, `_` and `-`.
const CARGO_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
// Go module path elements (golang.org/x/mod/module CheckPath, simplified).
const GO_ELEMENT = /^[A-Za-z0-9._~-]+$/;
// `git:owner/repo` — a path of at least two plain segments.
const GIT_ELEMENT = /^[A-Za-z0-9._-]+$/;

const MAX_LENGTH: Record<Ecosystem, number> = {
  npm: 214,
  pypi: 200,
  cargo: 64,
  go: 300,
  git: 200,
};

function pathElementsOk(elements: string[], pattern: RegExp): boolean {
  return elements.every(
    (element) =>
      element.length > 0 &&
      element !== "." &&
      element !== ".." &&
      !element.startsWith(".") &&
      pattern.test(element),
  );
}

/**
 * Validate and normalize a package name for `ecosystem`, or `null` when it is
 * not a name that ecosystem allows. npm and PyPI names are case-insensitive
 * and come back lowercased (PyPI also collapses `-`, `_` and `.` runs to `-`);
 * cargo, Go and git names keep their case.
 */
export function normalizePackageName(ecosystem: Ecosystem, raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_LENGTH[ecosystem]) return null;
  switch (ecosystem) {
    case "npm": {
      const lower = name.toLowerCase();
      return NPM_NAME.test(lower) ? lower : null;
    }
    case "pypi":
      return PYPI_NAME.test(name) ? name.toLowerCase().replace(/[-_.]+/g, "-") : null;
    case "cargo":
      return CARGO_NAME.test(name) ? name : null;
    case "go": {
      const elements = name.split("/");
      const host = elements[0] ?? "";
      // The first element is a domain: it has a dot and no uppercase.
      if (!host.includes(".") || host !== host.toLowerCase()) return null;
      return pathElementsOk(elements, GO_ELEMENT) ? name : null;
    }
    case "git": {
      const elements = name.split("/");
      if (elements.length < 2) return null;
      return pathElementsOk(elements, GIT_ELEMENT) ? name : null;
    }
  }
}

/** `<ecosystem>:<name>`; `name` must already be normalized. */
export function packageIdentifier(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${name}`;
}

/**
 * Split and validate an identifier (`npm:@tanstack/react-query`). Returns the
 * normalized form, so `pypi:Requests` and `pypi:requests` name one package.
 */
export function parsePackageIdentifier(
  identifier: string,
): { ecosystem: Ecosystem; name: string; identifier: string } | null {
  const separator = identifier.indexOf(":");
  if (separator <= 0) return null;
  const ecosystem = identifier.slice(0, separator).trim().toLowerCase();
  if (!isEcosystem(ecosystem)) return null;
  const name = normalizePackageName(ecosystem, identifier.slice(separator + 1));
  if (name === null) return null;
  return { ecosystem, name, identifier: packageIdentifier(ecosystem, name) };
}
