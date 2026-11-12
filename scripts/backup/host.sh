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
set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}
say() { echo "[app-db] $*"; }
ask() {
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty || return 1
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

command -v docker >/dev/null || die "docker is not installed on this machine."
docker info >/dev/null 2>&1 || die "cannot talk to Docker. Run this on the Dokploy server as a user who can run docker (with Docker access)."

action="${1:-}"
[ -n "$action" ] || {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
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

# --- Find the app ------------------------------------------------------------
label() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }
mapfile -t projects < <(docker ps -a -f label=com.docker.compose.service=app \
  --format '{{.Label "com.docker.compose.project"}}' | sort -u)
[ ${#projects[@]} -gt 0 ] || die "no app found (no container of a compose service named \"app\")."
if [ -z "$project" ]; then
  if [ ${#projects[@]} -eq 1 ]; then
    project="${projects[0]}"
  else
    say "This server runs more than one app:"
    for i in "${!projects[@]}"; do echo "  $((i + 1))) ${projects[$i]}"; done
    read -r -p "Which one? (number) " pick </dev/tty
    [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le ${#projects[@]} ] ||
      die "no such choice."
    project="${projects[$((pick - 1))]}"
  fi
fi
in_project() { docker ps -a -q -f "label=com.docker.compose.project=$project" "$@"; }
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
volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Name}}{{end}}{{end}}' "$server")"

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

# One-off container of the app image on the app's network.
run_image() {
  local tty=()
  [ -t 0 ] && [ -t 1 ] && tty=(-it)
  docker run --rm "${tty[@]}" --network "$network" "${egress_args[@]}" "${volume_args[@]}" \
    --env-file <(printf '%s\n' "$forward_env") "$image" "$@"
}

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
    [ -t 0 ] || die "restore asks before it changes anything; run it in a terminal."
    source="${args[0]:-latest}"
    [ ${#args[@]} -le 1 ] || die "restore takes one backup name (see: bash $0 list)."
    case "$source" in
      latest | s3://* | /*) ;;
      *) source="/backups/$source" ;;
    esac
    [ -n "$postgres" ] && [ "$(docker inspect -f '{{.State.Running}}' "$postgres")" = true ] ||
      die "the database container is not running; start it in Dokploy first."
    mapfile -t writers < <(
      for id in $(in_project); do
        svc="$(label "$id" com.docker.compose.service)"
        state="$(docker inspect -f '{{.State.Running}}' "$id")"
        { [ "$svc" = app ] || [ "$svc" = backup ]; } && [ "$state" = true ] && echo "$id $svc"
      done
    )
    echo
    say "Restoring stops the app (${#writers[@]} running container(s): $(printf '%s ' "${writers[@]#* }"))"
    say "until it finishes, then starts it again. If Auto Deploy is on in Dokploy, do not merge"
    say "anything meanwhile. You will see a preview and be asked once more before anything changes."
    ask "Stop the app and continue?" || {
      say "Cancelled. Nothing was changed."
      exit 0
    }
    restart() {
      [ ${#writers[@]} -gt 0 ] || return 0
      say "Starting the app again ..."
      for writer in "${writers[@]}"; do docker start "${writer%% *}" >/dev/null || true; done
    }
    trap restart EXIT
    for writer in "${writers[@]}"; do
      say "Stopping ${writer#* } ..."
      docker stop -t 30 "${writer%% *}" >/dev/null
    done
    status=0
    run_image restore "$source" --guided || status=$?
    if [ "$status" -eq 0 ]; then
      say "Restore done. The app applies any pending migrations as it starts."
      say "Check it from your computer: pnpm deploy:check https://<your-app> --commit <deployed commit>"
    else
      say "Nothing was restored (exit $status); the database is as it was."
    fi
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
  *)
    die "unknown command \"$action\" (use list, backup, restore, drill or hold-deletions)."
    ;;
esac
