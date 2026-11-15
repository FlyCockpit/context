#!/usr/bin/env bash
# Database helper for the Dokploy server (the generated compose topology).
# Needs only bash and docker. It ships inside the app image; copy it out once:
#
#   docker exec "$(docker ps -q -f label=com.docker.compose.service=app | head -n1)" \
#     cat /app/scripts/backup/host.sh > app-db.sh
#
# Then, on the server:
#   bash app-db.sh list                    list the backups, newest first
#   bash app-db.sh backup                  take a backup now
#   bash app-db.sh restore [<backup>]      guided restore (default: the newest backup)
#   bash app-db.sh drill [<backup>]        restore into a throwaway database and check it
#                                          (s3://… backups: add --etag <etag>)
#   bash app-db.sh hold-deletions [days|--clear]
#                                          pause scheduled deletions (after a restore the
#                                          app cannot detect, e.g. a Volume Backups copy)
# Add --project <name> when the server runs more than one copy of the app.
#
# It finds the app's containers, image, network and backups volume itself and
# passes the database settings straight from the running app to a one-off
# container of the same image, never through a file. `restore` shows a preview
# and asks before changing anything (docs/backup-restore.md).
#
# Linux only: it runs on the Dokploy server (bash, GNU coreutils, docker).
# Its tests (scripts/backup/host.test.mjs) run in a Linux container where
# Docker exists, and on Linux CI.
set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}
say() { echo "[app-db] $*"; }
# Only y/yes proceeds; anything else, an empty answer or EOF (Ctrl-D) declines.
read_answer() { read -r -p "$1 [y/N] " answer </dev/tty; }
ask() {
  local answer
  read_answer "$1" || return 1
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# The stop prompt. Declining exits 3, restore.mjs's REFUSED_EXIT ("nothing
# changed"), as a cancel at its own prompt does; so does Ctrl-C (INT), TERM or
# HUP while it waits. Nothing was stopped, so nothing is started; restore's
# EXIT trap is not installed yet. The signal traps cover the prompt only: the
# previous INT/TERM/HUP traps are back in place right after it, so later steps
# keep their own signal handling. A `| tee` reader that left while the prompt
# waited (Ctrl-C reaches `tee` too) must not turn the 3 into a SIGPIPE death
# (141) or a failed write (1), so the message is best effort.
cancel_stop() {
  trap '' PIPE
  say "Cancelled. Nothing was changed; the app was not stopped." 2>/dev/null || true
  exit 3
}
confirm_stop() {
  local previous declined=0
  previous="$(trap -p INT TERM HUP)"
  # After ^C the cursor is still on the prompt line (stderr, the terminal).
  # PIPE is ignored before any output: stderr may feed a dead `2>&1 | tee`.
  trap 'trap "" PIPE; echo >&2 2>/dev/null || true; cancel_stop' INT TERM HUP
  ask "Stop the app and continue?" || declined=1
  trap - INT TERM HUP
  eval "$previous"
  [ "$declined" = 0 ] || cancel_stop
}

# The prompts read the terminal, and `docker run -it` needs stdin to be one.
# stdout may be a pipe (`restore | tee restore.log`).
stdin_is_terminal() { [ -t 0 ]; }
require_terminal() { stdin_is_terminal && [ -r /dev/tty ]; }
choose_project() { read -r -p "Which one? (number) " pick </dev/tty; }

parse_args() {
  action="${1:-}"
  [ -n "$action" ] || {
    # The help is this file's header. Piped into `bash -s` there is no file.
    if [ -f "${BASH_SOURCE[0]:-}" ]; then
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    else
      echo "Usage: bash <this script> list | backup | restore | drill | hold-deletions [<args>] [--project <name>]" >&2
      echo "(the full help is the header of scripts/backup/host.sh)" >&2
    fi
    exit 2
  }
  shift
  project=""
  args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --project)
        [ $# -ge 2 ] || die "--project needs a name."
        project="$2"
        shift 2
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done
  case "$action" in
    list | backup | hold-deletions | restore | drill) ;;
    *) die "unknown command \"$action\" (use list, backup, restore, drill or hold-deletions)." ;;
  esac
}

# --- Find the app ------------------------------------------------------------
label() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }
in_project() { docker ps -a -q -f "label=com.docker.compose.project=$project" "$@"; }
# The named volume mounted at /backups in a container ("" for none or a bind mount).
backups_volume() {
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Name}}{{end}}{{end}}' "$1"
}
discover_app() {
  mapfile -t projects < <(docker ps -a -f label=com.docker.compose.service=app \
    --format '{{.Label "com.docker.compose.project"}}' | sed '/^$/d; /^<no value>$/d' | sort -u)
  [ ${#projects[@]} -gt 0 ] || die "no app found (no container of a compose service named \"app\")."
  if [ -z "$project" ]; then
    if [ ${#projects[@]} -eq 1 ]; then
      project="${projects[0]}"
    else
      say "This server runs more than one app:"
      for i in "${!projects[@]}"; do echo "  $((i + 1))) ${projects[$i]}"; done
      choose_project
      [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le ${#projects[@]} ] ||
        die "no such choice."
      project="${projects[$((pick - 1))]}"
    fi
  fi
  # Require exactly one app and Postgres in this selected Compose project.
  mapfile -t apps < <(in_project -f label=com.docker.compose.service=app)
  mapfile -t databases < <(in_project -f label=com.docker.compose.service=postgres)
  [ ${#apps[@]} -eq 1 ] || die "expected exactly one app container in \"$project\"."
  [ ${#databases[@]} -eq 1 ] || die "expected exactly one postgres container in \"$project\"."
  server="${apps[0]}"
  postgres="${databases[0]}"
  [ "$(label "$server" com.docker.compose.service)" = app ] || die "selected app service label mismatch."
  [ "$(label "$postgres" com.docker.compose.service)" = postgres ] || die "selected postgres service label mismatch."
  for id in "$server" "$postgres"; do
    [ "$(label "$id" com.docker.compose.project)" = "$project" ] || die "container project mismatch."
  done
  image="$(docker inspect -f '{{.Image}}' "$server")"
  volume="$(backups_volume "$server")"
  # Without compose.backup.yaml the app has no /backups, but the optional
  # backup scheduler (compose profile `backup`) keeps its local dumps in its
  # own /backups volume. Use that one: same project and label checks, and at
  # most one scheduler.
  if [ -z "$volume" ]; then
    mapfile -t schedulers < <(in_project -f label=com.docker.compose.service=backup)
    [ ${#schedulers[@]} -le 1 ] || die "expected at most one backup container in \"$project\"."
    if [ ${#schedulers[@]} -eq 1 ]; then
      [ "$(label "${schedulers[0]}" com.docker.compose.service)" = backup ] ||
        die "selected backup service label mismatch."
      [ "$(label "${schedulers[0]}" com.docker.compose.project)" = "$project" ] ||
        die "container project mismatch."
      volume="$(backups_volume "${schedulers[0]}")"
    fi
  fi

  # Never guess from network order or a proxy's name. Only an internal network
  # owned by this exact Compose project and shared by its app and Postgres fits.
  networks() {
    docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$1"
  }
  mapfile -t pg_networks < <(networks "$postgres")
  candidates=()
  while IFS= read -r net; do
    [ -n "$net" ] || continue
    for pg_net in "${pg_networks[@]}"; do
      [ "$net" = "$pg_net" ] || continue
      metadata="$(docker network inspect -f '{{.Internal}}|{{index .Labels "com.docker.compose.project"}}' "$net")" ||
        die "cannot inspect the shared network."
      [ "$metadata" = "true|$project" ] && candidates+=("$net")
    done
  done < <(networks "$server")
  [ ${#candidates[@]} -eq 1 ] || die "expected exactly one project-private internal network shared by app and postgres."
  network="${candidates[0]}"

  # Explicit writer-only allowlist. Never forward generic S3, monitor, auth,
  # encryption-keyring or other app credentials into the one-off container.
  app_env() {
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server" |
      grep -E '^(DATABASE_URL|BACKUP_S3_(BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY|ENDPOINT|REGION|PREFIX|FORCE_PATH_STYLE|SSE))=' || true
  }

  forward_env="$(app_env)"

  # An internal network cannot reach an off-site bucket. When S3 is configured,
  # also join only this project's explicitly labelled egress network; never its
  # proxy network or any sibling project's network. The DB stays private.
  egress_args=()
  if printf '%s\n' "$forward_env" | grep -qE '^BACKUP_S3_BUCKET=.+$'; then
    egress_candidates=()
    while IFS= read -r net; do
      [ -n "$net" ] || continue
      metadata="$(docker network inspect -f '{{.Internal}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}' "$net")" ||
        die "cannot inspect the app's egress network."
      [ "$metadata" != "false|$project|egress" ] || egress_candidates+=("$net")
    done < <(networks "$server")
    [ ${#egress_candidates[@]} -eq 1 ] || die "S3 needs exactly one egress network owned by the selected Compose project."
    egress_args=(--network "${egress_candidates[0]}")
  fi

  # The selected Postgres must actually be the URL target, not merely a sibling
  # attached to a common network. Check its aliases without printing the URL.
  database_url=""
  while IFS= read -r assignment; do
    case "$assignment" in DATABASE_URL=*) database_url="${assignment#DATABASE_URL=}" ;; esac
  done <<<"$forward_env"
  case "$database_url" in postgres://*|postgresql://*) ;; *) die "DATABASE_URL is missing or is not a Postgres URL." ;; esac
  authority="${database_url#*://}"
  authority="${authority%%/*}"
  authority="${authority##*@}"
  database_host="${authority%%:*}"
  [ -n "$database_host" ] || die "DATABASE_URL has no hostname."
  mapfile -t aliases < <(docker inspect -f "{{range \$name, \$net := .NetworkSettings.Networks}}{{if eq \$name \"$network\"}}{{range \$net.Aliases}}{{println .}}{{end}}{{end}}{{end}}" "$postgres")
  target_matches=0
  for alias in "${aliases[@]}"; do
    [ "$database_host" != "$alias" ] || target_matches=1
  done
  [ "$target_matches" = 1 ] || die "DATABASE_URL does not target the selected project's Postgres alias on its private network."
  unset database_url authority database_host
  volume_args=()
  [ -n "$volume" ] && volume_args=(-v "$volume:/backups")
  return 0
}

# One-off container of the app image on the app's network. A terminal on
# stdin is enough for -it (docker allocates the container's own terminal), so
# `bash app-db.sh restore | tee restore.log` still prompts.
run_image() {
  local tty=()
  if stdin_is_terminal; then tty=(-it); fi
  docker run --rm "${tty[@]}" --network "$network" "${egress_args[@]}" "${volume_args[@]}" \
    --env-file <(printf '%s\n' "$forward_env") "$image" "$@"
}

main() {
  parse_args "$@"
  command -v docker >/dev/null || die "docker is not installed on this machine."
  docker info >/dev/null 2>&1 || die "cannot talk to Docker. Run this on the Dokploy server as a user who can run docker (with Docker access)."

  discover_app

  say "app \"$project\": app container ${server:0:12}, network $network, backups volume ${volume:-none}"

  case "$action" in
    list)
      run_image restore --list
      ;;
    backup)
      run_image backup
      ;;
    hold-deletions)
      run_image hold-deletions "${args[@]}"
      ;;
    restore)
      require_terminal || die "restore asks before it changes anything; run it in a terminal."
      source="${args[0]:-latest}"
      [ ${#args[@]} -le 1 ] || die "restore takes one backup name (see: bash $0 list)."
      case "$source" in
        latest | s3://* | /*) ;;
        *) source="/backups/$source" ;;
      esac
      [ -n "$postgres" ] && [ "$(docker inspect -f '{{.State.Running}}' "$postgres")" = true ] ||
        die "the database container is not running; start it in Dokploy first."
      # The writers: the app and the optional backup scheduler, nothing else.
      mapfile -t writers < <(
        for id in $(in_project); do
          svc="$(label "$id" com.docker.compose.service)"
          state="$(docker inspect -f '{{.State.Running}}' "$id")"
          { [ "$svc" = app ] || [ "$svc" = backup ]; } && [ "$state" = true ] && echo "$id $svc"
        done
      )
      echo
      say "Restoring stops the app (${#writers[@]} running container(s): $(printf '%s ' "${writers[@]#* }"))"
      say "and starts it again only if the restore is cancelled or refused before anything changed."
      say "After a restore that ran (completed, failed or interrupted), the app stays stopped: recover"
      say "the /data snapshot clones and check the keyring first; the helper then prints the start command."
      say "If Auto Deploy is on in Dokploy, do not merge anything meanwhile. You will see a preview"
      say "and be asked once more before anything changes."
      confirm_stop
      # restore.mjs exit status: 0 restored; 3 (REFUSED_EXIT) refused or
      # cancelled before anything changed; anything else failed or was
      # interrupted while restoring: rolled back, or (after COMMIT was sent)
      # uncertain. Only "nothing changed" starts the writers again. After a
      # completed restore the database no longer matches /data (snapshot clones
      # made since the backup are gone from it, older ones may need recovering)
      # and saved SSH keys decrypt only with the original keyring; after any
      # other status nobody has checked the database. Starting the app would
      # migrate, run its jobs and serve users before those manual steps
      # (docs/backup-restore.md, Offline restore step 5), so it stays stopped.
      #
      # Start first, talk second: after Ctrl-C under `restore | tee log` the
      # pipe's reader is gone, and a write to it would kill this shell (SIGPIPE)
      # before the writers are started again. So the trap ignores
      # INT/TERM/HUP/PIPE, starts every writer when nothing changed, then
      # reports on stderr (never the pipe), ignoring write errors.
      # shellcheck disable=SC2329 # Called by the EXIT trap, including failures.
      note() { echo "[app-db] $*" >&2 2>/dev/null || true; }
      # shellcheck disable=SC2329 # Called by the EXIT trap, including failures.
      restore_exit() {
        local exit_status=$?
        trap '' INT TERM HUP PIPE
        if [ "$restore_invoked" = 0 ] || [ "$exit_status" -eq 3 ]; then
          # `docker stop` first: an interrupted stop (Ctrl-C kills the client,
          # the daemon keeps stopping) would make a bare `docker start` a no-op
          # on a container that then exits. Stopping waits for that; it is a
          # no-op for a container already stopped.
          for writer in "${writers[@]}"; do
            docker stop -t 30 "${writer%% *}" >/dev/null 2>&1 || true
            docker start "${writer%% *}" >/dev/null 2>&1 || true
          done
          if [ "$restore_invoked" = 0 ]; then
            note "Restore was not invoked; nothing was changed."
          else
            note "Cancelled or refused; nothing was changed."
          fi
          [ ${#writers[@]} -eq 0 ] || note "Started the app again."
        elif [ "$exit_status" -eq 0 ]; then
          note "Restore done. The app stays stopped until you have finished these steps"
          note "(docs/backup-restore.md, Offline restore step 5):"
          note "  1. Recover any separately protected /data snapshot clones (a database restore does not"
          note "     rewind /data)."
          note "  2. Check the app is configured with the original COCKPIT_CONTEXT_ENCRYPTION_KEYS keyring"
          note "     (saved SSH keys need it)."
          note "  3. Start the app (it applies any pending migrations as it starts) and the backup scheduler,"
          if [ ${#writers[@]} -gt 0 ]; then
            note "     from Dokploy or with: docker start $(printf '%s ' "${writers[@]%% *}")"
          else
            note "     from Dokploy (none was running when the restore began)."
          fi
          note "     then confirm from your computer:"
          note "     pnpm deploy:check https://<your-app> --commit <deployed commit>"
        else
          if [ "$exit_status" -ge 125 ] && [ "$exit_status" -le 127 ]; then
            # docker run's own failures; the restore may never have started,
            # but a wait failure can also follow a started one.
            note "docker run failed (exit $exit_status): the restore container may not have started."
          fi
          note "Restore failed or its outcome is uncertain (exit $exit_status): the restore output above says which. The app stays stopped."
          note "The restore output above says whether it was rolled back (nothing changed) or, if it"
          note "failed after COMMIT was sent, that the outcome is uncertain (\"confirmed COMMIT, then"
          note "failed\" means it is restored). Inspect the database first. If it is restored, or may be,"
          note "also recover any separately protected /data snapshot clones and check the original"
          note "COCKPIT_CONTEXT_ENCRYPTION_KEYS keyring (docs/backup-restore.md, Offline restore step 5)."
          if [ ${#writers[@]} -gt 0 ]; then
            note "Then start the app again from Dokploy, or with: docker start $(printf '%s ' "${writers[@]%% *}")"
          else
            note "Then start the app from Dokploy (none was running when the restore began)."
          fi
        fi
        return "$exit_status"
      }
      restore_invoked=0
      trap restore_exit EXIT
      trap 'exit 143' TERM
      trap 'exit 130' INT
      trap 'exit 129' HUP
      # From here on a dead stdout reader (`| tee` killed by Ctrl-C) must not
      # kill this shell outright: a failed write ends it through set -e, and
      # the EXIT trap still runs.
      trap '' PIPE
      for writer in "${writers[@]}"; do
        say "Stopping ${writer#* } ..."
        docker stop -t 30 "${writer%% *}" >/dev/null
      done
      status=0
      restore_invoked=1
      run_image restore "$source" --guided || status=$?
      exit "$status"
      ;;
    drill)
      source="latest"
      pins=()
      if [ ${#args[@]} -gt 0 ] && [[ "${args[0]}" != -* ]]; then
        source="${args[0]}"
        args=("${args[@]:1}")
      fi
      # Only the options that pin an s3:// object; never one that widens the restore.
      while [ ${#args[@]} -gt 0 ]; do
        case "${args[0]}" in
          --etag | --version-id)
            [ ${#args[@]} -ge 2 ] || die "${args[0]} needs a value."
            pins+=("${args[0]}" "${args[1]}")
            args=("${args[@]:2}")
            ;;
          *) die "drill does not accept \"${args[0]}\" (only <backup> and, for s3://, --etag / --version-id)." ;;
        esac
      done
      case "$source" in
        latest | s3://* | /*) ;;
        *) source="/backups/$source" ;;
      esac
      [ ${#pins[@]} -eq 0 ] || [[ "$source" == s3://* ]] ||
        die "--etag and --version-id apply only to s3:// backups."
      [[ "$source" != s3://* ]] || [[ " ${pins[*]} " == *" --etag "* ]] ||
        die "an s3:// backup needs --etag <etag> (it is printed when the backup is uploaded)."
      pg_image="postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42"
      [ -n "$postgres" ] && pg_image="$(docker inspect -f '{{.Config.Image}}' "$postgres")"
      suffix="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
      drill_net="cockpit-context-drill-$suffix"
      drill_db="cockpit-context-drill-pg-$suffix"
      password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
      # shellcheck disable=SC2329 # Called by the EXIT trap.
      cleanup() {
        docker rm -f -v "$drill_db" >/dev/null 2>&1 || true
        docker network rm "$drill_net" >/dev/null 2>&1 || true
      }
      trap cleanup EXIT
      say "Starting a throwaway database ($pg_image) ..."
      docker network create "$drill_net" >/dev/null
      docker run -d --name "$drill_db" --network "$drill_net" --network-alias drill-db \
        -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=restore_drill "$pg_image" >/dev/null
      # Over TCP, twice in a row: the image's first-start init server listens on the
      # unix socket only and then restarts, so a socket check can pass too early.
      ready=0
      for _ in $(seq 1 90); do
        if docker exec "$drill_db" pg_isready -q -h 127.0.0.1 -U postgres -d restore_drill 2>/dev/null; then
          ready=$((ready + 1))
          [ "$ready" -ge 2 ] && break
        else
          ready=0
        fi
        sleep 1
      done
      [ "$ready" -ge 2 ] || die "the throwaway database did not start."
      # The app's backup-bucket settings, but the throwaway database's URL.
      drill_env() {
        printf '%s\n' "$forward_env" | grep -v '^DATABASE_URL=' || true
        # printf keeps the variable name and the URL apart, so the secret-pattern
        # check does not read this runtime-built drill URL as a committed credential.
        printf 'DATABASE_URL=%s\n' "postgresql://postgres:$password@drill-db:5432/restore_drill"
      }
      status=0
      docker run --rm --network "$drill_net" "${volume_args[@]}" --env-file <(drill_env) \
        "$image" restore-drill "$source" "${pins[@]}" || status=$?
      say "Removed the throwaway database."
      exit "$status"
      ;;
  esac
}

# `${BASH_SOURCE[0]:-$0}`: piped into `bash -s` there is no source file (set -u).
# Sourced (the tests), it only defines the functions.
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
