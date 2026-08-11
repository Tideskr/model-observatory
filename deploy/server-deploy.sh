#!/usr/bin/env bash
set -Eeuo pipefail

readonly app_dir="${MODEL_OBSERVATORY_APP_DIR:-/opt/model-observatory}"
readonly compose_file="${MODEL_OBSERVATORY_COMPOSE_FILE:-compose.production.yml}"
readonly env_file="${MODEL_OBSERVATORY_ENV_FILE:-.env.production}"

cd "$app_dir"
readonly previous_commit="$(git rev-parse HEAD)"
git fetch --prune origin main
readonly target_commit="$(git rev-parse origin/main)"
mapfile -t changed_files < <(git diff --name-only "$previous_commit" "$target_commit")
registry_only=0
if [ "${#changed_files[@]}" -gt 0 ]; then
  registry_only=1
  for changed_file in "${changed_files[@]}"; do
    if [ "$changed_file" != "registry/providers.json" ]; then
      registry_only=0
      break
    fi
  done
fi
git merge --ff-only "$target_commit"

registry_sync() {
  local commit_sha="$1"
  REGISTRY_GIT_COMMIT="$commit_sha" REGISTRY_ACTOR=gitops \
    docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
      -v "$app_dir/registry:/app/registry:ro" \
      -e REGISTRY_GIT_COMMIT -e REGISTRY_ACTOR \
      migrate node dist/registry/sync-cli.js
}

wait_for_registry() {
  local expected_sha="$1"
  for _attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:18787/api/v1/health \
      | grep --fixed-strings --quiet "\"registry_sha256\":\"$expected_sha\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if [ "$registry_only" -eq 1 ]; then
  if sync_output="$(registry_sync "$target_commit")"; then
    printf '%s\n' "$sync_output"
    registry_sha="$(printf '%s\n' "$sync_output" | sed -n 's/^Provider registry synced: \([a-f0-9]\{64\}\)$/\1/p' | tail -n 1)"
    if [ -n "$registry_sha" ] && wait_for_registry "$registry_sha"; then
      printf 'Provider registry hot published at %s\n' "$registry_sha"
      exit 0
    fi
  fi
  printf 'Registry publish failed; restoring %s\n' "$previous_commit" >&2
  git reset --hard "$previous_commit"
  registry_sync "$previous_commit" || true
  exit 1
fi

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
