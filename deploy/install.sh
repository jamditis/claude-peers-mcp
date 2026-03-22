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

# 2. Install deps
cd "$PROJECT_DIR"
bun install

# 3. Copy config
CONFIG_FILE="$SCRIPT_DIR/configs/${MACHINE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "No config found for $MACHINE — create deploy/configs/${MACHINE}.json first"
  exit 1
fi
cp "$CONFIG_FILE" ~/.claude-peers.json
echo "Config installed to ~/.claude-peers.json"

# 4. Install systemd service (Linux only)
if [ "$(uname)" = "Linux" ]; then
  sudo cp "$SCRIPT_DIR/claude-peers-broker.service" /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now claude-peers-broker
  echo "Broker service installed and started"
fi

# 5. Register MCP server with Claude Code
if command -v claude &>/dev/null; then
  claude mcp add --scope user --transport stdio claude-peers -- bun "$PROJECT_DIR/server.ts"
  echo "MCP server registered with Claude Code"
fi

echo "Done. Run 'bun cli.ts status' to verify."
