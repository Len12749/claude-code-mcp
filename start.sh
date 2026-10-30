#!/bin/bash

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Load local configuration (DeepSeek key, proxy, CLI path). This file is gitignored.
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    . "$SCRIPT_DIR/.env"
    set +a
fi

# Claude Code requires Node >=22; prefer the configured newer runtime.
if [ -n "$NODE_BIN_DIR" ]; then
    export PATH="$NODE_BIN_DIR:$PATH"
fi

# Set environment variables if needed
# export CLAUDE_CLI_PATH="/custom/path/to/claude"
export MCP_CLAUDE_DEBUG="${MCP_CLAUDE_DEBUG:-false}"

# Change to the script directory
cd "$SCRIPT_DIR"

# Run the compiled JavaScript file for npm packages OR TypeScript for local development
if [ -f "dist/server.js" ]; then
    node dist/server.js
elif [ -f "src/server.ts" ] && command -v tsx >/dev/null 2>&1; then
    npx tsx src/server.ts
else
    echo "Error: Neither dist/server.js nor src/server.ts found"
    exit 1
fi