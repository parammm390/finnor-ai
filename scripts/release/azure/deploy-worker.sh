#!/usr/bin/env bash
set -Eeuo pipefail

release_sha="__FINNOR_RELEASE_SHA__"
build_id="__FINNOR_BUILD_ID__"
version="__FINNOR_VERSION__"
release_source="__FINNOR_RELEASE_SOURCE__"
repository="__FINNOR_REPOSITORY__"
unit_name="__FINNOR_SYSTEMD_UNIT__"
release_root="__FINNOR_RELEASE_ROOT__"
current_link="__FINNOR_CURRENT_SYMLINK__"
secret_env="__FINNOR_SECRET_ENV__"
release_env="__FINNOR_RELEASE_ENV__"

[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]
remote_main=$(git ls-remote "https://github.com/${repository}.git" refs/heads/main | awk '{print $1}')
test "$remote_main" = "$release_sha"
test -r "$secret_env"

install -d -o finnor -g finnor -m 0755 "$release_root"
release_dir="${release_root}/${release_sha}"
staging_dir="${release_root}/.staging-${release_sha}"

if [ ! -d "${release_dir}/.git" ]; then
  rm -rf "$staging_dir"
  sudo -u finnor git clone --quiet --filter=blob:none --no-checkout "https://github.com/${repository}.git" "$staging_dir"
  sudo -u finnor git -C "$staging_dir" fetch --quiet origin "$release_sha"
  sudo -u finnor git -C "$staging_dir" checkout --quiet --detach "$release_sha"
  test "$(sudo -u finnor git -C "$staging_dir" rev-parse HEAD)" = "$release_sha"
  test -z "$(sudo -u finnor git -C "$staging_dir" status --porcelain=v1 --untracked-files=all)"
  sudo -u finnor bash -lc "cd '$staging_dir/finnor-os' && npm ci --no-audit --no-fund"
  mv "$staging_dir" "$release_dir"
else
  test "$(sudo -u finnor git -C "$release_dir" rev-parse HEAD)" = "$release_sha"
  test -z "$(sudo -u finnor git -C "$release_dir" status --porcelain=v1 --untracked-files=all)"
fi

release_env_tmp=$(mktemp)
unit_tmp=$(mktemp)
next_link="${current_link}.next"
previous_target=$(readlink "$current_link" 2>/dev/null || true)
switched=0

rollback() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$switched" -eq 1 ] && [ -n "$previous_target" ]; then
    ln -sfn "$previous_target" "$next_link"
    mv -Tf "$next_link" "$current_link"
    systemctl restart "$unit_name" || true
  fi
  rm -f "$release_env_tmp" "$unit_tmp" "$next_link"
  exit "$status"
}
trap rollback EXIT

cat >"$release_env_tmp" <<EOF
FINNOR_COMMIT_SHA=$release_sha
FINNOR_BUILD_ID=$build_id
FINNOR_VERSION=$version
FINNOR_ENVIRONMENT=production
FINNOR_RELEASE_SOURCE=$release_source
# The embedded worker also owns the operational SSE gateway.
PORT=8090
FINNOR_WORKER_CAPABILITIES=jobs,orchestration,computer,event-wake,connection-health
EOF
install -o root -g finnor -m 0644 "$release_env_tmp" "$release_env"

cat >"$unit_tmp" <<EOF
[Unit]
Description=FINNOR production worker and embedded orchestrator
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=finnor
Group=finnor
WorkingDirectory=$current_link/finnor-os
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=DOTENV_CONFIG_PATH=$secret_env
EnvironmentFile=$release_env
ExecStart=/opt/node/bin/node $current_link/finnor-os/node_modules/tsx/dist/cli.mjs apps/worker/src/index.ts
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=finnor-worker

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$unit_tmp" "/etc/systemd/system/$unit_name"
systemd-analyze verify "/etc/systemd/system/$unit_name"

ln -sfn "$release_dir" "$next_link"
mv -Tf "$next_link" "$current_link"
switched=1
systemctl daemon-reload
systemctl enable "$unit_name" >/dev/null
systemctl restart "$unit_name"

for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$unit_name"; then
    main_pid=$(systemctl show "$unit_name" -p MainPID --value)
    if [ "${main_pid:-0}" -gt 0 ]; then break; fi
  fi
  sleep 2
done
systemctl is-active --quiet "$unit_name"
test "$(readlink -f "$current_link")" = "$release_dir"
systemctl show "$unit_name" -p ExecStart -p WorkingDirectory --value | grep -q "$current_link"
if journalctl -u "$unit_name" --since "5 minutes ago" --no-pager -o cat | grep -Eqi 'run loop crashed|refused to boot|fatal'; then
  echo "worker emitted a fatal startup error" >&2
  exit 1
fi

switched=0
echo "FINNOR_AZURE_DEPLOY_OK $release_sha"
