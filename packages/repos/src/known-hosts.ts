import prisma, { type Prisma } from "@cockpit-context/db";

import { type HostResolver, resolvePublicAddress } from "./address-policy";
import { RepoError } from "./errors";
import { type PublicKey, parsePublicKey } from "./openssh";
import { normalizeHost } from "./remote-url";
import { keyscan } from "./ssh-tools";

/**
 * SSH host keys (docs/product.md).
 *
 * github.com, gitlab.com and bitbucket.org are pinned in code from their
 * published fingerprints; every other host must be confirmed per user after a
 * scan. Clones and fetches use only these keys (StrictHostKeyChecking=yes
 * with a per-invocation known_hosts file), never ~/.ssh or a TOFU write.
 */

export type PinnedHostKey = PublicKey;

/**
 * Published host keys, verified against the fingerprints in each provider's
 * documentation (test: known-hosts.test.ts recomputes every fingerprint):
 * - https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
 * - https://docs.gitlab.com/user/gitlab_com/#ssh-known_hosts-entries
 * - https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/
 */
export const PINNED_HOST_KEYS: Readonly<Record<string, readonly PinnedHostKey[]>> = {
  "github.com": [
    {
      keyType: "ssh-ed25519",
      publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    },
    {
      keyType: "ecdsa-sha2-nistp256",
      publicKey:
        "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
      fingerprint: "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
    },
    {
      keyType: "ssh-rsa",
      publicKey:
        "AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
      fingerprint: "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
    },
  ],
  "gitlab.com": [
    {
      keyType: "ssh-ed25519",
      publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
      fingerprint: "SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8",
    },
    {
      keyType: "ecdsa-sha2-nistp256",
      publicKey:
        "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=",
      fingerprint: "SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw",
    },
    {
      keyType: "ssh-rsa",
      publicKey:
        "AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9",
      fingerprint: "SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ",
    },
  ],
  "bitbucket.org": [
    {
      keyType: "ssh-ed25519",
      publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO",
      fingerprint: "SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM",
    },
    {
      keyType: "ecdsa-sha2-nistp256",
      publicKey:
        "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=",
      fingerprint: "SHA256:FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0",
    },
    {
      keyType: "ssh-rsa",
      publicKey:
        "AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=",
      fingerprint: "SHA256:46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E",
    },
  ],
};

/** Pinned keys apply to the standard port only (e.g. not ssh.github.com:443). */
export function pinnedHostKeys(host: string, port: number): readonly PinnedHostKey[] {
  if (port !== 22) return [];
  return PINNED_HOST_KEYS[host.toLowerCase()] ?? [];
}

export function isPinnedHost(host: string): boolean {
  return Object.hasOwn(PINNED_HOST_KEYS, host.toLowerCase());
}

export const knownHostSelect = {
  id: true,
  host: true,
  port: true,
  keyType: true,
  publicKey: true,
  fingerprint: true,
  createdAt: true,
} satisfies Prisma.KnownHostSelect;

export type KnownHostView = Prisma.KnownHostGetPayload<{ select: typeof knownHostSelect }>;

/** Bound on keys considered per (owner, host, port); a host offers at most a handful. */
const MAX_KEYS_PER_HOST = 20;

function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RepoError("INVALID_HOST", "Invalid port.");
  }
  return port;
}

function checkHost(host: string): string {
  try {
    return normalizeHost(host.trim());
  } catch (error) {
    if (error instanceof RepoError && error.code === "PRIVATE_ADDRESS") throw error;
    throw new RepoError("INVALID_HOST", "Invalid host name.", {}, { cause: error });
  }
}

/**
 * The keys an SSH connection to (host, port) may accept: pinned keys plus the
 * owner's confirmed ones. Empty means "confirm a host key first".
 */
export async function trustedHostKeys(input: {
  ownerId: string;
  host: string;
  port: number;
}): Promise<{ keyType: string; publicKey: string }[]> {
  const host = input.host.toLowerCase();
  const confirmed = await prisma.knownHost.findMany({
    where: { ownerId: input.ownerId, host, port: input.port },
    select: { keyType: true, publicKey: true },
    orderBy: { createdAt: "asc" },
    take: MAX_KEYS_PER_HOST,
  });
  const pinned = pinnedHostKeys(host, input.port).map(({ keyType, publicKey }) => ({
    keyType,
    publicKey,
  }));
  return [...pinned, ...confirmed];
}

/** One page of the owner's confirmed host keys, newest first. */
export async function listKnownHosts(input: {
  ownerId: string;
  take: number;
  cursor?: string;
}): Promise<KnownHostView[]> {
  return prisma.knownHost.findMany({
    where: { ownerId: input.ownerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.take,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: knownHostSelect,
  });
}

export interface HostScan {
  host: string;
  port: number;
  /** True for github.com / gitlab.com / bitbucket.org on port 22: nothing to confirm. */
  pinned: boolean;
  keys: PublicKey[];
}

/**
 * Scan a host's SSH keys for the user to confirm. The host is validated and
 * resolved first, private/loopback addresses are refused, and ssh-keyscan is
 * pointed at the checked address (not the name) so DNS cannot change between
 * the check and the scan.
 */
export async function scanKnownHost(
  input: { host: string; port?: number; signal?: AbortSignal },
  deps: { resolver?: HostResolver; scan?: typeof keyscan } = {},
): Promise<HostScan> {
  const host = checkHost(input.host);
  const port = checkPort(input.port ?? 22);
  const pinned = pinnedHostKeys(host, port);
  if (pinned.length > 0) return { host, port, pinned: true, keys: [...pinned] };
  const address = await resolvePublicAddress(host, deps.resolver, { signal: input.signal });
  const keys = await (deps.scan ?? keyscan)(address, port);
  if (keys.length === 0) {
    throw new RepoError("HOST_SCAN_FAILED", `No SSH host keys were returned by ${host}:${port}.`);
  }
  return { host, port, pinned: false, keys };
}

/** Save one host key the user confirmed. Idempotent per (owner, host, port, fingerprint). */
export async function confirmKnownHost(input: {
  ownerId: string;
  host: string;
  port?: number;
  keyType: string;
  publicKey: string;
}): Promise<KnownHostView> {
  const host = checkHost(input.host);
  const port = checkPort(input.port ?? 22);
  const key = parsePublicKey(input.keyType, input.publicKey.trim());
  if (!key) throw new RepoError("INVALID_HOST", "That is not a supported SSH host key.");
  return prisma.knownHost.upsert({
    where: {
      ownerId_host_port_fingerprint: {
        ownerId: input.ownerId,
        host,
        port,
        fingerprint: key.fingerprint,
      },
    },
    create: {
      ownerId: input.ownerId,
      host,
      port,
      keyType: key.keyType,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
    },
    update: {},
    select: knownHostSelect,
  });
}

export async function deleteKnownHost(input: { ownerId: string; id: string }): Promise<void> {
  const result = await prisma.knownHost.deleteMany({
    where: { id: input.id, ownerId: input.ownerId },
  });
  if (result.count === 0) throw new RepoError("KNOWN_HOST_NOT_FOUND", "Known host not found.");
}
