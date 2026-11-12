# Backup and restore

## Scope and custody

Backup artifacts are verified `pg_dump -Fc` database archives, including application data and migration history. They are not full-system backups and are not encrypted bundles. S3 transport and optional server-side encryption do not replace control of backup readers or encryption at rest. Protect local dump volumes and access to off-site objects.

`/data` contains clones/checkouts. Ordinary repositories can be refetched, but a private snapshot made with a one-time SSH key cannot necessarily be recreated. Take a separate consistent volume snapshot of those clones, or retain a safe way to reauthorize them. Stop app writes when taking coordinated database/data snapshots. Saved SSH ciphertext in the DB is useless without the original `COCKPIT_CONTEXT_ENCRYPTION_KEYS` keyring. Keep that keyring and `BETTER_AUTH_SECRET` in separate secure recovery custody; never attach them to an issue or commit them. Retain old key versions during rotation so older ciphertext remains decryptable.

## Configure backups

The app mounts persistent `/backups`. Set `BACKUP_SCHEDULE=daily` and enable Compose profile `backup` for the separate scheduler process using the same application image. This backup process is not an application replica. Defaults: 03:00 UTC (`BACKUP_HOUR_UTC=3`) and 14 daily dump-days (`BACKUP_KEEP=14`). Scheduling defaults off.

For a VPS deployment using the loopback overlay, enable scheduling with:

```sh
docker compose -p cockpit-context -f compose.yaml -f compose.vps.yaml --profile backup up -d --build
```

Set the schedule in the private deployment environment first. In Dokploy enable the same profile in its Compose deployment settings.

For off-site copies configure `BACKUP_S3_BUCKET`, writer `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`, and optional region, endpoint, path-style and SSE settings. Keys are `<BACKUP_S3_PREFIX>/<basename>`, default prefix `cockpit-context/prod/database`; no target-hash directory is inserted. Give the writer only the required object permissions and configure bucket lifecycle retention separately. Optional `BACKUP_HEARTBEAT_URL` is contacted after successful upload. Upload failure retries the same completed dump.

`BACKUP_ENABLED` requests off-site freshness monitoring; it is independent of scheduling and does not create dumps. Use separate `BACKUP_MONITOR_S3_*` credentials with ListBucket-only access. A local-only deployment can turn that off-site monitor off while retaining local backups. Check Admin → backup status and test recovery rather than relying solely on a green upload.

The migration runner calls the pre-migration/pre-drop hook. An unconfigured destination produces a warning and skips backup; a configured failure blocks mutation. Manual `backup` uses required mode and refuses no destination. Exit 3 means a verified local dump exists but upload failed.

## Host commands

Run these on the deployment host from the repository checkout with Docker access. Always specify the actual Compose project, especially on a shared server:

```sh
bash scripts/backup/host.sh backup --project cockpit-context
bash scripts/backup/host.sh list --project cockpit-context
bash scripts/backup/host.sh drill --project cockpit-context
```

The helper verifies exactly one app and Postgres in that project and their shared private network/database alias. It forwards only the database connection and explicit backup writer settings to a one-off container. The drill restores into its own disposable database/network and checks migration/control tables. It does not replace a test of application and snapshot-volume recovery.

Equivalent one-shot image commands are `backup`, `backup-schedule`, `restore-drill <source>`, `restore <source>` and `hold-deletions`. Use the host helper for correct network/credential selection. A backup archive named in a direct container command must be mounted inside that container.

## Offline restore

1. Choose and verify the archive, target project/database, compatible image and separately retained keyring. For S3, pin the exact ETag and optional version ID.
2. Plan downtime. Stop the app and optional backup scheduler; no other writer may remain. The host helper stops both for its guided restore.
3. Run the guided helper, review its source/target preview and enter the explicit confirmation only after checking it:

   ```sh
   bash scripts/backup/host.sh restore --project cockpit-context
   ```

   An optional source follows `restore`, for example a path under `/backups` or `s3://bucket/key` with `--etag`. With no source the helper selects the latest eligible dump. The underlying image `restore` command without `--confirm RESTORE:<database>` only previews. Nonempty replacement additionally requires `--replace` and a verified pre-restore snapshot. Do not bypass active-connection or snapshot safeguards.
4. Restore holds migration/restore locks, verifies the archive and replaces schema/data transactionally. An error rolls back replacement. A restored database receives a seven-day deletion hold, preserving any longer hold.
5. Recover any separately protected snapshot clones and original keyring before resuming use. Start one app, check `/ready`, sign in, inspect packages and a conversation, and test a public and a private dependency. Restart scheduling when ready.

If a provider restored storage outside this tool, explicitly use `hold-deletions 7` before normal admission. A DB-only restore does not rewind `/data`, restore lost snapshot clones or supply encryption keys. Exercise these procedures on disposable targets before relying on them; a production restore drill has not been established by this documentation.
