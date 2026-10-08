import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNodeServer, type RunningServer } from '../../src/adapters/node-http.js';
import { ACCESS_TOKEN, serviceAccountJson, testEnv } from '../helpers/setup.js';

describe('node-http adapter', () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startNodeServer({ env: testEnv(), port: 0, host: '127.0.0.1' });
  });
  afterAll(() => server.close());

  it('boots on a real socket and serves /healthz', async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
  });

  for (const mode of ['legacy', 'auto'] as const) {
    it(`handles an MCP handshake and tools/list (${mode})`, async () => {
      const client = new Client({ name: 'it', version: '1.0.0' }, { versionNegotiation: { mode } });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.length).toBe(12);
      await client.close();
    });
  }

  it('refuses to start without configuration', async () => {
    await expect(startNodeServer({ env: {}, port: 0 })).rejects.toThrow(/refuses to start/);
  });
});

describe('stdio adapter', () => {
  it('runs `gsclaw` over stdio and lists tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli.ts'],
      env: {
        PATH: process.env.PATH ?? '',
        GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
        LOG_LEVEL: 'error',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'it', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('list_sites');
    await client.close();
  });

  it('exits with a setup error when unconfigured', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refuses to start/);
    expect(result.stdout).toBe('');
  });
});
