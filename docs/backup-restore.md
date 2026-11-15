# Backup and restore

## Scope and custody

Backup artifacts are verified `pg_dump -Fc` database archives, including application data and migration history. They are not full-system backups and are not encrypted bundles. S3 transport and optional server-side encryption do not replace control of backup readers or encryption at rest. Protect local dump volumes and access to off-site objects.

`/data` contains clones/checkouts. Ordinary repositories can be refetched, but a private snapshot made with a one-time SSH key cannot necessarily be recreated. Take a separate consistent volume snapshot of those clones, or retain a safe way to reauthorize them. Stop app writes when taking coordinated database/data snapshots. Saved SSH ciphertext in the DB is useless without the original `COCKPIT_CONTEXT_ENCRYPTION_KEYS` keyring. Keep that keyring and `BETTER_AUTH_SECRET` in separate secure recovery custody; never attach them to an issue or commit them. Retain old key versions during rotation so older ciphertext remains decryptable.

## Configure backups

Backups default off. With no backup settings, there is no scheduled dump or required backup volume/sidecar, migrations proceed without a dump, readiness is unaffected, and every start of the image logs one notice with opt-in instructions: the entrypoint's backups check prints it for the app and for a `migrate` job alike (a source start such as `pnpm dev:server` bypasses the entrypoint and prints none) (a warning instead when a destination is configured but `BACKUP_ENABLED` is not `true`).

To opt in to pre-migration/pre-drop dumps, set `BACKUP_ENABLED=true` and configure a destination. Add `-f compose.backup.yaml` to mount persistent `/backups` on the app, or configure S3 directly. Set `BACKUP_SCHEDULE=daily` and enable Compose profile `backup` for the separate scheduler process using the same application image. This backup process is not an application replica. Defaults: 03:00 UTC (`BACKUP_HOUR_UTC=3`) and 14 daily dump-days (`BACKUP_KEEP=14`). Scheduling defaults off.

For a VPS deployment using the loopback overlay, enable scheduling with:

```sh
docker compose -p cockpit-context -f compose.yaml -f compose.vps.yaml -f compose.backup.yaml --profile backup up -d --build
```

Set the schedule in the private deployment environment first. In Dokploy enable the same profile in its Compose deployment settings.

For off-site copies configure `BACKUP_S3_BUCKET`, writer `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`, and optional region, endpoint, path-style and SSE settings. Keys are `<BACKUP_S3_PREFIX>/<basename>`, default prefix `cockpit-context/prod/database`; no target-hash directory is inserted. Give the writer only the required object permissions and configure bucket lifecycle retention separately. Optional `BACKUP_HEARTBEAT_URL` is contacted after successful upload. Upload failure retries the same completed dump.

`BACKUP_ENABLED=true` enables pre-migration/pre-drop backups and requests off-site freshness monitoring; it is independent of the explicit daily schedule. With it false, empty or unset, migrations skip the hook even if storage is configured, and a configured but unused destination logs one startup warning; other values are refused. Freshness monitoring requires `BACKUP_S3_BUCKET` and separate `BACKUP_MONITOR_S3_*` credentials with ListBucket-only access. Local-only backups with this flag true still work, but log a no-off-site-bucket warning and show a setup-missing admin card because local dump freshness is not monitored. A local-only deployment can leave this flag false and explicitly run manual or daily backups without off-site monitoring (migration hooks then stay off too). Check Admin → backup status and test recovery rather than relying solely on a green upload.

With `BACKUP_ENABLED=true`, every migrating start (the app with `MIGRATE_ON_START=true`, and the image `migrate` command) first runs `pre-migrate.sh --startup-notice`: no usable destination (a writable `/backups` mount, for example `compose.backup.yaml`, and/or valid `BACKUP_S3_*`) stops the start, also when nothing is pending and on a brand-new database. There is no fresh-database exemption. The runner then calls the hook with `--required` before a pending deploy (a failed dump, or a hook missing from the image, refuses the migration) and with `--label pre-drop --keep 5 --required` before due scheduled deletions (a failure skips them; the app still starts and retries at the next start). Manual `backup` uses required mode and refuses no destination. Exit 3 means a verified local dump exists but upload failed.

The dump-writer keys `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` reach only the startup migration runner and the explicit backup/restore commands. The entrypoint runs as PID 1 while it migrates, then unsets them and execs `tini` with the server, so neither `/proc/1/environ` nor the server's environment carries them. The non-secret `BACKUP_S3_*` location settings stay for the freshness monitor, which uses its own `BACKUP_MONITOR_S3_*` key. A server start whose `BACKUP_MONITOR_S3_ACCESS_KEY_ID` equals `BACKUP_S3_ACCESS_KEY_ID` is refused before anything runs: the running server would otherwise keep bucket write access, and with the writer pair gone it could no longer see the reuse. `docker inspect` still shows every configured variable.

## Host commands

Run these on the deployment host from the repository checkout with Docker access. Always specify the actual Compose project, especially on a shared server:

```sh
bash scripts/backup/host.sh backup --project cockpit-context
bash scripts/backup/host.sh list --project cockpit-context
bash scripts/backup/host.sh drill --project cockpit-context
```

The helper verifies exactly one app and Postgres in that project and their shared private network/database alias. It uses the app's `/backups` volume; without `compose.backup.yaml` the app has none, and the helper then uses the backup scheduler's `/backups` volume (at most one `backup` container in the project). It forwards only the database connection and explicit backup writer settings to a one-off container. The drill restores into its own disposable database/network and checks migration/control tables. It does not replace a test of application and snapshot-volume recovery.

Equivalent one-shot image commands are `backup`, `backup-schedule`, `restore-drill <source>`, `restore <source>` and `hold-deletions`. Use the host helper for correct network/credential selection. A backup archive named in a direct container command must be mounted inside that container.

## Offline restore

1. Choose and verify the archive, target project/database, compatible image and separately retained keyring. For S3, pin the exact ETag and optional version ID.
2. Plan downtime. Stop the app and optional backup scheduler; no other writer may remain. The host helper stops both for its guided restore. It asks "Stop the app and continue?" first: only `y`/`yes` proceeds. Any other answer, Enter, EOF, or Ctrl-C (or TERM/HUP) at that prompt exits 3 and stops nothing.
3. Run the guided helper, review its source/target preview and enter the explicit confirmation only after checking it:

   ```sh
   bash scripts/backup/host.sh restore --project cockpit-context
   ```

   The helper is Linux-only (bash, GNU coreutils, docker). `bash scripts/backup/host.sh restore … | tee restore.log` still prompts; read `${PIPESTATUS[0]}` (or use `set -o pipefail`) for the helper's status, and use `tee -i` so a terminal Ctrl-C does not also kill the log.

   An optional source follows `restore`, for example a path under `/backups` or `s3://bucket/key` with `--etag`. With no source the helper selects the latest eligible dump. The underlying image `restore` command without `--confirm RESTORE:<database>` only previews. Nonempty replacement additionally requires `--replace` and a verified pre-restore snapshot. Do not bypass active-connection or snapshot safeguards.
4. Restore holds migration/restore locks, verifies the archive and replaces schema/data in one transaction. A restored database receives a seven-day deletion hold, preserving any longer hold. Archives containing large objects (BLOB entries) are refused, because pg_restore commits those in a transaction of their own. The command counts the restore as committed only when the session confirms COMMIT; read its last message and exit status:

   | Exit | Meaning |
   |---|---|
   | 0 | Restored. Also when a stop signal arrives after COMMIT was confirmed (`Restore completed; then interrupted`); continue with step 5. |
   | 3 | Refused, nothing changed: preview only, usage error, wrong confirmation, a failed check or pre-restore snapshot, a cancelled prompt (`n`, Enter, Ctrl-C or Ctrl-D) or a stop signal before the restore transaction started. |
   | 1 | Failed while changing the target. `COMMIT was never sent … rolled back` means the target is unchanged; `COMMIT not confirmed … uncertain` means it may have committed; `confirmed COMMIT, then failed` means it is restored but the session did not end cleanly. |
   | 130 / 143 / 129 | SIGINT / SIGTERM / SIGHUP while the transaction was open: rolled back if the message says `before COMMIT`, uncertain if it says `after COMMIT was sent`. |

   After an uncertain outcome keep every writer stopped and inspect the database before trusting it; never infer a rollback from the exit status alone. The host helper's exit status is the restore's. It starts the stopped app and scheduler again only after exit 3 (nothing changed). After exit 0 it leaves them stopped and prints the next steps: recover the `/data` snapshot clones, check the keyring, then the `docker start …` command (step 5). After any other status (1, 125–127, 129/130/143, …) it leaves them stopped and prints the `docker start …` command; inspect the database first, and if it is restored (`confirmed COMMIT, then failed`) or may be, do step 5's `/data` and keyring checks before starting it. A signal after the stop prompt but before the restore starts exits 128+n and starts the writers again. A TERM or HUP to the helper while the restore runs makes it exit 128+n and leave the app stopped whatever the restore did; read the restore's output (or check the database) before starting it.
5. Recover any separately protected `/data` snapshot clones and check the app is configured with the original `COCKPIT_CONTEXT_ENCRYPTION_KEYS` keyring before resuming use; the host helper keeps the app and scheduler stopped until then. Start one app (from Dokploy or with the `docker start …` command the helper printed), check `/ready`, sign in, inspect packages and a conversation, and test a public and a private dependency. Restart scheduling when ready.

If a provider restored storage outside this tool, explicitly use `hold-deletions 7` before normal admission. A DB-only restore does not rewind `/data`, restore lost snapshot clones or supply encryption keys. Exercise these procedures on disposable targets before relying on them; a production restore drill has not been established by this documentation.
