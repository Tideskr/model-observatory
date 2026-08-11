#!/usr/bin/env bash
set -Eeuo pipefail

readonly app_dir="${MODEL_OBSERVATORY_APP_DIR:-/opt/model-observatory}"
readonly compose_file="${MODEL_OBSERVATORY_COMPOSE_FILE:-compose.production.yml}"
readonly env_file="${MODEL_OBSERVATORY_ENV_FILE:-.env.production}"

cd "$app_dir"
git fetch --prune origin main
git merge --ff-only origin/main
docker compose --env-file "$env_file" -f "$compose_file" up -d --build --remove-orphans

for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:18787/api/v1/health >/dev/null; then
    exit 0
  fi
  sleep 2
done

docker compose --env-file "$env_file" -f "$compose_file" ps
exit 1
