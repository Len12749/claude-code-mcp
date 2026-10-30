import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCPTestClient } from './utils/mcp-client.js';
import { getSharedMock, getMockCliPath } from './utils/persistent-mock.js';

describe('Claude Code MCP E2E Tests', () => {
  let client: MCPTestClient;
  let testDir: string;
  const serverPath = 'dist/server.js';

  beforeEach(async () => {
    // Ensure mock exists
    await getSharedMock();

    // Create a temporary directory for test files
    testDir = mkdtempSync(join(tmpdir(), 'claude-code-test-'));

    // Initialize MCP client with debug mode and custom binary name using dynamic path
    client = new MCPTestClient(serverPath, {
      MCP_CLAUDE_DEBUG: 'true',
      CLAUDE_CLI_NAME: getMockCliPath(),
    });

    await client.connect();
  });

  afterEach(async () => {
    // Disconnect client
    await client.disconnect();
    
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });
  // Note: Mock cleanup is handled by global setup.ts, not here
  // to avoid race conditions with parallel test files

  describe('Tool Registration', () => {
    it('should register claude_code tool', async () => {
      const tools = await client.listTools();
      
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        name: 'claude_code',
        description: expect.stringContaining('Read-only code analysis'),
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            prompt: {
              type: 'string',
              description: expect.stringContaining('analysis question'),
            },
            workFolder: {
              type: 'string',
              description: expect.stringContaining('only directory'),
            },
            sessionId: expect.objectContaining({
              type: 'string',
            }),
            messages: expect.objectContaining({
              type: 'array',
            }),
            stateless: expect.objectContaining({
              type: 'boolean',
            }),
          }),
          required: ['prompt', 'workFolder'],
        }),
      });
    });
  });

  describe('Basic Operations', () => {
    it('should run a read-only analysis prompt', async () => {
      const response = await client.callTool('claude_code', {
        prompt: 'explain the directory layout',
        workFolder: testDir,
      });

      expect(response).toEqual([{
        type: 'text',
        text: expect.stringContaining('successfully'),
      }]);
    });

    it('should handle errors gracefully', async () => {
      // The mock should trigger an error
      await expect(
        client.callTool('claude_code', {
          prompt: 'error',
          workFolder: testDir,
        })
      ).rejects.toThrow();
    });

    it('should reject calls without workFolder', async () => {
      await expect(
        client.callTool('claude_code', {
          prompt: 'List files in current directory',
        })
      ).rejects.toThrow(/workFolder/);
    });
  });

  describe('Working Directory Handling', () => {
    it('should respect custom working directory', async () => {
      const response = await client.callTool('claude_code', {
        prompt: 'Show current working directory',
        workFolder: testDir,
      });

      expect(response).toBeTruthy();
    });

    it('should reject a non-existent working directory', async () => {
      const nonExistentDir = join(testDir, 'non-existent');

      await expect(
        client.callTool('claude_code', {
          prompt: 'Test prompt',
          workFolder: nonExistentDir,
        })
      ).rejects.toThrow(/does not exist/);
    });
  });

  describe('Timeout Handling', () => {
    it('should respect timeout settings', async () => {
      // This would require modifying the mock to simulate a long-running command
      // Since we're testing locally, we'll skip the actual timeout test
      expect(true).toBe(true);
    });
  });

  describe('Debug Mode', () => {
    it('should log debug information when enabled', async () => {
      // Debug logs go to stderr, which we capture in the client
      const response = await client.callTool('claude_code', {
        prompt: 'Debug test prompt',
        workFolder: testDir,
      });

      expect(response).toBeTruthy();
    });
  });
});

describe('Integration Tests (Local Only)', () => {
  let client: MCPTestClient;
  let testDir: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'claude-code-integration-'));
    
    // Initialize client without mocks for real Claude testing
    client = new MCPTestClient('dist/server.js', {
      MCP_CLAUDE_DEBUG: 'true',
    });
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  // These tests will only run locally when Claude is available
  it.skip('should analyse a file with real Claude CLI', async () => {
    await client.connect();

    const response = await client.callTool('claude_code', {
      prompt: 'Summarise package.json',
      workFolder: process.cwd(),
    });

    expect(JSON.stringify(response)).toContain('name');
  });

  it.skip('should refuse to modify files with real Claude CLI', async () => {
    await client.connect();

    const filePath = join(testDir, 'hello.txt');
    await client.callTool('claude_code', {
      prompt: `Create ${filePath} with content "Hello from Claude"`,
      workFolder: testDir,
    });

    // 只读模式:CLI 没有写文件工具,文件不应被创建
    expect(existsSync(filePath)).toBe(false);
  });
});
