import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { type HostResolver, resolvePublicAddress } from "./address-policy";
import { RepoError } from "./errors";
import type { GitNetwork } from "./git-exec";
import { trustedHostKeys } from "./known-hosts";
import { makeInvocationTmpDir, removeInsideDataDir } from "./paths";
import type { ParsedRemote } from "./remote-url";
import { loadSshPrivateKey } from "./ssh-keys";

/**
 * Per-connect network setup for one git invocation.
 *
 * The remote host is resolved and checked (./address-policy.ts) at every
 * connect, and the checked address is pinned into the invocation so git never
 * resolves the name itself:
 *
 * - HTTPS: `-c http.curloptResolve=<host>:<port>:<address>` (TLS still
 *   verifies the certificate against the host name); redirects are off in the
 *   hardening config.
 * - SSH: `GIT_SSH_COMMAND` connects to the address (`-o HostName=`) and checks
 *   the host key under the original name (`-o HostKeyAlias=`) against a
 *   per-invocation known_hosts file holding only pinned and user-confirmed
 *   keys. `-F /dev/null` ignores any ssh config; the decrypted private key is
 *   a 0600 file in a 0700 temp directory removed when the call ends.
 */

export interface ConnectSpec {
  remote: ParsedRemote;
  /** The repository owner (PRIVATE rows); null for PUBLIC HTTPS rows. */
  ownerId: string | null;
  sshKeyId: string | null;
  /** Request-local normalized key; never serialize this structure. */
  privateKey?: string;
  signal?: AbortSignal;
}

export interface NetworkDeps {
  resolver?: HostResolver;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function curlResolveEntry(host: string, port: number, address: string): string {
  const formatted = isIP(address) === 6 ? `[${address}]` : address;
  return `http.curloptResolve=${host}:${port}:${formatted}`;
}

/** The `GIT_SSH_COMMAND` for one connect. Exported for tests. */
export function sshCommand(input: {
  keyFile: string;
  knownHostsFile: string;
  hostKeyAlias: string;
  address: string;
}): string {
  const options = [
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    "StrictHostKeyChecking=yes",
    `UserKnownHostsFile=${input.knownHostsFile}`,
    "GlobalKnownHostsFile=/dev/null",
    `HostKeyAlias=${input.hostKeyAlias}`,
    `HostName=${input.address}`,
    "CheckHostIP=no",
    "UpdateHostKeys=no",
    "BatchMode=yes",
    "ConnectTimeout=20",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "ControlMaster=no",
    "ControlPath=none",
    "PermitLocalCommand=no",
    "ForwardAgent=no",
    "ForwardX11=no",
    "ClearAllForwardings=yes",
    "ServerAliveInterval=15",
    "ServerAliveCountMax=4",
  ];
  const argv = ["ssh", "-F", "/dev/null", "-i", input.keyFile];
  for (const option of options) argv.push("-o", option);
  // git runs GIT_SSH_COMMAND through `sh -c`, so every word is quoted.
  return argv.map(shellQuote).join(" ");
}

/** The known_hosts alias: OpenSSH's own `host` / `[host]:port` spelling. */
export function hostKeyAlias(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Run `fn` with the network settings for one connect to `spec.remote`. */
export async function withGitNetwork<T>(
  spec: ConnectSpec,
  fn: (network: GitNetwork) => Promise<T>,
  deps: NetworkDeps = {},
): Promise<T> {
  spec.signal?.throwIfAborted();
  const { remote } = spec;
  if (remote.kind === "https") {
    const address = await resolvePublicAddress(remote.host, deps.resolver, { signal: spec.signal });
    const config =
      isIP(remote.host) === 0 ? [curlResolveEntry(remote.host, remote.port, address)] : [];
    spec.signal?.throwIfAborted();
    return fn({ config, env: {} });
  }

  if (!spec.ownerId || (!spec.sshKeyId && !spec.privateKey)) {
    throw new RepoError("SSH_KEY_REQUIRED", "SSH remotes need an SSH key.");
  }
  const keys = await trustedHostKeys({
    ownerId: spec.ownerId,
    host: remote.host,
    port: remote.port,
  });
  if (keys.length === 0) {
    throw new RepoError(
      "HOST_KEY_UNCONFIRMED",
      `No confirmed host key for ${hostKeyAlias(remote.host, remote.port)}; confirm one first.`,
      { host: remote.host, port: remote.port },
    );
  }
  const address = await resolvePublicAddress(remote.host, deps.resolver, { signal: spec.signal });
  const privateKey =
    spec.privateKey ?? (await loadSshPrivateKey({ ownerId: spec.ownerId, keyId: spec.sshKeyId! }));

  const dir = await makeInvocationTmpDir();
  try {
    const keyFile = path.join(dir, "id");
    const knownHostsFile = path.join(dir, "known_hosts");
    const alias = hostKeyAlias(remote.host, remote.port);
    await writeFile(keyFile, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      knownHostsFile,
      keys.map((key) => `${alias} ${key.keyType} ${key.publicKey}\n`).join(""),
      { mode: 0o600, flag: "wx" },
    );
    spec.signal?.throwIfAborted();
    return await fn({
      config: [],
      env: {
        GIT_SSH_COMMAND: sshCommand({ keyFile, knownHostsFile, hostKeyAlias: alias, address }),
        GIT_SSH_VARIANT: "ssh",
      },
    });
  } finally {
    await removeInsideDataDir(dir);
  }
}
