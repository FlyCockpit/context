import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";

import {
  backupS3Config,
  describeObject,
  downloadObject,
  safeTransferErrorMessage,
  sameETag,
  uploadBackup,
} from "./s3.mjs";

const baseEnv = {
  BACKUP_S3_BUCKET: "backups",
  BACKUP_S3_ACCESS_KEY_ID: "backup-key",
  BACKUP_S3_SECRET_ACCESS_KEY: "backup-secret",
  BACKUP_S3_REGION: "us-east-1",
};

/** Inert SDK stand-in: each command records its input; no network. */
const sdk = Object.fromEntries(
  [
    "PutObjectCommand",
    "CreateMultipartUploadCommand",
    "UploadPartCommand",
    "CompleteMultipartUploadCommand",
    "AbortMultipartUploadCommand",
    "HeadObjectCommand",
    "GetObjectCommand",
  ].map((name) => [
    name,
    class {
      /** @param {Record<string, unknown>} input */
      constructor(input) {
        this.name = name;
        this.input = input;
      }
    },
  ]),
);

/** @param {(command: { name: string, input: Record<string, unknown> }) => unknown} respond */
function fakeClient(respond) {
  /** @type {Array<{ name: string, input: Record<string, unknown> }>} */
  const sent = [];
  return {
    sent,
    /** @param {any} command */
    async send(command) {
      sent.push(command);
      return respond(command);
    },
  };
}

describe("backupS3Config", () => {
  it("returns a normalized config", () => {
    const config = backupS3Config({ ...baseEnv, BACKUP_S3_PREFIX: "/db/" });
    assert.equal(config.prefix, "db");
    assert.equal(config.sse, false);
  });
  it("refuses unsafe or unusable settings", () => {
    assert.throws(() => backupS3Config({}), /BACKUP_S3_BUCKET/);
    assert.throws(() => backupS3Config({ BACKUP_S3_BUCKET: "b" }), /ACCESS_KEY/);
    assert.throws(
      () => backupS3Config({ ...baseEnv, S3_ACCESS_KEY_ID: "backup-key" }),
      /distinct key/,
    );
    assert.throws(() => backupS3Config({ ...baseEnv, BACKUP_S3_REGION: "" }), /real AWS region/);
    assert.throws(() => backupS3Config({ ...baseEnv, BACKUP_S3_PREFIX: "/" }), /must not be empty/);
  });
});

describe("S3 transfer", () => {
  /** @type {string} */
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "backup-s3-test-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads with a no-overwrite condition under the prefix", async () => {
    const file = join(dir, "pre-migrate-20261103T000000Z.dump");
    await writeFile(file, "PGDMP-data");
    const client = fakeClient(() => ({ ETag: '"e1"', VersionId: "v1" }));
    const result = await uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk });
    assert.deepEqual(result, {
      bucket: "backups",
      key: "cockpit-context/prod/database/pre-migrate-20261103T000000Z.dump",
      eTag: '"e1"',
      versionId: "v1",
    });
    assert.equal(client.sent[0]?.name, "PutObjectCommand");
    assert.equal(client.sent[0]?.input.IfNoneMatch, "*");
  });

  it("uses conditional multipart completion above the threshold and aborts on failure", async () => {
    const file = join(dir, "big.dump");
    await writeFile(file, "0123456789");
    const ok = fakeClient((command) =>
      command.name === "CreateMultipartUploadCommand" ? { UploadId: "u1" } : { ETag: '"p"' },
    );
    await uploadBackup({
      file,
      config: backupS3Config(baseEnv),
      client: ok,
      sdk,
      multipartThresholdBytes: 4,
      partSizeBytes: 4,
    });
    assert.deepEqual(
      ok.sent.map((command) => command.name),
      [
        "CreateMultipartUploadCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "CompleteMultipartUploadCommand",
      ],
    );
    assert.equal(ok.sent.at(-1)?.input.IfNoneMatch, "*");

    const failing = fakeClient((command) => {
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u2" };
      if (command.name === "CompleteMultipartUploadCommand")
        throw Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 501 } });
      return { ETag: '"p"' };
    });
    await assert.rejects(
      uploadBackup({
        file,
        config: backupS3Config(baseEnv),
        client: failing,
        sdk,
        multipartThresholdBytes: 4,
        partSizeBytes: 4,
      }),
      /refuse to risk overwriting/,
    );
    assert.equal(failing.sent.at(-1)?.name, "AbortMultipartUploadCommand");
  });

  const statusError = (status) =>
    Object.assign(new Error(`http ${status}`), { $metadata: { httpStatusCode: status } });
  const networkError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

  it("retries transient failures but not a client error", async () => {
    const file = join(dir, "retry.dump");
    await writeFile(file, "PGDMP-data");
    for (const transient of [503, 429, 408]) {
      let calls = 0;
      const client = fakeClient(() => {
        calls += 1;
        if (calls === 1) throw statusError(transient);
        return { ETag: '"ok"' };
      });
      const result = await uploadBackup({ file, config: backupS3Config(baseEnv), client, sdk });
      assert.equal(result.eTag, '"ok"');
      assert.equal(calls, 2, `retried after ${transient}`);
    }
    const forbidden = fakeClient(() => {
      throw statusError(403);
    });
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client: forbidden, sdk }),
      /http 403/,
    );
    assert.equal(forbidden.sent.length, 1, "a 403 is not retried");
    // A plain 412 (the key already exists, no lost response) fails at once.
    const exists = fakeClient(() => {
      throw statusError(412);
    });
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client: exists, sdk }),
      /http 412/,
    );
    assert.deepEqual(
      exists.sent.map((c) => c.name),
      ["PutObjectCommand"],
    );
  });

  it("a 412 after a lost response is success when the stored object is ours", async () => {
    const file = join(dir, "lost.dump");
    await writeFile(file, "PGDMP-data"); // 10 bytes
    const respond = (length) => {
      let puts = 0;
      return fakeClient((command) => {
        if (command.name === "HeadObjectCommand")
          return { ContentLength: length, ETag: '"landed"', VersionId: "v9" };
        puts += 1;
        if (puts === 1) throw networkError();
        throw statusError(412);
      });
    };
    const ours = respond(10);
    const result = await uploadBackup({ file, config: backupS3Config(baseEnv), client: ours, sdk });
    assert.deepEqual([result.eTag, result.versionId], ['"landed"', "v9"]);
    assert.deepEqual(
      ours.sent.map((c) => c.name),
      ["PutObjectCommand", "PutObjectCommand", "HeadObjectCommand"],
    );
    assert.equal(ours.sent[2]?.input.Key, "cockpit-context/prod/database/lost.dump");
    const stranger = respond(99);
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client: stranger, sdk }),
      /http 412/,
    );
  });

  it("relabels 400/405/501 only for the conditional write itself", async () => {
    const file = join(dir, "label.dump");
    await writeFile(file, "0123456789");
    const put = fakeClient(() => {
      throw statusError(400);
    });
    await assert.rejects(
      uploadBackup({ file, config: backupS3Config(baseEnv), client: put, sdk }),
      /rejected PutObject with If-None-Match/,
    );
    // A part upload failing with 400 is not an If-None-Match problem.
    const part = fakeClient((command) => {
      if (command.name === "CreateMultipartUploadCommand") return { UploadId: "u3" };
      if (command.name === "UploadPartCommand") throw statusError(400);
      return {};
    });
    await assert.rejects(
      uploadBackup({
        file,
        config: backupS3Config(baseEnv),
        client: part,
        sdk,
        multipartThresholdBytes: 4,
        partSizeBytes: 4,
      }),
      (error) => error instanceof Error && error.message === "http 400",
    );
    assert.equal(part.sent.at(-1)?.name, "AbortMultipartUploadCommand");
  });

  it("refuses a source outside the configured bucket", async () => {
    await assert.rejects(
      describeObject({
        location: { bucket: "other", key: "k" },
        config: backupS3Config(baseEnv),
        client: fakeClient(() => ({})),
        sdk,
      }),
      /not BACKUP_S3_BUCKET/,
    );
  });

  it("downloads with If-Match and rejects a changed object", async () => {
    const dest = join(dir, "download.dump");
    const client = fakeClient(() => ({ ETag: '"e1"', Body: Readable.from(["PGDMP"]) }));
    await downloadObject({
      location: { bucket: "backups", key: "k" },
      eTag: '"e1"',
      dest,
      config: backupS3Config(baseEnv),
      client,
      sdk,
    });
    assert.equal(await readFile(dest, "utf8"), "PGDMP");
    assert.equal(client.sent[0]?.input.IfMatch, '"e1"');

    const changed = fakeClient(() => ({ ETag: '"e2"', Body: Readable.from(["x"]) }));
    await assert.rejects(
      downloadObject({
        location: { bucket: "backups", key: "k" },
        eTag: '"e1"',
        dest,
        config: backupS3Config(baseEnv),
        client: changed,
        sdk,
      }),
      /changed/,
    );
  });

  it("compares ETags with or without quotes", () => {
    assert.equal(sameETag('"abc"', "abc"), true);
    assert.equal(sameETag('"abc"', '"abd"'), false);
    assert.equal(sameETag(null, "abc"), false);
  });
});

describe("transfer error output", () => {
  it("never includes a token-bearing network error message", () => {
    const message = safeTransferErrorMessage(
      new Error("https://fixture:private-token@example.test/path"),
    );
    assert.doesNotMatch(message, /private-token|example\.test/);
    assert.match(safeTransferErrorMessage({ name: "AccessDenied" }), /AccessDenied/);
  });
});
