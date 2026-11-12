#!/usr/bin/env node
/**
 * Optional off-site copy of backup archives, using the dedicated BACKUP_S3_*
 * credentials only — never the app-upload key (S3_*), so a stolen app-upload
 * credential cannot read database dumps.
 *
 * CLI (used by pre-migrate.sh):
 *   node s3.mjs upload <file>   → uploads to <BACKUP_S3_PREFIX>/<file name> with a
 *                                 no-overwrite condition and prints the restore
 *                                 command for that exact object.
 *
 * restore.mjs imports describeObject/downloadObject directly.
 *
 * Rules are enforced here, when a dump is written or read — never in
 * packages/env: a backup-only misconfiguration must not crash-loop the app.
 * @aws-sdk/client-s3 is imported lazily so local-only backups never need it.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { sendBackupHeartbeat } from "../backup-heartbeat.mjs";

// Keep one part in flight; createReadStream bounds memory. 512 MiB parts keep
// a 5 TB object under the 10,000-part limit.
export const MULTIPART_PART_SIZE_BYTES = 512 * 1024 * 1024;
// A single conditional PutObject handles up to the common 5 GB limit.
export const MULTIPART_THRESHOLD_BYTES = 5_000_000_000;
export const MAX_MULTIPART_PARTS = 10_000;
export const S3_MAX_ATTEMPTS = 3;

/**
 * @typedef {{
 *   bucket: string, prefix: string, region: string, endpoint: string | undefined,
 *   forcePathStyle: boolean, sse: boolean,
 *   credentials: { accessKeyId: string, secretAccessKey: string },
 * }} BackupS3Config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BackupS3Config}
 */
export function backupS3Config(env = process.env) {
  const bucket = env.BACKUP_S3_BUCKET;
  if (!bucket) throw new Error("BACKUP_S3_BUCKET is not set.");
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "BACKUP_S3_BUCKET is set but BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY are missing. " +
        "Use a dedicated backup key (GetObject, GetObjectVersion, PutObject, AbortMultipartUpload), never S3_ACCESS_KEY_ID.",
    );
  }
  if (env.S3_ACCESS_KEY_ID && accessKeyId === env.S3_ACCESS_KEY_ID) {
    throw new Error(
      "BACKUP_S3_ACCESS_KEY_ID matches S3_ACCESS_KEY_ID. Backups need a distinct key so a stolen " +
        "app-upload credential cannot read database dumps.",
    );
  }
  const region = env.BACKUP_S3_REGION || "auto";
  // "auto" is a Cloudflare R2 convention; without an endpoint the SDK would
  // address the nonexistent host s3.auto.amazonaws.com.
  if (!env.BACKUP_S3_ENDPOINT && region === "auto") {
    throw new Error(
      'BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset (the default "auto" is an R2 convention).',
    );
  }
  const prefix = (env.BACKUP_S3_PREFIX ?? "cockpit-context/prod/database").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!prefix) throw new Error("BACKUP_S3_PREFIX must not be empty.");
  return {
    bucket,
    prefix,
    region,
    endpoint: env.BACKUP_S3_ENDPOINT || undefined,
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === "true",
    // R2 and several S3-compatible providers reject AWS SSE headers. Opt in for AWS.
    sse: env.BACKUP_S3_SSE === "AES256",
    credentials: { accessKeyId, secretAccessKey },
  };
}

/** Network error messages can contain endpoint tokens; log only a known error code. */
export function safeTransferErrorMessage(error) {
  const safeNames = new Set([
    "AccessDenied",
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "NoSuchBucket",
    "NoSuchKey",
    "PreconditionFailed",
    "RequestTimeout",
    "TimeoutError",
    "AbortError",
  ]);
  return safeNames.has(error?.name)
    ? `Backup S3 request failed (${error.name}). Check the writer settings and bucket permissions.`
    : "Backup S3 request failed. Check the writer settings, bucket permissions and connectivity.";
}

/** @param {BackupS3Config} config */
export async function createS3Client(config) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
    // Stream retries are owned below so each attempt opens a fresh stream.
    maxAttempts: 1,
    // Flexible checksums stay at the SDK default here, unlike the app's upload
    // client (packages/api/src/lib/storage.ts): this client never presigns —
    // it uploads the real dump bytes itself, so the checksum covers the actual
    // body and gives the backup end-to-end integrity.
  });
}

/** @param {unknown} error */
function httpStatus(error) {
  return error && typeof error === "object" && "$metadata" in error
    ? /** @type {{ $metadata?: { httpStatusCode?: number } }} */ (error).$metadata?.httpStatusCode
    : undefined;
}

/**
 * Retry transient failures only: no HTTP status (network, timeout), 408, 429,
 * and 5xx. Any other 4xx is the request's fault and fails at once.
 *
 * A conditional write (If-None-Match: *) whose response was lost may have
 * landed: the retry then gets 412 because OUR object now exists. With
 * `confirmWritten`, such a 412 (only after an attempt that failed with no
 * HTTP status) asks it whether the object is ours; a non-null answer is the
 * success result.
 * @template T
 * @param {{ send: (command: unknown) => Promise<T> }} client
 * @param {() => unknown} makeCommand
 * @param {{ confirmWritten?: () => Promise<T | null> }} [options]
 * @returns {Promise<T>}
 */
async function sendWithRetry(client, makeCommand, options = {}) {
  let lastError;
  let responseLost = false;
  for (let attempt = 1; attempt <= S3_MAX_ATTEMPTS; attempt += 1) {
    try {
      // A consumed ReadStream cannot be replayed, so build a new command each time.
      return await client.send(makeCommand());
    } catch (error) {
      lastError = error;
      const status = httpStatus(error);
      if (status === 412 && responseLost && options.confirmWritten) {
        const confirmed = await options.confirmWritten();
        if (confirmed) return confirmed;
      }
      if (status === undefined) responseLost = true;
      else if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw error;
    }
  }
  throw lastError;
}

/**
 * Wrap a conditional-write rejection: some S3-compatible endpoints answer
 * If-None-Match with 400/405/501 instead of honoring it.
 * @param {unknown} error @param {string} operation
 */
function conditionalWriteError(error, operation) {
  const status = httpStatus(error);
  if (status === 400 || status === 405 || status === 501) {
    return new Error(
      `This S3 endpoint rejected ${operation} with If-None-Match (HTTP ${status}: ${error instanceof Error ? error.message : String(error)}); backups refuse to risk overwriting an object.`,
      { cause: error },
    );
  }
  return error;
}

/**
 * Upload one verified archive under <prefix>/<file name>. Never overwrites an
 * existing object (If-None-Match: *), including on multipart completion.
 * @param {{
 *   file: string, config?: BackupS3Config, client?: { send: (command: unknown) => Promise<any> },
 *   sdk?: Record<string, any>, multipartThresholdBytes?: number, partSizeBytes?: number,
 * }} options
 */
export async function uploadBackup({
  file,
  config = backupS3Config(),
  client,
  sdk,
  multipartThresholdBytes = MULTIPART_THRESHOLD_BYTES,
  partSizeBytes = MULTIPART_PART_SIZE_BYTES,
}) {
  const s3 = sdk ?? (await import("@aws-sdk/client-s3"));
  const s3Client = client ?? (await createS3Client(config));
  const size = (await stat(file)).size;
  const key = `${config.prefix}/${basename(file)}`;
  /** @type {Record<string, unknown>} */
  const base = { Bucket: config.bucket, Key: key, ContentType: "application/octet-stream" };
  if (config.sse) base.ServerSideEncryption = "AES256";
  /** @param {{ ETag?: string, VersionId?: string }} response */
  const result = (response) => ({
    bucket: config.bucket,
    key,
    eTag: response.ETag ?? null,
    versionId: response.VersionId ?? null,
  });
  // After a lost response, a 412 means the key exists; it is our upload when
  // its size matches (names carry a UTC timestamp, so a stranger is unlikely).
  const confirmWritten = async () => {
    try {
      const head = await s3Client.send(
        new s3.HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      return head.ContentLength === size ? { ETag: head.ETag, VersionId: head.VersionId } : null;
    } catch {
      return null; // unconfirmed: report the original 412
    }
  };

  if (size <= multipartThresholdBytes) {
    try {
      const response = await sendWithRetry(
        s3Client,
        () => new s3.PutObjectCommand({ ...base, Body: createReadStream(file), IfNoneMatch: "*" }),
        { confirmWritten },
      );
      return result(response);
    } catch (error) {
      throw conditionalWriteError(error, "PutObject");
    }
  }

  const partCount = Math.ceil(size / partSizeBytes);
  if (partCount > MAX_MULTIPART_PARTS) {
    throw new Error(
      `Backup is ${size} bytes and needs ${partCount} parts; the S3 limit is ${MAX_MULTIPART_PARTS}.`,
    );
  }
  // Initiation is not retried: a lost response would leave an upload we cannot
  // abort. Configure a bucket lifecycle rule for incomplete multipart uploads.
  const create = await s3Client.send(new s3.CreateMultipartUploadCommand(base));
  if (!create.UploadId) throw new Error("S3 did not return an UploadId.");
  let completed = false;
  try {
    const parts = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const start = (partNumber - 1) * partSizeBytes;
      const end = Math.min(size, start + partSizeBytes) - 1;
      const response = await sendWithRetry(
        s3Client,
        () =>
          new s3.UploadPartCommand({
            ...base,
            UploadId: create.UploadId,
            PartNumber: partNumber,
            Body: createReadStream(file, { start, end }),
            ContentLength: end - start + 1,
          }),
      );
      if (!response.ETag) throw new Error(`S3 did not return an ETag for part ${partNumber}.`);
      parts.push({ ETag: response.ETag, PartNumber: partNumber });
    }
    let complete;
    try {
      complete = await sendWithRetry(
        s3Client,
        () =>
          new s3.CompleteMultipartUploadCommand({
            ...base,
            UploadId: create.UploadId,
            MultipartUpload: { Parts: parts },
            IfNoneMatch: "*",
          }),
        { confirmWritten },
      );
    } catch (error) {
      throw conditionalWriteError(error, "CompleteMultipartUpload");
    }
    completed = true;
    return result(complete);
  } finally {
    if (!completed) {
      try {
        await sendWithRetry(
          s3Client,
          () => new s3.AbortMultipartUploadCommand({ ...base, UploadId: create.UploadId }),
        );
      } catch {
        console.error(
          `WARNING: could not abort incomplete multipart upload ${create.UploadId}; a bucket lifecycle rule should clean it up.`,
        );
      }
    }
  }
}

/**
 * HEAD an object and return its immutable identity.
 * @param {{ location: { bucket: string, key: string }, versionId?: string | null,
 *   config?: BackupS3Config, client?: { send: (command: unknown) => Promise<any> }, sdk?: Record<string, any> }} options
 */
export async function describeObject({
  location,
  versionId,
  config = backupS3Config(),
  client,
  sdk,
}) {
  if (location.bucket !== config.bucket) {
    throw new Error(
      `Source bucket "${location.bucket}" is not BACKUP_S3_BUCKET ("${config.bucket}"). Restore reads only the configured backup bucket.`,
    );
  }
  const s3 = sdk ?? (await import("@aws-sdk/client-s3"));
  const s3Client = client ?? (await createS3Client(config));
  const head = await s3Client
    .send(
      new s3.HeadObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
        ...(versionId ? { VersionId: versionId } : {}),
      }),
    )
    .catch((error) => {
      throw new Error(safeTransferErrorMessage(error));
    });
  return {
    eTag: /** @type {string | null} */ (head.ETag ?? null),
    versionId: /** @type {string | null} */ (head.VersionId ?? null),
    size: /** @type {number | null} */ (head.ContentLength ?? null),
    lastModified: head.LastModified instanceof Date ? head.LastModified.toISOString() : null,
  };
}

/** ETags are quoted on the wire; accept either spelling from the operator. */
export function sameETag(/** @type {string | null} */ a, /** @type {string | null} */ b) {
  if (!a || !b) return false;
  const bare = (/** @type {string} */ value) => value.replace(/^W\//, "").replace(/^"|"$/g, "");
  return bare(a) === bare(b);
}

/**
 * Download exactly the object identified by ETag (and version, if given).
 * GetObject carries If-Match, so a replaced object fails instead of downloading.
 * @param {{ location: { bucket: string, key: string }, eTag: string, versionId?: string | null,
 *   dest: string, config?: BackupS3Config, client?: { send: (command: unknown) => Promise<any> }, sdk?: Record<string, any> }} options
 */
export async function downloadObject({
  location,
  eTag,
  versionId,
  dest,
  config = backupS3Config(),
  client,
  sdk,
}) {
  const s3 = sdk ?? (await import("@aws-sdk/client-s3"));
  const s3Client = client ?? (await createS3Client(config));
  const response = await s3Client
    .send(
      new s3.GetObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
        IfMatch: eTag,
        ...(versionId ? { VersionId: versionId } : {}),
      }),
    )
    .catch((error) => {
      throw new Error(safeTransferErrorMessage(error));
    });
  if (!response.Body)
    throw new Error(`s3://${location.bucket}/${location.key} returned an empty body.`);
  if (!sameETag(response.ETag ?? null, eTag)) {
    throw new Error("The object changed while it was being downloaded (ETag mismatch).");
  }
  try {
    await pipeline(response.Body, createWriteStream(dest, { mode: 0o600 }));
  } catch (error) {
    throw new Error(safeTransferErrorMessage(error));
  }
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command !== "upload" || !file) {
    console.error("usage: node s3.mjs upload <file>");
    process.exitCode = 2;
    return;
  }
  let config;
  try {
    config = backupS3Config();
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await uploadBackup({ file, config });
    // Both the hook and scheduler retry use this CLI: ping only after upload succeeds.
    await sendBackupHeartbeat();
    console.log(`Uploaded backup to s3://${result.bucket}/${result.key}`);
    if (result.eTag) {
      const version = result.versionId ? ` --version-id ${result.versionId}` : "";
      console.log(
        `To restore it: restore s3://${result.bucket}/${result.key} --etag '${result.eTag}'${version} --confirm RESTORE:<database>`,
      );
    }
  } catch (error) {
    console.error(`FATAL: ${safeTransferErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
