#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as path from 'path';

// Server version - update this when releasing new versions
const SERVER_VERSION = "1.10.12";

// Define debugMode globally using const
const debugMode = process.env.MCP_CLAUDE_DEBUG === 'true';
const DEFAULT_CLAUDE_CLI_TIMEOUT_SECONDS = 3600;

// 只读代码分析:这些是模型唯一能拿到的内置工具,写文件、执行命令、联网的工具都不在其中。
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

// 追加到 CLI 系统提示,防止模型在只读环境里反复尝试越权操作。
const READ_ONLY_SYSTEM_PROMPT = [
  'You are running in READ-ONLY code analysis mode.',
  'You can only inspect the codebase with the Read, Grep and Glob tools.',
  'Never attempt to create, modify or delete files, run shell commands, install packages or fetch URLs;',
  'those tools are not available, so describe the change instead of applying it.',
  'Ground every answer in concrete file paths (and line numbers when useful).',
  'Explore on a budget: in your first turn issue several Grep calls at once, then read only the files those hits point to.',
  'Read at most 10 files, never re-read a file you have already seen, and stop as soon as you can answer',
  'instead of enumerating the whole repository.',
  'Keep the final answer compact: findings, file paths and line numbers, without restating file contents.',
  'Never expose secrets found in the repository (API keys, passwords, tokens, private keys,',
  'database connection strings, personal data): mask or omit them, never quote them verbatim.',
  'If the requested information is not in the code, say so instead of guessing.',
].join(' ');

// Track if this is the first tool use for version printing
let isFirstToolUse = true;

// Capture server startup time when the module loads
const serverStartupTime = new Date().toISOString();

// Dedicated debug logging function
export function debugLog(message?: any, ...optionalParams: any[]): void {
  if (debugMode) {
    console.error(message, ...optionalParams);
  }
}

export function resolveClaudeCliTimeoutMs(envValue = process.env.CLAUDE_CLI_TIMEOUT_SECONDS): number {
  const raw = envValue?.trim();
  if (!raw) {
    return DEFAULT_CLAUDE_CLI_TIMEOUT_SECONDS * 1000;
  }

  if (!/^\d+$/.test(raw)) {
    debugLog(`[Warning] Invalid CLAUDE_CLI_TIMEOUT_SECONDS value "${raw}". Using default.`);
    return DEFAULT_CLAUDE_CLI_TIMEOUT_SECONDS * 1000;
  }

  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    debugLog(`[Warning] Invalid CLAUDE_CLI_TIMEOUT_SECONDS value "${raw}". Using default.`);
    return DEFAULT_CLAUDE_CLI_TIMEOUT_SECONDS * 1000;
  }

  return seconds * 1000;
}

/**
 * 思考强度:CLI 只接受 low/medium/high/xhigh/max,缺席或非法值一律用最低档。
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function resolveEffortLevel(envValue = process.env.CLAUDE_CODE_MCP_EFFORT): string {
  const raw = envValue?.trim().toLowerCase();
  return raw && (EFFORT_LEVELS as readonly string[]).includes(raw) ? raw : 'low';
}

/**
 * 解析只读工具白名单。环境变量只能在此基础上收窄,不能引入 Bash/Edit/Write 等工具。
 */
export function resolveReadOnlyTools(envValue = process.env.CLAUDE_CODE_MCP_TOOLS): string[] {
  const raw = envValue?.trim();
  if (!raw) {
    return [...READ_ONLY_TOOLS];
  }

  const requested = raw.split(/[\s,]+/).filter(Boolean);
  const unknown = requested.filter((tool) => !(READ_ONLY_TOOLS as readonly string[]).includes(tool));
  if (requested.length === 0 || unknown.length > 0) {
    debugLog(`[Warning] Ignoring CLAUDE_CODE_MCP_TOOLS="${raw}" (allowed: ${READ_ONLY_TOOLS.join(', ')}).`);
    return [...READ_ONLY_TOOLS];
  }

  return [...new Set(requested)];
}

/**
 * 校验并规范化 workFolder。省略时回落到 CLAUDE_CODE_MCP_DEFAULT_ROOT,
 * 各机器只需在 .env 里配置仓库路径,调用方不必知道绝对路径。
 * 若设置了 CLAUDE_CODE_MCP_ALLOWED_ROOTS(冒号分隔),目录必须落在其中之一。
 */
export function resolveWorkFolder(input?: string): string {
  const raw = input?.trim() || process.env.CLAUDE_CODE_MCP_DEFAULT_ROOT?.trim();
  if (!raw) {
    throw new Error('workFolder is required (or set CLAUDE_CODE_MCP_DEFAULT_ROOT on the MCP server).');
  }

  if (!path.isAbsolute(raw)) {
    throw new Error(`workFolder must be an absolute path: ${raw}`);
  }

  let resolved: string;
  try {
    resolved = realpathSync(raw);
  } catch {
    throw new Error(`workFolder does not exist: ${raw}`);
  }

  if (!statSync(resolved).isDirectory()) {
    throw new Error(`workFolder is not a directory: ${raw}`);
  }

  const roots = (process.env.CLAUDE_CODE_MCP_ALLOWED_ROOTS ?? '')
    .split(':')
    .map((root) => root.trim())
    .filter(Boolean);
  if (roots.length > 0) {
    const allowed = roots.some((root) => {
      try {
        const rootPath = realpathSync(root);
        return resolved === rootPath || resolved.startsWith(rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep);
      } catch {
        debugLog(`[Warning] Igoring non-existent allowed root: ${root}`);
        return false;
      }
    });
    if (!allowed) {
      throw new Error(`workFolder is outside CLAUDE_CODE_MCP_ALLOWED_ROOTS: ${raw}`);
    }
  }

  return resolved;
}

/**
 * Determine the Claude CLI command/path.
 * 1. Checks CLAUDE_CLI_PATH env var (absolute path to the CLI binary).
 * 2. Checks CLAUDE_CLI_NAME env var (custom binary name or absolute path).
 * 3. Checks local user path: ~/.claude/local/claude (+ .cmd/.exe on Windows).
 * 4. Falls back to the CLI name (or 'claude'), relying on the system's PATH.
 */
export function findClaudeCli(): string {
  debugLog('[Debug] Attempting to find Claude CLI...');
  const isWindows = process.platform === 'win32';

  // 1. Check CLAUDE_CLI_PATH first (explicit absolute path to the binary)
  const cliPath = process.env.CLAUDE_CLI_PATH;
  if (cliPath) {
    debugLog(`[Debug] CLAUDE_CLI_PATH is set: ${cliPath}`);
    if (existsSync(cliPath)) {
      debugLog(`[Debug] Found Claude CLI at CLAUDE_CLI_PATH: ${cliPath}`);
      return cliPath;
    }
    console.warn(`[Warning] CLAUDE_CLI_PATH is set to "${cliPath}" but file does not exist. Continuing with other methods.`);
  }

  // 2. Check for custom CLI name from environment variable
  const customCliName = process.env.CLAUDE_CLI_NAME;
  if (customCliName) {
    debugLog(`[Debug] Using custom Claude CLI name from CLAUDE_CLI_NAME: ${customCliName}`);

    // If it's an absolute path, use it directly
    if (path.isAbsolute(customCliName)) {
      debugLog(`[Debug] CLAUDE_CLI_NAME is an absolute path: ${customCliName}`);
      return customCliName;
    }

    // If it starts with ~ or ./, reject as relative paths are not allowed
    if (customCliName.startsWith('./') || customCliName.startsWith('../') || customCliName.includes('/')) {
      throw new Error(`Invalid CLAUDE_CLI_NAME: Relative paths are not allowed. Use either a simple name (e.g., 'claude') or an absolute path (e.g., '/tmp/claude-test')`);
    }
  }

  const cliName = customCliName || 'claude';

  // 3. Try local install path: ~/.claude/local/claude
  //    On Windows, also check .cmd and .exe extensions since npm installs create .cmd wrappers
  const userPath = join(homedir(), '.claude', 'local', 'claude');
  const candidatePaths = isWindows
    ? [userPath, `${userPath}.cmd`, `${userPath}.exe`]
    : [userPath];

  for (const candidate of candidatePaths) {
    debugLog(`[Debug] Checking for Claude CLI at: ${candidate}`);
    if (existsSync(candidate)) {
      debugLog(`[Debug] Found Claude CLI at: ${candidate}`);
      return candidate;
    }
  }
  debugLog(`[Debug] Claude CLI not found at local user path: ${userPath}`);

  // 4. On Windows, also check common npm global install locations
  if (isWindows) {
    const npmGlobalPaths = [
      join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.exe'),
    ];
    for (const npmPath of npmGlobalPaths) {
      debugLog(`[Debug] Checking Windows npm global path: ${npmPath}`);
      if (existsSync(npmPath)) {
        debugLog(`[Debug] Found Claude CLI at npm global path: ${npmPath}`);
        return npmPath;
      }
    }
  }

  // 5. Fallback to CLI name (PATH lookup)
  debugLog(`[Debug] Falling back to "${cliName}" command name, relying on spawn/PATH lookup.`);
  console.warn(`[Warning] Claude CLI not found at local paths. Falling back to "${cliName}" in PATH. Ensure it is installed and accessible.`);
  return cliName;
}

/**
 * Interface for Claude Code tool arguments
 */
interface ClaudeCodeArgs {
  prompt: string;
  workFolder?: string;
  sessionId?: string;
  messages?: ConversationMessage[];
  stateless?: boolean;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeCliResponse {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
}

interface SessionEntry {
  claudeSessionId: string;
  updatedAt: string;
}

const MAX_SESSIONS = 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_FILE =
  process.env.CLAUDE_CODE_MCP_SESSION_FILE ||
  join(homedir(), '.config', 'claude-code-mcp', 'sessions.json');
let sessionMap: Map<string, SessionEntry> | null = null;

function ensureSessionMap(): Map<string, SessionEntry> {
  if (sessionMap) return sessionMap;
  sessionMap = new Map();
  try {
    if (existsSync(SESSION_FILE)) {
      const parsed = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Record<string, SessionEntry>;
      sessionMap = new Map(Object.entries(parsed));
      cleanExpiredSessions();
    }
  } catch (error) {
    debugLog('[Debug] Failed to load Claude session map:', error);
    sessionMap = new Map();
  }
  return sessionMap;
}

function saveSessionMap(): void {
  const map = ensureSessionMap();
  try {
    mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(map), null, 2), {
      mode: 0o600,
    });
  } catch (error) {
    debugLog('[Debug] Failed to save Claude session map:', error);
  }
}

function cleanExpiredSessions(): void {
  const map = ensureSessionMap();
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of map) {
    if (now - new Date(entry.updatedAt).getTime() > SESSION_TTL_MS) {
      map.delete(key);
      changed = true;
    }
  }
  if (changed) saveSessionMap();
}

function getSessionMapping(parentSessionId: string): string | undefined {
  const map = ensureSessionMap();
  const entry = map.get(parentSessionId);
  if (!entry) return undefined;
  if (Date.now() - new Date(entry.updatedAt).getTime() > SESSION_TTL_MS) {
    map.delete(parentSessionId);
    saveSessionMap();
    return undefined;
  }
  return entry.claudeSessionId;
}

function setSessionMapping(parentSessionId: string, claudeSessionId: string): void {
  const map = ensureSessionMap();
  if (map.size >= MAX_SESSIONS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey) map.delete(oldestKey);
  }
  map.set(parentSessionId, {
    claudeSessionId,
    updatedAt: new Date().toISOString(),
  });
  saveSessionMap();
}

function formatConversationContext(messages: ConversationMessage[]): string {
  if (messages.length === 0) return '';
  const formatted = messages
    .map((message) => {
      const role = message.role === 'assistant' ? 'Assistant' : 'User';
      return `[${role}]: ${message.content}`;
    })
    .join('\n\n');
  return `<conversation_context>\n${formatted}\n</conversation_context>\n\n`;
}

function translateSlashCommands(prompt: string): string {
  return prompt.replace(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?=\s|$)/gm, '@$1');
}

function parseClaudeResponse(stdout: string): ClaudeCliResponse | null {
  const trimmed = stdout.trim();
  const candidates = trimmed.startsWith('{') && trimmed.endsWith('}')
    ? [trimmed]
    : trimmed.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{') && line.endsWith('}')).reverse();

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ClaudeCliResponse;
      if (parsed.type === 'result') return parsed;
    } catch {
      // Try the next JSON-looking line.
    }
  }
  return null;
}

// Ensure spawnAsync is defined correctly *before* the class
export async function spawnAsync(command: string, args: string[], options?: { timeout?: number, cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    debugLog(`[Spawn] Running command: ${command} ${args.join(' ')}`);

    // On Windows, .cmd/.bat files need shell: true to execute properly
    const needsShell = process.platform === 'win32' &&
      (command.toLowerCase().endsWith('.cmd') || command.toLowerCase().endsWith('.bat'));

    const childProcess = spawn(command, args, {
      shell: needsShell,
      timeout: options?.timeout,
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    childProcess.stdout.on('data', (data) => { stdout += data.toString(); });
    childProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      debugLog(`[Spawn Stderr Chunk] ${data.toString()}`);
    });

    childProcess.on('error', (error: NodeJS.ErrnoException) => {
      debugLog(`[Spawn Error Event] Full error object:`, error);
      let errorMessage = `Spawn error: ${error.message}`;
      if (error.path) {
        errorMessage += ` | Path: ${error.path}`;
      }
      if (error.syscall) {
        errorMessage += ` | Syscall: ${error.syscall}`;
      }
      errorMessage += `\nStderr: ${stderr.trim()}`;
      reject(new Error(errorMessage));
    });

    childProcess.on('close', (code) => {
      debugLog(`[Spawn Close] Exit code: ${code}`);
      debugLog(`[Spawn Stderr Full] ${stderr.trim()}`);
      debugLog(`[Spawn Stdout Full] ${stdout.trim()}`);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`));
      }
    });
  });
}

/**
 * MCP Server for Claude Code
 * Provides a simple MCP tool to run Claude CLI in one-shot mode
 */
export class ClaudeCodeServer {
  private server: Server;
  private claudeCliPath: string; // This now holds either a full path or just 'claude'
  private packageVersion: string; // Add packageVersion property

  constructor() {
    // Use the simplified findClaudeCli function
    this.claudeCliPath = findClaudeCli(); // Removed debugMode argument
    console.error(`[Setup] Using Claude CLI command/path: ${this.claudeCliPath}`);
    this.packageVersion = SERVER_VERSION;

    this.server = new Server(
      {
        name: 'claude_code',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Set up the MCP tool handlers
   */
  private setupToolHandlers(): void {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'claude_code',
          description: `Read-only code analysis of a repository via Claude Code. It can only inspect sources with Read, Grep and Glob: it cannot modify files, run commands, install packages or use the network.

• Understand the codebase
    └─ "Explain the request pipeline of this project", "Which module owns billing?"
• Locate code
    └─ "Where is authentication implemented?", "Find every caller of getSession"
• Review & diagnose
    └─ "Why can this endpoint return 500?", "What are the risks of functions/retry.ts?"
• Summarise behaviour
    └─ "Describe the public API surface of src/api"

**Tips**
1. workFolder may be omitted: the server defaults to the repository it is configured for. Pass it only to analyse another allowed directory; relative paths resolve from it.
2. Ask specific questions: answers cite file paths and line numbers.
3. Large repositories: point at directories or files instead of "explain everything".
4. Reuse sessionId for follow-up questions about the same repository.
5. Requests that would need edits are answered with a proposal, never applied.
        `,
          inputSchema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The analysis question or instruction. Be specific; the answer cites file paths and line numbers.',
              },
              workFolder: {
                type: 'string',
                description: 'Optional absolute path of the directory to analyse. Omit it to use the repository configured on the server (the normal case); a supplied path must live under the server allow-list.',
              },
              sessionId: {
                type: 'string',
                description: 'Parent session ID. When provided, repeated calls resume the same Claude Code session.',
              },
              messages: {
                type: 'array',
                description: 'Conversation history to inject on the first call for a session.',
                items: {
                  type: 'object',
                  properties: {
                    role: {
                      type: 'string',
                      enum: ['user', 'assistant'],
                    },
                    content: {
                      type: 'string',
                    },
                  },
                  required: ['role', 'content'],
                },
              },
              stateless: {
                type: 'boolean',
                description: 'Disable session continuity for this call.',
                default: false,
              },
            },
            required: ['prompt'],
          },
        }
      ],
    }));

    // Handle tool calls
    const executionTimeoutMs = resolveClaudeCliTimeoutMs();

    this.server.setRequestHandler(CallToolRequestSchema, async (args, call): Promise<ServerResult> => {
      debugLog('[Debug] Handling CallToolRequest:', args);

      // Correctly access toolName from args.params.name
      const toolName = args.params.name;
      if (toolName !== 'claude_code') {
        // ErrorCode.ToolNotFound should be ErrorCode.MethodNotFound as per SDK for tools
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
      }

      // Robustly access prompt from args.params.arguments
      const toolArguments = args.params.arguments;
      let prompt: string;

      if (
        toolArguments &&
        typeof toolArguments === 'object' &&
        'prompt' in toolArguments &&
        typeof toolArguments.prompt === 'string'
      ) {
        prompt = toolArguments.prompt;
      } else {
        throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: prompt (must be an object with a string "prompt" property) for claude_code tool');
      }

      const sessionId = toolArguments.sessionId;
      if (sessionId !== undefined && typeof sessionId !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid parameter: sessionId must be a string.');
      }

      const messages = toolArguments.messages;
      if (messages !== undefined) {
        if (!Array.isArray(messages)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid parameter: messages must be an array.');
        }
        for (const message of messages) {
          if (
            typeof message !== 'object' ||
            message === null ||
            (message.role !== 'user' && message.role !== 'assistant') ||
            typeof message.content !== 'string'
          ) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid parameter: each message must include role and content strings.');
          }
        }
      }

      const stateless = toolArguments.stateless === true;

      // 目标目录:调用方可省略,服务端回落到 CLAUDE_CODE_MCP_DEFAULT_ROOT,
      // 避免把本机路径写进提示词,也避免默认扫描整个 home。
      const workFolderInput = typeof toolArguments.workFolder === 'string' ? toolArguments.workFolder : undefined;
      if (workFolderInput !== undefined && (typeof toolArguments.workFolder !== 'string' || workFolderInput.trim() === '')) {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid parameter: workFolder must be a non-empty absolute path.');
      }

      let effectiveCwd: string;
      try {
        effectiveCwd = resolveWorkFolder(workFolderInput);
      } catch (error: any) {
        throw new McpError(ErrorCode.InvalidParams, error.message || String(error));
      }
      const readOnlyTools = resolveReadOnlyTools();
      debugLog(`[Debug] Analysing "${effectiveCwd}" with tools: ${readOnlyTools.join(',')}`);

      try {
        debugLog(`[Debug] Attempting to execute Claude CLI with prompt: "${prompt}" in CWD: "${effectiveCwd}"`);

        // Print tool info on first use
        if (isFirstToolUse) {
          const versionInfo = `claude_code v${SERVER_VERSION} started at ${serverStartupTime}`;
          console.error(versionInfo);
          isFirstToolUse = false;
        }

        let processedPrompt = translateSlashCommands(prompt);
        const claudeProcessArgs = [
          // 只暴露只读工具;--restricted 额外移除代码执行能力、忽略本地 settings,
          // 并把文件工具限制在 CWD 之内;--strict-mcp-config 避免加载外部 MCP 服务器。
          '--tools', readOnlyTools.join(','),
          '--restricted',
          '--strict-mcp-config',
          '--append-system-prompt', READ_ONLY_SYSTEM_PROMPT,
          '--output-format', 'json',
          // 默认最低思考强度,降低单次分析的响应时间
          '--effort', resolveEffortLevel(),
        ];
        const useSessionContinuity = !stateless && typeof sessionId === 'string' && sessionId.length > 0;

        if (useSessionContinuity) {
          const existingClaudeSessionId = getSessionMapping(sessionId);
          if (existingClaudeSessionId) {
            claudeProcessArgs.push('--resume', existingClaudeSessionId);
          } else if (Array.isArray(messages) && messages.length > 0) {
            processedPrompt = formatConversationContext(messages as ConversationMessage[]) +
              'Continue the conversation. ' +
              processedPrompt;
          }
        }

        claudeProcessArgs.push('-p', processedPrompt);
        debugLog(`[Debug] Invoking Claude CLI: ${this.claudeCliPath} ${claudeProcessArgs.join(' ')}`);

        const { stdout, stderr } = await spawnAsync(
          this.claudeCliPath, // Run the Claude CLI directly
          claudeProcessArgs, // Pass the arguments
          { timeout: executionTimeoutMs, cwd: effectiveCwd }
        );

        debugLog('[Debug] Claude CLI stdout:', stdout.trim());
        if (stderr) {
          debugLog('[Debug] Claude CLI stderr:', stderr.trim());
        }

        const parsedResponse = parseClaudeResponse(stdout);
        if (!parsedResponse) {
          // JSON 输出意外不可解析时退回原始 stdout,至少不丢结果。
          return { content: [{ type: 'text', text: stdout }] };
        }

        if (parsedResponse.is_error) {
          throw new McpError(ErrorCode.InternalError, parsedResponse.result || 'Claude CLI reported an error.');
        }

        const resultText = parsedResponse.result ?? '';
        const claudeSessionId = parsedResponse.session_id;
        if (useSessionContinuity && claudeSessionId) {
          setSessionMapping(sessionId, claudeSessionId);
        }

        const content: { type: 'text'; text: string }[] = [{ type: 'text', text: resultText }];
        // 只有续聊调用才回传 session id,避免污染一次性查询的答案。
        if (useSessionContinuity && claudeSessionId) {
          content.push({ type: 'text', text: `\n---\n_Session ID: ${claudeSessionId}_` });
        }
        return { content };

      } catch (error: any) {
        if (error instanceof McpError) {
          throw error;
        }
        debugLog('[Error] Error executing Claude CLI:', error);
        let errorMessage = error.message || 'Unknown error';
        // Attempt to include stderr and stdout from the error object if spawnAsync attached them
        if (error.stderr) {
          errorMessage += `\nStderr: ${error.stderr}`;
        }
        if (error.stdout) {
          errorMessage += `\nStdout: ${error.stdout}`;
        }

        if (error.signal === 'SIGTERM' || (error.message && error.message.includes('ETIMEDOUT')) || (error.code === 'ETIMEDOUT')) {
          // Reverting to InternalError due to lint issues, but with a specific timeout message.
          throw new McpError(ErrorCode.InternalError, `Claude CLI command timed out after ${executionTimeoutMs / 1000}s. Details: ${errorMessage}`);
        }
        // ErrorCode.ToolCallFailed should be ErrorCode.InternalError or a more specific execution error if available
        throw new McpError(ErrorCode.InternalError, `Claude CLI execution failed: ${errorMessage}`);
      }
    });
  }

  /**
   * Start the MCP server
   */
  async run(): Promise<void> {
    // Revert to original server start logic if listen caused errors
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Claude Code MCP server running on stdio');
  }
}

export async function main(): Promise<void> {
  const server = new ClaudeCodeServer();
  await server.run();
}

const isMainModule = process.argv[1] !== undefined
  && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch(console.error);
}
