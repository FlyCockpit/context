#!/bin/sh
# Docker entrypoint — PID 1 of the single app image (the Dockerfile sets
# ENTRYPOINT to this script, not to tini). It runs before the container CMD.
#
# Backup writer keys stay out of the app: this script holds
# BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY only while the
# migration runner (and its pre-migration / pre-drop backups) runs as its
# child, then unsets them and `exec`s tini with the CMD. tini becomes PID 1
# with that clean environment, so neither /proc/1/environ nor the server's own
# environment carries the writer keys. The non-secret location settings
# (BACKUP_S3_BUCKET, _REGION, _ENDPOINT, _PREFIX, _FORCE_PATH_STYLE) stay: the
# server's backup freshness monitor reads them with its own ListBucket-only
# BACKUP_MONITOR_S3_* key. The one-shot backup commands below (backup,
# backup-schedule, restore, restore-drill) keep the writer keys: writing
# backups is their job.
#
# Image commands:
#   migrate              run the migration runner once and exit with its status
#                        (container platforms: a one-shot job before rollout).
#   restore <args...>    exec scripts/backup/restore.sh (one-shot restore job).
#   backup [--keep <n>]  take a verified pg_dump now (label `manual`).
#   backup-schedule      the optional daily-backup service (scripts/backup/schedule.mjs).
#   restore-drill <src>  restore into a throwaway empty database and verify it.
#   hold-deletions [days|--clear]
#                        pause scheduled deletions for `days` (default 7,
#                        1..90) with the owner hold, or remove it (one-shot;
#                        after a restore the runner cannot detect).
#   anything else        the normal CMD (server), after:
#     1. required env validation;
#     2. the backups startup check (`pre-migrate.sh --startup-notice`) and
#        migrations — MIGRATE_ON_START=true (default for the server command):
#        `node scripts/db/migrate-runtime.mjs apply` (classify the DB, admit or
#        refuse db-ahead, refuse failed / no-history / in-place breaking
#        changes on a served database, the pre-migration backup when
#        BACKUP_ENABLED=true, `prisma migrate deploy`, then the scheduled
#        deletions phase). Concurrent migration commands serialize on the
#        runner's advisory lock; the second normally finds nothing to do.
#        MIGRATE_ON_START=false uses `migrate-runtime.mjs wait`: a read-only
#        wait (fixed 300 s) for the database to be up to date.
#        Both register this process in the instance registry under a fresh
#        COCKPIT_CONTEXT_INSTANCE_ID (exported here, so the CMD's heartbeat,
#        @cockpit-context/db/instance-heartbeat, keeps the same row alive). The
#        one-shot commands (`migrate`, `restore`, `hold-deletions`, `backup*`,
#        `restore-drill`) get no id and register nothing;
#     3. drop the backup writer keys and exec tini with the CMD.
#
# See docs/schema-migrations.md and docs/deploy.md.

# Stop signals: handlers go in before validation or any child (even the
# `node -p` that mints the instance id), so there is no gap between steps where
# a `docker stop` is dropped — a shell running as PID 1 ignores TERM unless it
# traps it — and the runner or the CMD starts anyway. They stay through `exec`
# (exec resets caught signals itself), so there is no untrapped gap between
# steps. (Before the first trap and between `exec` and tini installing its
# own handlers, a TERM to PID 1 is dropped; sh cannot close those windows.)
#
# A supervised child gets TERM for every stop signal: this non-interactive
# shell starts background children with SIGINT ignored, and bash keeps that,
# so a forwarded INT could not stop it. The entrypoint still exits with the
# signal's own status (143 TERM, 130 INT, 129 HUP).
child_pid=""
child_start=""
launching_child=false
stop_signal=""
stopping=false
have_proc=false
if [ -r /proc/self/stat ]; then have_proc=true; fi
# With a supervised child, the handler itself repeats the TERM until the child
# is gone (stop_child): a signal that lands just before supervise's `wait` runs
# the handler and then lets `wait` block, so nothing after it could repeat a
# TERM the child missed. During the launch the child is not identified yet:
# the handler only records the signal, and supervise forwards it. A signal
# that lands while a stop is already under way only records itself: a nested
# handler that drove the child to gone (letting dash reap it and free its PID)
# would make the interrupted check-then-kill outside it signal a stale PID.
# Without /proc nothing repeats the TERM, so there every signal sends one, as
# before.
stop_startup() {
  stop_signal="$1"
  [ "$stopping" = false ] || [ "$have_proc" = false ] || return 0
  if [ -n "$child_pid" ]; then
    stopping=true
    stop_child
  elif [ "$launching_child" = false ]; then
    exit "$2"
  fi
}
trap 'stop_startup TERM 143' TERM
trap 'stop_startup INT 130' INT
trap 'stop_startup HUP 129' HUP
set -e

# The pause between repeated TERMs: 0.2 s where sleep takes fractions, else
# 1 s. Decided once, here: in dash a trap that runs during another trap leaves
# $? at the outer trap's status, so the loop cannot branch on sleep's status.
stop_pause=1
if sleep 0.01 2>/dev/null; then stop_pause=0.2; fi

# proc_start <pid>: sets proc_start_value to the start time of a live (not
# zombie) process, field 22 of /proc/<pid>/stat, or to "" for a process that is
# gone or a zombie. It tells the supervised child apart from a later process
# that reuses its PID once it has been reaped (dash reaps a background child
# while it waits for any foreground command, such as `sleep`). Builtins only,
# no fork: the trap handler runs it, and a container at its pids limit cannot
# fork, so the first TERM always gets out. (stop_child's pause does fork
# `sleep`: at a full pids limit dash exits 2 there, after that TERM, and the
# container's teardown ends the child.) The stop guard keeps two calls from
# interleaving.
proc_start() {
  proc_start_value=""
  stat_line=""
  read -r stat_line 2>/dev/null <"/proc/$1/stat" || [ -n "$stat_line" ] || return 0
  # Field 2 (comm) is in parentheses and may contain spaces: drop through ") ".
  # shellcheck disable=SC2086
  set -- ${stat_line##*) }
  [ $# -ge 20 ] || return 0
  [ "$1" != Z ] || return 0
  shift 19
  proc_start_value=$1
}

# child_alive: the supervised child still runs (same start time as at launch;
# without /proc, `kill -0`).
child_alive() {
  if [ "$have_proc" = true ]; then
    [ -n "$child_start" ] || return 1
    proc_start "$child_pid"
    [ "$proc_start_value" = "$child_start" ]
  else
    kill -0 "$child_pid" 2>/dev/null
  fi
}

# term_child: TERM the supervised child, checked right before the kill, so a
# reaped child's reused PID is not signalled (a gap of microseconds remains
# between the check and the kill builtin; it matters only if the PID space
# wraps around within it).
term_child() {
  [ -n "$child_pid" ] || return 0
  if [ "$have_proc" = false ] || child_alive; then
    kill -TERM "$child_pid" 2>/dev/null || :
  fi
}

# stop_child: TERM the child every 0.2 s until it is gone (where /proc
# identifies it; elsewhere, once). One TERM is not enough: one that lands in
# the instant after the fork, before the forked shell has reset the traps it
# inherited from this one, is swallowed there, and the command would run to
# its end. Both supervised children (the bash startup check and the migration
# runner) have no TERM handler, so repeating it is harmless.
stop_child() {
  term_child
  # Without /proc a reaped child's PID could be reused: one TERM only, which
  # the fork window can swallow. The image always has /proc; only a local run
  # of this script elsewhere (not Linux) takes this path.
  [ "$have_proc" = true ] || return 0
  # (The pause forks `sleep`; the TERM itself never needs a fork.)
  while child_alive; do
    sleep "$stop_pause" 2>/dev/null || :
    term_child
  done
}

# supervise <command...>: run one startup child (the backups startup check, the
# migration runner) in the background so a stop signal reaches it — a trapped
# signal only runs between commands, so a foreground child (a stalled /backups
# mount) would keep it from running — then wait for the child's own exit, so
# PID 1 stays alive while the child drains. Returns the child's status. After a
# stop signal neither a later step nor the CMD ever starts: the child gets TERM
# until it is gone, then the entrypoint exits with the signal's status.
supervise() {
  launching_child=true
  "$@" &
  child_pid=$!
  # Its identity for every later TERM, read with builtins only, so dash cannot
  # reap the child (and free its PID) before the read. A child that already
  # exited reads as gone and is never signalled. Until
  # launching_child is false, a signal is only recorded (term_child skips a
  # child it cannot identify yet) and handled just below.
  if [ "$have_proc" = true ]; then
    proc_start "$child_pid"
    child_start=$proc_start_value
  fi
  launching_child=false
  set +e
  if [ -z "$stop_signal" ]; then
    wait "$child_pid"
    child_status=$?
  fi
  # A stop signal recorded during the launch (the handler has already stopped
  # the child for any later one): TERM the child until it is gone, then
  # collect it.
  if [ -n "$stop_signal" ]; then
    stopping=true
    stop_child
    wait "$child_pid" 2>/dev/null
    # Without /proc: a further signal interrupts that wait; wait again while
    # the child still runs.
    while [ "$have_proc" = false ] && kill -0 "$child_pid" 2>/dev/null; do
      wait "$child_pid" 2>/dev/null
    done
  fi
  set -e
  child_pid=""
  child_start=""
  case "$stop_signal" in
    TERM) exit 143 ;;
    INT) exit 130 ;;
    HUP) exit 129 ;;
  esac
  return "$child_status"
}
run_runner() { supervise node /app/scripts/db/migrate-runtime.mjs "$@"; }
startup_notice() { supervise bash /app/scripts/backup/pre-migrate.sh --startup-notice; }

# --- Strict switches ---
case "${BACKUP_ENABLED:-}" in
  "" | true | false) ;;
  *)
    echo "FATAL: BACKUP_ENABLED must be true or false (got \"$BACKUP_ENABLED\")." >&2
    exit 1
    ;;
esac

# One-shot operations never inherit the identity of a running server.
case "${1:-}" in
  migrate|restore|hold-deletions|backup|backup-schedule|restore-drill)
    unset COCKPIT_CONTEXT_INSTANCE_ID
    ;;
esac

# --- One-shot image commands ---
# Each long-running one runs under tini (signal forwarding, zombie reaping),
# which becomes PID 1 by exec.
case "${1:-}" in
  migrate)
    if [ -z "$DATABASE_URL" ]; then
      echo "FATAL: Missing required environment variable(s): DATABASE_URL" >&2
      exit 1
    fi
    startup_notice
    # The container-platform `migrate` job: the same separation as the server —
    # only the runner (PID 1's child) ever holds the backup keys, and the job
    # exits with its status.
    status=0
    run_runner apply || status=$?
    exit "$status"
    ;;
  restore)
    shift
    exec tini -- bash /app/scripts/backup/restore.sh "$@"
    ;;
  hold-deletions)
    shift
    if [ -z "$DATABASE_URL" ]; then
      echo "FATAL: Missing required environment variable(s): DATABASE_URL" >&2
      exit 1
    fi
    exec tini -- node /app/scripts/db/migrate-runtime.mjs hold "$@"
    ;;
  backup)
    # Back up now: the same pg_dump archive as the pre-migration backup. An
    # explicit manual backup works whatever BACKUP_ENABLED says.
    shift
    exec tini -- bash /app/scripts/backup/pre-migrate.sh --label manual --required "$@"
    ;;
  backup-schedule)
    # The optional daily-backup service (BACKUP_SCHEDULE=daily; idles when off).
    exec tini -- node /app/scripts/backup/schedule.mjs run
    ;;
  restore-drill)
    # Restore into a THROWAWAY empty database and check it (host.sh drill).
    shift
    exec tini -- node /app/scripts/backup/drill.mjs "$@"
    ;;
esac

# --- 1. Required env vars ---
missing=""
required_vars="DATABASE_URL"
is_server=false
case " $* " in
  *" apps/server/dist/index.mjs"*|*" apps/server/"*|*"/apps/server/dist/index.mjs"*)
    required_vars="$required_vars BETTER_AUTH_SECRET"
    is_server=true
    ;;
esac

for var in $required_vars; do
  eval val=\$$var
  if [ -z "$val" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "FATAL: Missing required environment variable(s):$missing" >&2
  echo "       Set them in your orchestrator (e.g. Dokploy)." >&2
  # Deliberate: this check reads the process environment only. The Node bundle
  # CAN read a repo-root .env (see @cockpit-context/env/load-dotenv), so a mounted
  # /app/.env would satisfy the app but not this gate — and that asymmetry is
  # confusing enough to name here. The container contract is injected env: the
  # image ships no .env, and this check plus the migration runner both depend
  # on the values being in the environment.
  echo "       A mounted /app/.env does not satisfy this check — the container" >&2
  echo "       contract is injected environment variables, not an env file." >&2
  exit 1
fi

# The server keeps the ListBucket-only BACKUP_MONITOR_S3_* pair after the
# writer keys are dropped (step 3). A monitor key that IS the dump-writer key
# would hand the running server bucket write access, and once the writer pair
# is gone the server's own comparison (backupMonitorConfigWarnings) can no
# longer see the reuse. So it is checked here, while both are visible, and the
# start is refused before anything runs.
if [ "$is_server" = true ] && [ -n "${BACKUP_MONITOR_S3_ACCESS_KEY_ID:-}" ] &&
  [ "$BACKUP_MONITOR_S3_ACCESS_KEY_ID" = "${BACKUP_S3_ACCESS_KEY_ID:-}" ]; then
  echo "FATAL: BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID. The freshness monitor needs its own ListBucket-only key, never the dump-writer key (docs/backup-restore.md)." >&2
  exit 1
fi

# Server boot validates the admin bootstrap configuration.
if [ "$is_server" = true ] && [ "$NODE_ENV" = "production" ] && [ -z "$ADMIN_EMAILS" ]; then
  if [ "$SIGNUP_ENABLED" = "true" ]; then
    echo "WARNING: ADMIN_EMAILS is empty. No users will be granted admin privileges." >&2
    echo "         Set ADMIN_EMAILS to a comma-separated list of email addresses." >&2
  else
    # Matches the Node env-layer boot guard in packages/env/src/server.ts:
    # signup disabled + empty allowlist means no NEW admin can be bootstrapped.
    # The server keeps booting (provisioned installs hold their admins in the
    # database) — this is the best-effort early signal for the fresh-install
    # case. If no admin exists yet, set ADMIN_EMAILS before the first signup.
    echo "WARNING: ADMIN_EMAILS is empty and SIGNUP_ENABLED is not \"true\" —" >&2
    echo "         no new admin can be bootstrapped. If no admin exists yet," >&2
    echo "         set ADMIN_EMAILS to a comma-separated list of operator emails." >&2
  fi
fi

# --- 2. Migrations ---
if [ "$is_server" = true ]; then
  MIGRATE_ON_START="${MIGRATE_ON_START:-true}"
else
  MIGRATE_ON_START="${MIGRATE_ON_START:-false}"
fi
# One id per container start, never reused: scheduled deletions wait for every
# registered instance of an older release (scripts/db/lib/contracts.mjs).
COCKPIT_CONTEXT_INSTANCE_ID="$(node -p 'require("node:crypto").randomUUID()')"
export COCKPIT_CONTEXT_INSTANCE_ID
case "$MIGRATE_ON_START" in
  true) mode=apply ;;
  false) mode=wait ;;
  *)
    echo "FATAL: MIGRATE_ON_START must be true or false (got \"$MIGRATE_ON_START\")." >&2
    exit 1
    ;;
esac
# Backups startup check, once per start, even with no pending SQL. A container
# that migrates (apply) refuses to start when BACKUP_ENABLED=true has no usable
# destination. One that only waits (MIGRATE_ON_START=false, while a `migrate`
# job takes the backup) needs no destination: a waiting server runs the check
# only when backups are off, to print the backups-off notice (a warning when a
# destination is configured but unused). The `migrate` job runs it too, so it
# prints the same notice.
if [ "$mode" = apply ]; then
  startup_notice
elif [ "$is_server" = true ] && [ "${BACKUP_ENABLED:-false}" != true ]; then
  startup_notice
fi
run_runner "$mode" --role server

# Writer credentials are startup-only. The running server uses the separate
# ListBucket-only monitor credentials; explicit backup/restore commands keep
# theirs.
unset BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

# --- 3. Hand off to the container CMD ---
# tini replaces this shell as PID 1 with the cleaned environment.
exec tini -- "$@"
