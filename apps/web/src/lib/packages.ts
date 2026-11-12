import type { AppRouterClient } from "@cockpit-context/api/routers/index";
import { z } from "zod";

/**
 * Client-side helpers for the Packages and Proposals screens
 * (docs/product.md): the form model shared by the create
 * dialog, the approve dialog and the edit sheet, and display helpers for
 * checkouts. The server validates every field again; these rules only give
 * the user feedback before a round trip.
 */

type Client = AppRouterClient;
export type PackageListItem = Awaited<ReturnType<Client["packages"]["list"]>>["items"][number];
export type PackageDetail = Awaited<ReturnType<Client["packages"]["get"]>>;
export type Proposal = Awaited<ReturnType<Client["proposals"]["list"]>>["items"][number];
export type CheckoutRow = Awaited<
  ReturnType<Client["repositories"]["listCheckouts"]>
>["items"][number];
export type Ecosystem = PackageListItem["ecosystem"];
export type RegistryEcosystem = Exclude<Ecosystem, "git">;

export const ECOSYSTEMS = [
  "npm",
  "pypi",
  "cargo",
  "go",
  "git",
] as const satisfies readonly Ecosystem[];

export function hasRegistry(ecosystem: Ecosystem): ecosystem is RegistryEcosystem {
  return ecosystem !== "git";
}

/**
 * True for the remote spellings the git layer treats as SSH: `ssh://…` and
 * scp-like `user@host:path`. Anything else (https, or a typo) needs no key.
 */
export function isSshRemote(url: string): boolean {
  const value = url.trim();
  if (/^ssh:\/\//i.test(value)) return true;
  if (value.includes("://")) return false;
  return /^[^\s@/:]+@[^\s/:]+:\S/.test(value);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export type ResolvedTarget =
  | { kind: "tag" | "branch"; label: string }
  | { kind: "commit"; label: string }
  | { kind: "npmGitHead"; label: string };

/**
 * `tag:v5.0.0` → a tag labelled `v5.0.0`; `commit`, `npm-gitHead` and an
 * unrecorded origin show the short commit.
 */
export function describeResolvedFrom(resolvedFrom: string | null, sha: string): ResolvedTarget {
  if (resolvedFrom === null) return { kind: "commit", label: shortSha(sha) };
  if (resolvedFrom.startsWith("tag:")) return { kind: "tag", label: resolvedFrom.slice(4) };
  if (resolvedFrom.startsWith("branch:")) return { kind: "branch", label: resolvedFrom.slice(7) };
  if (resolvedFrom === "npm-gitHead") return { kind: "npmGitHead", label: shortSha(sha) };
  return { kind: "commit", label: shortSha(sha) };
}

const BYTE_UNITS = ["kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/**
 * `1536` → `1.5 kB` in the active locale (decimal units, as `du -h --si`
 * would). Kilobytes are the smallest unit: a checkout is never smaller.
 */
export function formatBytes(bytes: number, locale: string): string {
  let value = Math.max(0, bytes) / 1000;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: value >= 100 || value === 0 ? 0 : 1,
  }).format(value);
}

// ── The package form ──

/** Every field is a string in the form; blanks become `null` (cleared) or are left out. */
export type PackageFormValues = {
  ecosystem: Ecosystem;
  name: string;
  displayName: string;
  gitUrl: string;
  sshKeyId: string;
  keyMode: string;
  privateKey: string;
  passphrase: string;
  saveKey: boolean;
  keyName: string;
  isSnapshot: boolean;
  subdirectory: string;
  tagPattern: string;
  defaultRef: string;
  notes: string;
};

export function emptyPackageForm(ecosystem: Ecosystem = "npm"): PackageFormValues {
  return {
    ecosystem,
    name: "",
    displayName: "",
    gitUrl: "",
    sshKeyId: "",
    keyMode: "saved",
    privateKey: "",
    passphrase: "",
    saveKey: false,
    keyName: "",
    isSnapshot: false,
    subdirectory: "",
    tagPattern: "",
    defaultRef: "",
    notes: "",
  };
}

/** The approve dialog starts from the agent's suggestions; the owner can change any of them. */
export function proposalToFormValues(proposal: Proposal): PackageFormValues {
  return {
    ...emptyPackageForm(proposal.ecosystem),
    name: proposal.name,
    displayName: proposal.displayName ?? "",
    gitUrl: proposal.gitUrl ?? "",
    subdirectory: proposal.subdirectory ?? "",
  };
}

export function packageToFormValues(pkg: PackageDetail): PackageFormValues {
  return {
    ...emptyPackageForm(pkg.ecosystem),
    isSnapshot: pkg.isSnapshot,
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    displayName: pkg.displayName,
    gitUrl: pkg.gitUrl,
    sshKeyId: pkg.sshKey?.id ?? "",
    subdirectory: pkg.subdirectory ?? "",
    tagPattern: pkg.tagPattern ?? "",
    defaultRef: pkg.defaultRef ?? "",
    notes: pkg.notes ?? "",
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The key only travels with an SSH remote; HTTPS remotes never keep one. */
function keyFor(values: PackageFormValues): string | null {
  return isSshRemote(values.gitUrl) ? blankToNull(values.sshKeyId) : null;
}

export function pastedKeyInput(values: PackageFormValues) {
  return {
    privateKey: values.privateKey,
    passphrase: values.passphrase || undefined,
    save: values.saveKey,
    name: values.saveKey ? values.keyName.trim() : undefined,
  };
}

function editableFields(values: PackageFormValues) {
  return {
    displayName: blankToNull(values.displayName) ?? undefined,
    gitUrl: values.gitUrl.trim(),
    sshKeyId: keyFor(values),
    subdirectory: blankToNull(values.subdirectory),
    tagPattern: blankToNull(values.tagPattern),
    defaultRef: blankToNull(values.defaultRef),
    notes: blankToNull(values.notes),
  };
}

function oneTimeKeyFor(values: PackageFormValues) {
  return isSshRemote(values.gitUrl) && values.keyMode === "once"
    ? { sshKeyId: null, oneTimeKey: pastedKeyInput(values) }
    : {};
}

export function toCreateInput(values: PackageFormValues) {
  return {
    ecosystem: values.ecosystem,
    name: values.name.trim(),
    ...editableFields(values),
    ...oneTimeKeyFor(values),
  };
}

export function toApproveInput(id: string, values: PackageFormValues) {
  return { id, ...editableFields(values), ...oneTimeKeyFor(values) };
}

/**
 * Only the fields that changed. The git URL and key travel only when one of
 * them changed: saving them re-validates the remote (a DNS lookup, budgeted)
 * and unlinks the clone.
 */
export function toUpdateInput(id: string, before: PackageFormValues, after: PackageFormValues) {
  const prev = editableFields(before);
  const next = editableFields(after);
  const input: {
    id: string;
    displayName?: string;
    gitUrl?: string;
    sshKeyId?: string | null;
    subdirectory?: string | null;
    tagPattern?: string | null;
    defaultRef?: string | null;
    notes?: string | null;
  } = { id };
  if (next.displayName !== undefined && next.displayName !== prev.displayName) {
    input.displayName = next.displayName;
  }
  if (next.gitUrl !== prev.gitUrl || next.sshKeyId !== prev.sshKeyId) {
    input.gitUrl = next.gitUrl;
    input.sshKeyId = next.sshKeyId;
  }
  if (next.subdirectory !== prev.subdirectory) input.subdirectory = next.subdirectory;
  if (next.tagPattern !== prev.tagPattern) input.tagPattern = next.tagPattern;
  if (next.defaultRef !== prev.defaultRef) input.defaultRef = next.defaultRef;
  if (next.notes !== prev.notes) input.notes = next.notes;
  return input;
}

export function hasUpdates(input: ReturnType<typeof toUpdateInput>): boolean {
  return Object.keys(input).length > 1;
}

const SUBDIRECTORY_CHARS = /^[A-Za-z0-9._@+/-]+$/;

function validSubdirectory(value: string): boolean {
  const path = value.trim().replace(/\/+$/, "");
  return (
    SUBDIRECTORY_CHARS.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export type PackageFormMessages = {
  sshKeyRequired: string;
  privateKeyRequired: string;
  keyNameRequired: string;
  subdirectory: string;
  tagPattern: string;
};

/**
 * Client-side rules mirroring `packages/api/src/lib/packages.ts`. Bare
 * `min`/`max` use the locale error map; the custom rules take translated copy.
 */
export function buildPackageFormSchema(messages: PackageFormMessages) {
  return z
    .object({
      ecosystem: z.enum(ECOSYSTEMS),
      name: z.string().trim().min(1).max(200),
      displayName: z.string().trim().max(200),
      gitUrl: z.string().trim().min(1).max(2_048),
      sshKeyId: z.string(),
      keyMode: z.string(),
      privateKey: z.string().max(16_384),
      passphrase: z.string().max(4096),
      saveKey: z.boolean(),
      keyName: z.string().trim().max(100),
      isSnapshot: z.boolean(),
      subdirectory: z.string().trim().max(300),
      tagPattern: z.string().trim().max(200),
      defaultRef: z.string().trim().max(250),
      notes: z.string().trim().max(10_000),
    })
    .superRefine((values, ctx) => {
      if (
        isSshRemote(values.gitUrl) &&
        values.keyMode !== "once" &&
        !values.isSnapshot &&
        values.sshKeyId === ""
      ) {
        ctx.addIssue({ code: "custom", path: ["sshKeyId"], message: messages.sshKeyRequired });
      }
      if (isSshRemote(values.gitUrl) && values.keyMode === "once") {
        if (values.privateKey.trim() === "") {
          ctx.addIssue({
            code: "custom",
            path: ["privateKey"],
            message: messages.privateKeyRequired,
          });
        } else if (values.saveKey && values.keyName.trim() === "") {
          ctx.addIssue({ code: "custom", path: ["keyName"], message: messages.keyNameRequired });
        }
      }
      if (values.subdirectory.trim() !== "" && !validSubdirectory(values.subdirectory)) {
        ctx.addIssue({ code: "custom", path: ["subdirectory"], message: messages.subdirectory });
      }
      if (values.tagPattern.trim() !== "" && !values.tagPattern.includes("{version}")) {
        ctx.addIssue({ code: "custom", path: ["tagPattern"], message: messages.tagPattern });
      }
    });
}
