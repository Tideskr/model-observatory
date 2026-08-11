#!/usr/bin/env bash
set -Eeuo pipefail

readonly app_dir="${MODEL_OBSERVATORY_APP_DIR:-/opt/model-observatory}"
readonly compose_file="${MODEL_OBSERVATORY_COMPOSE_FILE:-compose.production.yml}"
readonly env_file="${MODEL_OBSERVATORY_ENV_FILE:-.env.production}"

cd "$app_dir"
readonly previous_commit="$(git rev-parse HEAD)"
git fetch --prune origin main
git merge --ff-only origin/main

rollback() {
  printf 'Deployment failed; rolling back to %s\n' "$previous_commit" >&2
  git reset --hard "$previous_commit"
  docker compose --env-file "$env_file" -f "$compose_file" up -d --build --remove-orphans || true
}

if ! docker compose --env-file "$env_file" -f "$compose_file" up -d --build --remove-orphans; then
  docker compose --env-file "$env_file" -f "$compose_file" ps || true
  rollback
  exit 1
fi

healthy=0
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:18787/api/v1/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  docker compose --env-file "$env_file" -f "$compose_file" ps || true
  rollback
  exit 1
fi
