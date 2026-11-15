/**
 * Docker object names for the backup e2e (`test-backup-restore.mjs`). Test
 * tooling only; not shipped in the image.
 *
 * `--container-prefix <name>` names every container (the server and each
 * tool container), the network and the throwaway tools image
 * `<name>-...`, so parallel runs on a shared machine each stay in their own
 * namespace. Without the flag, TEST_CONTAINER_PREFIX (shared with
 * `db:test-migrations` and `runtime:test-operations`, which parse it with
 * containerPrefix() below) sets it, so a chained run (`pnpm verify`, CI) can
 * be namespaced without passing arguments through. The flag wins over the
 * variable; with neither, the prefix is the harness's default
 * (`cockpit-context-backup-test` here).
 */
export const DEFAULT_CONTAINER_PREFIX = "cockpit-context-backup-test";

/**
 * A prefix that is a valid Docker container/network/volume name AND, with
 * `-tools` appended, a valid image repository path component: lowercase
 * alphanumerics joined by single `.`/`_`, a double `__`, or runs of `-`
 * (distribution/reference), so `a..b` or `a-` is refused here, not by Docker
 * in the middle of setup. Bounded so every derived container name stays a
 * valid DNS label (at most 63 bytes): the tool containers reach the server by
 * its container name, and e2eNames() checks that limit for the actual suffix.
 */
const PREFIX = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const MAX_PREFIX = 32;
/** Container names are hostnames on the test network: one DNS label each. */
const MAX_HOSTNAME = 63;

/** The environment variable every Docker test harness reads for its prefix. */
const PREFIX_ENV = "TEST_CONTAINER_PREFIX";

/**
 * @param {string[]} argv the script's own arguments (process.argv.slice(2))
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [fallback] the harness's own default prefix
 */
export function containerPrefix(argv, env = process.env, fallback = DEFAULT_CONTAINER_PREFIX) {
  const index = argv.indexOf("--container-prefix");
  const fromEnv = env[PREFIX_ENV];
  if (index === -1 && fromEnv === undefined) return fallback;
  const [prefix, source] =
    index === -1 ? [fromEnv, PREFIX_ENV] : [argv[index + 1], "--container-prefix"];
  if (!prefix || prefix.length > MAX_PREFIX || !PREFIX.test(prefix))
    throw new Error(
      `${source} needs a Docker name prefix: lowercase letters and digits joined by ".", "_", "__" or "-", at most ${MAX_PREFIX} characters`,
    );
  return prefix;
}

/**
 * @param {string} prefix
 * @param {string} suffix per-run, so two runs with one prefix never collide
 */
export function e2eNames(prefix, suffix) {
  // The longest container names: the server and a tool container (a run
  // starts far fewer than 1000).
  for (const host of [`${prefix}-pg-${suffix}`, `${prefix}-tool-${suffix}-999`])
    if (host.length > MAX_HOSTNAME)
      throw new Error(`--container-prefix is too long: ${host} exceeds ${MAX_HOSTNAME} characters`);
  return {
    toolsImage: `${prefix}-tools:${suffix}`,
    network: `${prefix}-net-${suffix}`,
    pg: `${prefix}-pg-${suffix}`,
    /** @param {number} n */
    tool: (n) => `${prefix}-tool-${suffix}-${n}`,
  };
}
