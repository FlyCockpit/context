#!/usr/bin/env node
// Read-only verification on the single VPS. Never request env or container logs:
// it reads container labels and state, and the image's baked BUILD_COMMIT file.
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sameCommit } from "./deploy-check.mjs";

const execute = promisify(execFile);
// Labels and state only: never .Config.Env, mounts' contents or logs.
const containerFormat =
  '{"id":{{json .Id}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"status":{{json .State.Status}},"running":{{json .State.Running}},"restarts":{{json .RestartCount}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}';
/** The Compose service that serves the app (compose.yaml). */
const APP_SERVICE = "app";
/** The commit the image was built from (Dockerfile; apps/server/src/build-commit.ts). */
const BUILD_COMMIT_FILE = "/app/apps/server/dist/BUILD_COMMIT";

export function parseOptions(args) {
  const options = {};
  const allowed = new Set(["project", "url", "commit", "timeout-seconds"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, "");
    if (
      !args[index].startsWith("--") ||
      !allowed.has(key) ||
      options[key] ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error(
        "Use --project <compose project> --url <https-origin> --commit <sha> [--timeout-seconds 600].",
      );
    options[key] = args[index + 1];
  }
  if (!options.project || !options.url || !options.commit)
    throw new Error("--project, --url and --commit are required.");
  // A healthy container proves only that something runs: an earlier release
  // left running by a failed redeploy is healthy too. /ready must name this one.
  options.commit = options.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(options.commit))
    throw new Error("--commit must be a commit SHA (7 to 40 hex characters).");
  // Compose project names: lowercase letters, digits, dashes and underscores.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(options.project))
    throw new Error("Invalid Compose project name.");
  const url = new URL(options.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("--url must be an HTTPS origin without credentials, query, or path.");
  const timeout = Number(options["timeout-seconds"] || 600);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
    throw new Error("Timeout must be between 1 and 3600 seconds.");
  return { ...options, url: url.origin, timeout };
}

/**
 * Judge the project's app containers: exactly one (one app replica), labelled
 * for this project and service. Returns true when it runs healthy, false while
 * it is still starting; throws when it cannot become a verified deployment.
 */
export function evaluateApp(project, containers) {
  if (containers.length === 0)
    throw new Error(`no ${APP_SERVICE} container in Compose project "${project}".`);
  if (containers.length !== 1)
    throw new Error(`expected exactly one ${APP_SERVICE} container (one app replica).`);
  const [app] = containers;
  if (app.project !== project || app.service !== APP_SERVICE)
    throw new Error("app container label mismatch.");
  if (app.health === null)
    throw new Error("app: image has no healthcheck; startup cannot be verified.");
  if (app.health === "unhealthy") throw new Error("app: the container is unhealthy.");
  if (app.status === "exited" || app.status === "dead")
    throw new Error(`app: the container has ${app.status}; inspect its logs in Dokploy.`);
  return app.running === true && app.status === "running" && app.health === "healthy";
}

const compressionEncodings = new Set(["gzip", "br", "deflate", "zstd"]);

export function evaluateCompression(contentEncoding) {
  // `identity` means "no transformation", and rare multi-encodings list tokens
  // comma-separated; any compressing token counts as compressed.
  return (contentEncoding || "")
    .split(",")
    .some((token) => compressionEncodings.has(token.trim().toLowerCase()));
}

async function reportCompression(options, { fetchPage, log, deadline }) {
  // The Node server ships no compression middleware by design — that is the
  // proxy's job — and Traefik (Dokploy's default) has compression off. `/` is
  // the probe because it redirects to the SSR'd locale home, a full HTML
  // document safely above the ~1 KB threshold below which proxies legitimately
  // skip compressing. Managed platforms compress at an edge this script cannot
  // see, so a miss is a warning, never a verification failure.
  let response;
  try {
    response = await fetchPage(`${options.url}/`, {
      redirect: "follow",
      headers: { "accept-encoding": "gzip, br" },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    });
  } catch {
    log(
      "WARNING (non-fatal): response compression could not be verified because the request to the public site root failed after readiness passed. If this is a Dokploy deployment, confirm a Traefik compression middleware is attached to the app router",
    );
    return;
  }
  const encoding = response.headers.get("content-encoding") || "";
  let bytes = null;
  try {
    bytes = (await response.arrayBuffer()).byteLength;
  } catch {
    /* Body size unavailable; judge by the header alone. */
  }
  if (evaluateCompression(encoding)) {
    log(
      `Response compression verified: the public site root was served with content-encoding: ${encoding}.`,
    );
    return;
  }
  log(
    bytes !== null && bytes < 1024
      ? `WARNING (non-fatal): response compression could not be confirmed: the public site root response was only ${bytes} bytes, and proxies skip compressing bodies under ~1 KB. Re-check a full page manually, or attach a Traefik compression middleware to the app router`
      : `WARNING (non-fatal): the public site root responded uncompressed (${bytes === null ? "unknown size" : `${bytes} bytes`}, no content-encoding) — on Dokploy, Traefik's compress middleware is off by default, so every SSR page and JSON response ships uncompressed until you attach a compress middleware to the server router (the traefik.http.middlewares.<name>.compress and traefik.http.routers.<name>.middlewares labels). Platforms whose edge compresses for you can ignore this warning. See docs/deploy.md § Response compression.`,
  );
}

async function docker(args, signal) {
  try {
    return (
      await execute("docker", args, { signal, timeout: 10_000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(
      "Docker inspection failed. Run this on the deployment host with Docker access; no configuration was changed.",
    );
  }
}

export async function verifyDeployment(
  options,
  {
    inspect = docker,
    fetchReady = fetch,
    fetchPage = fetch,
    sleep = delay,
    signal = new AbortController().signal,
    log = console.log,
  } = {},
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.timeout * 1000)]);
  const appContainers = async () => {
    const ids = (
      await inspect(
        [
          "ps",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${options.project}`,
          "--filter",
          `label=com.docker.compose.service=${APP_SERVICE}`,
          // Not `docker compose run` containers: they carry the same labels.
          "--filter",
          "label=com.docker.compose.oneoff=False",
        ],
        deadline,
      )
    )
      .split(/\s+/)
      .filter(Boolean);
    const containers = [];
    for (const id of ids)
      containers.push(
        JSON.parse(
          await inspect(
            ["inspect", "--type", "container", id, "--format", containerFormat],
            deadline,
          ),
        ),
      );
    return containers;
  };
  /** The selected container's own build commit, read once it runs healthy. */
  let containerCommit = null;
  const first = await appContainers();
  evaluateApp(options.project, first);
  log(
    `Checking the app container of Compose project "${options.project}". Run this after Dokploy finishes the deployment.`,
  );
  while (!deadline.aborted) {
    const containers = await appContainers();
    let ready = evaluateApp(options.project, containers);
    if (containers[0].id !== first[0].id || containers[0].image !== first[0].image)
      throw new Error(
        "app: deployment changed during verification; rerun after the new deploy finishes.",
      );
    // `restart: unless-stopped` hides a crash loop behind a fresh start.
    if (containers[0].restarts > first[0].restarts)
      throw new Error(
        "app: the container restarted during verification; inspect its logs in Dokploy.",
      );
    if (ready && containerCommit === null) {
      // The container itself must run the expected release, not merely some
      // healthy container while the URL answers from another deployment.
      containerCommit = (
        await inspect(["exec", containers[0].id, "cat", BUILD_COMMIT_FILE], deadline)
      ).trim();
      if (!sameCommit(containerCommit, options.commit))
        throw new Error(
          containerCommit
            ? `app: the container runs commit ${containerCommit.slice(0, 12)}, not ${options.commit.slice(0, 12)}; if a deploy is still running, rerun after it finishes.`
            : "app: the image does not know its commit (built without git metadata or BUILD_VERSION); the deployment cannot be verified.",
        );
    }
    if (ready) {
      try {
        const response = await fetchReady(`${options.url}/ready`, {
          redirect: "error",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
        });
        const body = await response.json();
        ready =
          response.status === 200 && body.ok === true && sameCommit(body.commit, options.commit);
      } catch {
        ready = false;
      }
    }
    if (ready && !deadline.aborted) {
      await reportCompression(options, { fetchPage, log, deadline });
      log(
        `Deployment verified: the app container is healthy, and the public readiness endpoint reports commit ${options.commit.slice(0, 12)}.`,
      );
      return;
    }
    try {
      await sleep(5000, undefined, { signal: deadline });
    } catch {
      /* Timeout or shutdown. */
    }
  }
  throw new Error(
    "Deployment verification timed out or was cancelled. Check the app container, the commit /ready reports and readiness in Dokploy; no rollback or database change was performed.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, () => controller.abort());
  try {
    await verifyDeployment(parseOptions(process.argv.slice(2)), { signal: controller.signal });
  } catch (error) {
    // Never echo command output, Docker config, response bodies, or URL errors.
    console.error(
      error instanceof TypeError || error instanceof SyntaxError
        ? "Invalid configuration or unexpected inspection response; deployment was not verified."
        : error.message,
    );
    process.exitCode = 1;
  }
}
