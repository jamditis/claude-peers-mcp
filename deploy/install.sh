#!/usr/bin/env bash
# deploy/install.sh — run on each node
# Usage: bash deploy/install.sh [machine-name]
# If machine-name is omitted, uses $(hostname)
set -euo pipefail

MACHINE="${1:-$(hostname)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Installing claude-peers on $MACHINE..."

# 1. Install Bun if missing
if ! command -v bun &>/dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Bun must be on PATH now. The systemd unit's ExecStart is rendered from its path
# below, so if the install above failed (no network, etc.) command -v bun is empty
# and we would write a broken ExecStart that leaves the broker unable to start.
# Fail loudly here instead.
if ! command -v bun &>/dev/null; then
  echo "bun is not on PATH and the automatic install did not provide it." >&2
  echo "Install bun manually (https://bun.sh), then re-run deploy/install.sh." >&2
  exit 1
fi

# 2. Install deps
cd "$PROJECT_DIR"
bun install

# 3. Copy config
CONFIG_FILE="$SCRIPT_DIR/configs/${MACHINE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "No config found for $MACHINE — create deploy/configs/${MACHINE}.json first"
  exit 1
fi
# Refuse the shipped example configs — they carry placeholder 100.64.0.x IPs, and
# installing them would advertise the wrong broker address and allowlist dummy peers.
if grep -q '100\.64\.0\.[1-4]' "$CONFIG_FILE"; then
  echo "$CONFIG_FILE still has the example placeholder IPs (100.64.0.x). Replace them with your real Tailscale values before installing."
  exit 1
fi
TARGET_CONFIG="$HOME/.claude-peers.json"
if [ -f "$TARGET_CONFIG" ]; then
  BACKUP_CONFIG="${TARGET_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$TARGET_CONFIG" "$BACKUP_CONFIG"
  echo "Existing config backed up to $BACKUP_CONFIG"
fi
cp "$CONFIG_FILE" "$TARGET_CONFIG"
echo "Config installed to $TARGET_CONFIG"

# 4. Install systemd service (Linux only) — rendered from THIS account and layout.
# The committed claude-peers-broker.service is a reference template with placeholder
# values; copying it verbatim would start the broker under a non-existent user.
if [ "$(uname)" = "Linux" ]; then
  BUN_BIN="$(command -v bun)"
  sudo tee /etc/systemd/system/claude-peers-broker.service >/dev/null <<UNIT
[Unit]
Description=Claude Peers Broker
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
ExecStart=${BUN_BIN} ${PROJECT_DIR}/broker.ts
Restart=always
RestartSec=5
Environment=HOME=${HOME}
# Supervised broker: never self-exit when idle or it would restart-loop.
Environment=CLAUDE_PEERS_IDLE_EXIT_MS=0

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now claude-peers-broker
  echo "Broker service installed and started (rendered for user $(id -un))"
fi

# 5. Register MCP server with Claude Code
if command -v claude &>/dev/null; then
  claude mcp add --scope user --transport stdio claude-peers -- bun "$PROJECT_DIR/server.ts"
  echo "MCP server registered with Claude Code"
fi

echo "Done. Run 'bun cli.ts status' to verify."
