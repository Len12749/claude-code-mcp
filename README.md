# Claude Code MCP Server (read-only code analysis)

An MCP (Model Context Protocol) server that wraps the local Claude Code CLI as a **read-only code analysis** tool: the caller sends a question plus a directory, and gets an analysis back. It cannot modify files, run commands, install packages or access the network.

This is a fork of [@steipete/claude-code-mcp](https://github.com/steipete/claude-code-mcp) that replaces the original "bypass all permissions" behaviour with a hard read-only mode, which makes the tool safe to expose to other agents or workflow engines (Dify, n8n, LangGraph, another coding agent, ...).

<img src="assets/claude_code_mcp_logo.png" alt="Claude Code MCP Logo">

## How read-only is enforced

Every invocation starts the Claude Code CLI with a fixed set of flags. The caller cannot override them:

| Flag | Effect |
| --- | --- |
| `--tools Read,Grep,Glob` | The model only ever sees these three built-in tools. No `Edit`, `Write`, `Bash`, `WebFetch` or sub-agents. |
| `--restricted` | Removes code-running tools, ignores user/project settings, confines file tools to the working directory and refuses `bypassPermissions`. |
| `--strict-mcp-config` | Skips MCP servers configured on the machine, so no side channel to file writes or the network. |
| `--append-system-prompt` | Adds an explicit read-only instruction to the system prompt. |
| `--output-format json` | Returns only the final answer (errors are surfaced as MCP errors). |

`workFolder` is optional: when omitted the server analyses the repository configured in `CLAUDE_CODE_MCP_DEFAULT_ROOT`, which keeps the repository path out of prompts and portable across machines (only the `.env` changes). A supplied path must be absolute and, when `CLAUDE_CODE_MCP_ALLOWED_ROOTS` is set, inside that list. Paths are resolved through `realpathSync` before use. This is not an OS-level sandbox, but every tool-level path to a write, shell command or network call is closed.

## Environment variables

- `CLAUDE_CLI_PATH`: Absolute path to the Claude CLI executable.
- `CLAUDE_CLI_NAME`: CLI binary name or absolute path (default: `claude`).
- `CLAUDE_CLI_TIMEOUT_SECONDS`: Per-call timeout in seconds (default: `3600`).
- `CLAUDE_CODE_MCP_TOOLS`: Restrict the tool whitelist further, e.g. `Read,Grep`. Values outside `Read,Grep,Glob` are ignored.
- `CLAUDE_CODE_MCP_DEFAULT_ROOT`: Repository analysed when the caller omits `workFolder`. Set this per machine.
- `CLAUDE_CODE_MCP_ALLOWED_ROOTS`: Colon-separated directories that `workFolder` must live under. Unset means any existing directory is allowed.
- `CLAUDE_CODE_MCP_EFFORT`: Reasoning effort passed as `--effort` (default: `low`).
- `MCP_CLAUDE_DEBUG`: Set to `true` for verbose logging on stderr.

## Requirements

- Node.js v22 or later (Claude Code 2.x requires it).
- Claude Code CLI installed locally. A DeepSeek (or Anthropic-compatible) endpoint works too:

```bash
# .env used by start.sh
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-...
ANTHROPIC_MODEL=deepseek-flash[1m]
CLAUDE_CLI_PATH=./node_modules/.bin/claude
NODE_BIN_DIR=/path/to/node/bin
```

## Installation & MCP client configuration

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "/path/to/claude-code-mcp/start.sh",
      "env": {
        "CLAUDE_CODE_MCP_ALLOWED_ROOTS": "/Users/me/projects"
      }
    }
  }
}
```

`start.sh` loads the local `.env`, puts the configured Node runtime on `PATH` and runs `dist/server.js`.

## Tool: `claude_code`

Runs a read-only analysis of the configured repository (or of `workFolder`) through Claude Code.

**Arguments:**

- `prompt` (string, required): The analysis question or instruction.
- `workFolder` (string, optional): Directory to analyse. Omit it in normal use so the server's `CLAUDE_CODE_MCP_DEFAULT_ROOT` applies; a supplied path must be absolute and inside the allow-list.
- `sessionId` (string, optional): Parent session ID; repeated calls with the same ID resume the same Claude Code session.
- `messages` (array, optional): Conversation history to inject on the first call of a session.
- `stateless` (boolean, optional): Disable session continuity for this call.

**Example request:**

```json
{
  "toolName": "claude_code:claude_code",
  "arguments": {
    "prompt": "Explain the request pipeline and point out where retries are implemented."
  }
}
```

**Typical questions:**

- "Summarise the architecture of this repository in 10 bullet points."
- "Where is authentication implemented? List the files and entry points."
- "Which callers depend on `getSession`?"
- "Why can `POST /orders` return 500? Trace the error path."
- "Describe the public API surface of `src/api`."

## Troubleshooting

- **`workFolder does not exist` / `must be an absolute path`**: check `CLAUDE_CODE_MCP_DEFAULT_ROOT`, or pass an absolute path that is inside `CLAUDE_CODE_MCP_ALLOWED_ROOTS`.
- **`Claude CLI not found`**: set `CLAUDE_CLI_PATH` to the binary (for a local install: `node_modules/.bin/claude`).
- **`Claude CLI command timed out`**: split the question into smaller ones or raise `CLAUDE_CLI_TIMEOUT_SECONDS`.
- **DeepSeek / third-party endpoints**: set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; a local proxy is needed on some networks (`HTTPS_PROXY`).

## Development

```bash
npm ci
npm run build      # tsc -> dist/
npm run test:unit  # unit tests (no network)
npm run test:e2e   # e2e tests with a mock CLI
```

Source lives in `src/server.ts`; the tool schema and the read-only flags are defined in the `setupToolHandlers` method.

## License

MIT
