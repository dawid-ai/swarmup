import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, setSecret } from '@swarmup/core';
import type { RunRecord } from '@swarmup/supervisor';
import { opsdConfig, startApi, Supervisor } from '@swarmup/supervisor';
import type { McpSpec } from '../src/mcp-cmd.js';
import { fetchMcpSpec, McpFilter, runMcpProxy } from '../src/mcp-cmd.js';

// `swarmup mcp exec` (W8): the proxy between a run's runtime and a real MCP server. It fetches
// the spec with the run's token, gives the server its secrets in its environment only, filters
// tools by the server's rules and logs each call's tool name and argument hash.

const SECRET = 'proxy-test-secret-value-0451';
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-mcp-'));
  dirs.push(d);
  return d;
}

/** A tiny stdio MCP server: three tools, and each call it gets appended to `CALLS`. */
const FAKE_SERVER = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ id: m.id, result: { tools: ['search_code', 'delete_repo', 'show_env'].map((name) => ({ name, inputSchema: { type: 'object' } })) } });
  } else if (m.method === 'tools/call') {
    appendFileSync(process.env.CALLS, m.params.name + '\\n');
    const text = m.params.name === 'show_env'
      ? JSON.stringify({ secret: process.env.GH_TOKEN === process.env.WANT, runToken: process.env.SWARMUP_RUN_TOKEN ?? null })
      : 'ok ' + JSON.stringify(m.params.arguments);
    send({ id: m.id, result: { content: [{ type: 'text', text }] } });
  }
}
`;

function fakeServer(): { file: string; calls: string } {
  const dir = temp();
  const file = join(dir, 'fake-mcp.mjs');
  writeFileSync(file, FAKE_SERVER);
  return { file, calls: join(dir, 'calls.txt') };
}

describe('McpFilter', () => {
  it('hides denied tools from tools/list and answers their calls itself', () => {
    const log: Record<string, unknown>[] = [];
    const f = new McpFilter('gh', { deny: ['delete_*'] }, (e) => log.push(e));
    const list = f.fromClient('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    expect(list).toEqual({ forward: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', reply: [] });
    const answer = JSON.parse(
      f.fromServer(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'a' }, { name: 'delete_x' }] },
        }),
      ),
    ) as { result: { tools: { name: string }[] } };
    expect(answer.result.tools.map((t) => t.name)).toEqual(['a']);
    // Another answer with the same id later is left alone.
    const again = JSON.stringify({ id: 2, result: { tools: [{ name: 'delete_x' }] } });
    expect(f.fromServer(again)).toBe(again);
    const call = f.fromClient(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'delete_x', arguments: { repo: 'r' } },
      }),
    );
    expect(call.forward).toBeNull();
    expect(JSON.parse(call.reply[0]!)).toMatchObject({ id: 3, error: { code: -32602 } });
    // A batch keeps what is allowed.
    const batch = f.fromClient(
      JSON.stringify([
        { id: 4, method: 'tools/call', params: { name: 'delete_y' } },
        { id: 5, method: 'tools/call', params: { name: 'a' } },
      ]),
    );
    expect(JSON.parse(batch.forward!)).toEqual([
      { id: 5, method: 'tools/call', params: { name: 'a' } },
    ]);
    expect(log.map((e) => [e.tool, e.allowed])).toEqual([
      ['delete_x', false],
      ['delete_y', false],
      ['a', true],
    ]);
    expect(JSON.stringify(log)).not.toContain('"repo"');
  });
});

describe('runMcpProxy against a stdio server', () => {
  it('relays, filters, gives the secret to the server only and logs calls', async () => {
    const { file, calls } = fakeServer();
    const runDir = temp();
    const spec: McpSpec = {
      name: 'gh',
      command: process.execPath,
      args: [file],
      env: { GH_TOKEN: SECRET, WANT: SECRET, CALLS: calls },
      tools: { deny: ['delete_*'] },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: Record<string, unknown>[] = [];
    let buf = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (c: string) => {
      buf += c;
      let at: number;
      while ((at = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, at)) as Record<string, unknown>);
        buf = buf.slice(at + 1);
      }
    });
    const env = { ...process.env, SWARMUP_RUN_TOKEN: 'run-token-of-the-run' };
    const done = runMcpProxy({ spec, runDir, env, io: { stdin, stdout } });
    const send = (m: object): boolean =>
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'tools/list' });
    send({
      id: 3,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { q: 'needle' } },
    });
    send({
      id: 4,
      method: 'tools/call',
      params: { name: 'delete_repo', arguments: { repo: 'r' } },
    });
    send({ id: 5, method: 'tools/call', params: { name: 'show_env', arguments: {} } });
    const deadline = Date.now() + 20_000;
    while (out.length < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    stdin.end();
    expect(await done).toBe(0);
    const byId = new Map(out.map((m) => [m.id, m]));
    const tools = (byId.get(2)!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(['search_code', 'show_env']);
    expect(JSON.stringify(byId.get(3))).toContain('ok {\\"q\\":\\"needle\\"}');
    expect(byId.get(4)).toMatchObject({
      error: { message: 'tool delete_repo is not allowed for this run' },
    });
    const env5 = JSON.parse(
      (byId.get(5)!.result as { content: { text: string }[] }).content[0]!.text,
    ) as { secret: boolean; runToken: string | null };
    expect(env5).toEqual({ secret: true, runToken: null });
    // The denied call never reached the server.
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['search_code', 'show_env']);
    const log = readFileSync(join(runDir, 'mcp.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.map((e) => [e.server, e.tool, e.allowed])).toEqual([
      ['gh', 'search_code', true],
      ['gh', 'delete_repo', false],
      ['gh', 'show_env', true],
    ]);
    expect(log[0]!.args_sha256).toBe(
      createHash('sha256')
        .update(JSON.stringify({ q: 'needle' }))
        .digest('hex'),
    );
    const logText = readFileSync(join(runDir, 'mcp.log'), 'utf8');
    expect(logText).not.toContain('needle');
    expect(logText).not.toContain(SECRET);
  });
});

describe('fetchMcpSpec', () => {
  it('fetches the spec with the run token from the scratch folder, for granted servers only', async () => {
    const repo = temp();
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const state = temp();
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(temp(), 'config.yml'),
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_RUN_TOKEN;
    delete env.SWARMUP_ROOTS;
    setSecret(env, 'GH_PAT', SECRET);
    const config = opsdConfig({
      swarmupd: {
        sync: false,
        mcp: {
          servers: {
            gh: { command: 'gh-mcp', env: { GH_TOKEN: { secret: 'GH_PAT' } } },
            docs: { command: 'docs-mcp' },
          },
        },
      },
    } as never);
    const sup = new Supervisor({ env, cwd: repo, user: {}, config, freeMem: () => 64 * 2 ** 30 });
    const api = await startApi(sup, { port: 0, token: 'full-token', version: 't', build: '1' });
    closers.push(async () => {
      await api.close();
      (sup as unknown as { live: Map<string, unknown> }).live.clear();
      await sup.close();
    });
    writeFileSync(join(state, 'opsd.json'), JSON.stringify({ pid: process.pid, port: api.port }));
    const token = 'the-run-token';
    const record: RunRecord = {
      id: 'RUN-MCP',
      agent: 'claude:writer',
      project: 'test',
      pid: 1,
      image: 'fake',
      command: 'fake',
      cwd: repo,
      log: sup.store.logPath('RUN-MCP'),
      started_at: new Date().toISOString(),
      status: 'running',
      budget_minutes: 60,
      tokens: 0,
      token_sha256: createHash('sha256').update(token).digest('hex'),
      mcp: ['gh'],
    };
    sup.store.save(record);
    (sup as unknown as { live: Map<string, { record: RunRecord }> }).live.set(record.id, {
      record,
    });
    const runDir = temp();
    await expect(fetchMcpSpec(runDir, 'gh')).rejects.toThrow(/no MCP token/);
    writeFileSync(join(runDir, 'mcp-token.json'), JSON.stringify({ token, state_dir: state }));
    const spec = await fetchMcpSpec(runDir, 'gh');
    expect(spec).toMatchObject({ name: 'gh', command: 'gh-mcp', env: { GH_TOKEN: SECRET } });
    await expect(fetchMcpSpec(runDir, 'docs')).rejects.toThrow(
      /run RUN-MCP was not granted the MCP server docs/,
    );
    expect(existsSync(join(runDir, 'mcp.log'))).toBe(false);
  });
});
