/**
 * @cockpit-context/repos — the git layer: remote URL validation, hardened git exec,
 * bare blobless clones, fetch policy, version/ref resolution, worktree
 * checkouts, storage accounting, SSH keys and known hosts
 * (docs/product.md).
 *
 * Every service takes ids and owner ids from the caller; procedures must
 * check ownership (docs/access-matrix.md) before calling in.
 */

export {
  type HostResolver,
  isForbiddenAddress,
  resolvePublicAddress,
} from "./address-policy";
export {
  type CheckoutRecord,
  checkoutSelect,
  deleteCheckout,
  ensureCheckout,
  materializeCheckout,
  type ReadyCheckout,
} from "./checkouts";
export { maxStorageBytes } from "./config";
export { isRepoError, RepoError, type RepoErrorCode, type RepoErrorDetails } from "./errors";
export { GIT_HARDENING_CONFIG, GitCommandError } from "./git-exec";
export {
  confirmKnownHost,
  deleteKnownHost,
  type HostScan,
  isPinnedHost,
  type KnownHostView,
  knownHostSelect,
  listKnownHosts,
  PINNED_HOST_KEYS,
  pinnedHostKeys,
  scanKnownHost,
  trustedHostKeys,
} from "./known-hosts";
export { withRepositoryLock } from "./locks";
export { fetchNpmGitHead } from "./npm-registry";
export type { PublicKey, SupportedKeyType } from "./openssh";
export {
  ECOSYSTEMS,
  type Ecosystem,
  fromStoredEcosystem,
  isEcosystem,
  normalizePackageName,
  packageIdentifier,
  parsePackageIdentifier,
  type StoredEcosystem,
  toStoredEcosystem,
} from "./package-names";
export { checkoutDir, repositoryDir, sweepTmpDir } from "./paths";
export { type PruneStorageOptions, type PruneStorageResult, pruneStorage } from "./prune";
export { type RecoveryResult, recoverInterruptedGitWork } from "./recovery";
export {
  lookupRegistry,
  normalizeRepositoryUrl,
  type RegistryLookupDeps,
  type RegistryLookupResult,
  type RegistrySuggestion,
} from "./registry-lookup";
export { type ParsedRemote, parseRemoteUrl, validateRemoteUrl } from "./remote-url";
export {
  type CheckoutRemovalListener,
  notifyCheckoutRemoval,
  onCheckoutRemoval,
} from "./removal-hooks";
export {
  cloneRepository,
  createSnapshotRepository,
  deleteRepository,
  ensureRepository,
  type FetchMode,
  fetchRepository,
  type GitLayerDeps,
  isFetchStale,
  type MeasureResult,
  measure,
  packageResolveSelect,
  type RepositoryRecord,
  type RepositorySource,
  type ResolvedTarget,
  type ResolvePackageRecord,
  type ResolveTargetInput,
  repositorySelect,
  resolveTarget,
  safeSnapshotError,
  snapshotRefMissing,
  totalStorageBytes,
  updateSnapshotRepository,
} from "./repositories";
export { onRepositoryChange } from "./repository-change-hooks";
export { cachedResolveTarget, resolutionCache } from "./resolution-cache";
export {
  isSafeRefName,
  nearestTags,
  type Resolution,
  type ResolvedFrom,
  versionTagCandidates,
} from "./resolve";
export {
  deleteSshKey,
  generateSshKey,
  getSshKey,
  importSshKey,
  listSshKeys,
  type SshKeyView,
  sshKeyPublicSelect,
} from "./ssh-keys";
export { MAX_PASSPHRASE_BYTES, normalizeImportedPrivateKey } from "./ssh-tools";
export { type DirectorySize, type MeasureFn, measureDirectory } from "./storage";
