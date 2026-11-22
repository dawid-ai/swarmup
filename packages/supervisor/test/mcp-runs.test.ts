import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '@swarmup/core';
import { checkMcpConfig, setSecret } from '@swarmup/core';
import type { McpProxyEntry, RuntimeConfig } from '../src/index.js';
import {
  codexMcpArgs,
  invocation,
  mcpChecks,
  mcpProxyEntries,
  opsdConfig,
  startApi,
  tomlString,
} from '../src/index.js';
import { prepareMcpRun } from '../src/mcp-api.js';
import { resumeInvocation } from '../src/resume.js';
import { FAKE_AGENT, setup, temp } from './supervisor-setup.js';
import { until } from './until.js';

// MCP servers on roles (W8): the runtime flags for granted servers, the run record and prompt,
// the resolve endpoint that only a granted run may call, and the settings that never return a
// secret value.

const SECRET = 'run-test-secret-value-7781';

const ENTRIES: McpProxyEntry[] = mcpProxyEntries(['docs', 'gh'], 'C:\\state\\scratch\\R1', {
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\app\\swarmup.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
});

describe('runtime flags for granted servers', () => {
  it('gives Claude the config file, --strict-mcp-config and an allow rule per server', () => {
    const rc: RuntimeConfig = { command: 'claude' };
    const { args } = invocation(
      rc,
      'claude:writer',
      undefined,
      '/w',
      [],
      [],
      undefined,
      false,
      false,
      [],
      [],
      '/s',
      false,
      { entries: ENTRIES, configFile: 'C:\\state\\scratch\\R1\\mcp.json' },
    );
    const at = args.indexOf('--mcp-config');
    expect(args.slice(at, at + 3)).toEqual([
      '--mcp-config',
      'C:\\state\\scratch\\R1\\mcp.json',
      '--strict-mcp-config',
    ]);
    const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed).toEqual(expect.arrayContaining(['mcp__docs', 'mcp__gh']));
    // Resuming keeps the servers: the flags stay, `--resume` goes after `-p`.
    const resumed = resumeInvocation({ args, unsetEnv: [] }, 'claude', 'sess-1')!;
    expect(resumed.args).toContain('--mcp-config');
    expect(resumed.args.slice(0, 3)).toEqual(['-p', '--resume', 'sess-1']);
  });

  it('gives a Claude run without servers --strict-mcp-config alone when mcp.strict is on', () => {
    const rc: RuntimeConfig = { command: 'claude' };
    const plain = invocation(rc, 'claude:writer', undefined, '/w', []).args;
    expect(plain.join(' ')).not.toContain('mcp');
    const strict = invocation(
      rc,
      'claude:writer',
      undefined,
      '/w',
      [],
      [],
      undefined,
      false,
      false,
      [],
      [],
      undefined,
      false,
      { entries: [], strict: true },
    ).args;
    expect(strict).toContain('--strict-mcp-config');
    expect(strict).not.toContain('--mcp-config');
  });

  it('gives Codex -c mcp_servers overrides as TOML literal strings, also when it resumes', () => {
    expect(codexMcpArgs(ENTRIES.slice(0, 1))).toEqual([
      '-c',
      "mcp_servers.docs.command='C:\\Program Files\\nodejs\\node.exe'",
      '-c',
      "mcp_servers.docs.args=['C:\\app\\swarmup.mjs','mcp','exec','docs','--run-dir','C:\\state\\scratch\\R1']",
      '-c',
      "mcp_servers.docs.env={ELECTRON_RUN_AS_NODE='1'}",
    ]);
    expect(tomlString("it's")).toBe('"it\'s"');
    const rc: RuntimeConfig = { command: 'codex' };
    const inv = invocation(
      rc,
      'codex:editor',
      undefined,
      '/w',
      [],
      [],
      undefined,
      false,
      false,
      [],
      [],
      undefined,
      true,
      { entries: ENTRIES },
    );
    const json = inv.args.indexOf('--json');
    expect(inv.args.slice(1, json)).toEqual(codexMcpArgs(ENTRIES));
    // `codex exec resume` takes -c (0.167), so a resumed run keeps its servers.
    const resumed = resumeInvocation(inv, 'codex', 'thread-1')!;
    expect(resumed.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resumed.args.join('\n')).toContain('mcp_servers.gh.command=');
  });

  it('gives a runtime that is not Claude or Codex no servers, and its prompt says so', () => {
    const scratch = temp();
    const setupRun = prepareMcpRun({
      cfg: checkMcpConfig({ servers: { docs: { command: 'docs-mcp' } } }),
      asked: ['docs'],
      agent: 'hermes:writer',
      runtime: 'hermes',
      scratch,
      token: 'tok',
      stateDir: scratch,
      env: process.env,
    });
    expect(setupRun.grant.granted).toEqual([]);
    expect(setupRun.inv).toBeUndefined();
    expect(setupRun.note).toContain('Claude and Codex runs only, not hermes');
    expect(existsSync(join(scratch, 'mcp-token.json'))).toBe(false);
  });
});

/** A swarmupd with an API, a role file asking for three servers and a secret set. */
async function mcpSetup() {
  const config = join(temp(), 'config.yml');
  writeFileSync(config, 'me: human:dawid\n');
  const env = { SWARMUP_CONFIG: config };
  setSecret({ ...process.env, ...env }, 'GH_PAT', SECRET);
  const agentFile = join(temp(), 'fake-claude.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
  const promptFile = join(temp(), 'prompt.txt');
  const ctx = setup({
    mode: 'idle',
    env: { ...env, FAKE_PROMPT: promptFile },
    opsd: {
      runtimes: { claude: { command: process.execPath, args: [agentFile] } },
      mcp: {
        servers: {
          gh: {
            command: process.execPath,
            args: ['-e', 'process.stdin.resume()'],
            env: { GH_TOKEN: { secret: 'GH_PAT' }, LOG: 'info' },
            roots: ['test'],
            agents: ['claude:writer'],
            tools: { deny: ['delete_*'] },
          },
          x: { command: 'x-mcp', publish: true },
          other: { command: 'other-mcp', agents: ['claude:pm'] },
        },
      },
    },
  });
  const agents = join(ctx.repo, '.swarmup', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, 'claude-writer.md'),
    '---\nid: claude:writer\nstatus: active\nmcp: [gh, x, other, nope]\n---\nWrites.\n',
  );
  const api = await startApi(ctx.sup, { port: 0, token: 'full-token', version: 't', build: '1' });
  const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  return { ...ctx, api, call, promptFile, env: { ...process.env, ...env } };
}

describe('a run with MCP servers', () => {
  it('records the granted names, writes the proxy files and puts no secret anywhere', async () => {
    const { sup, as, api, call, promptFile } = await mcpSetup();
    try {
      as('human:dawid').newTask({ title: 'research', owner: 'claude:writer' });
      const run = await sup.launchFresh({ agent: 'claude:writer', task: 'T-0001' });
      expect(run.mcp).toEqual(['gh']);
      expect(run.command).toContain('--mcp-config');
      expect(run.command).toContain('mcp__gh');
      const mcpJson = readFileSync(join(run.scratch!, 'mcp.json'), 'utf8');
      const servers = (JSON.parse(mcpJson) as { mcpServers: Record<string, { args: string[] }> })
        .mcpServers;
      expect(Object.keys(servers)).toEqual(['gh']);
      expect(servers.gh!.args.slice(-5)).toEqual(['mcp', 'exec', 'gh', '--run-dir', run.scratch]);
      const token = JSON.parse(readFileSync(join(run.scratch!, 'mcp-token.json'), 'utf8')) as {
        token: string;
      };
      for (const text of [run.command, JSON.stringify(sup.store.get(run.id)), mcpJson]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(token.token);
      }
      await until(() => existsSync(promptFile) && readFileSync(promptFile, 'utf8').length > 0);
      const prompt = readFileSync(promptFile, 'utf8');
      expect(prompt).toContain('nope: this machine does not define it');
      expect(prompt).toContain('x: it is a publish server');
      expect(prompt).toContain('other: it is not granted to claude:writer');
      expect(prompt).not.toContain(SECRET);

      // Only the run's token resolves, and only for a server it was granted.
      const ok = await call(token.token, 'POST', '/api/mcp/resolve', { name: 'gh' });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({
        name: 'gh',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        env: { GH_TOKEN: SECRET, LOG: 'info' },
        tools: { deny: ['delete_*'] },
      });
      const notGranted = await call(token.token, 'POST', '/api/mcp/resolve', { name: 'x' });
      expect(notGranted.status).toBe(403);
      expect(notGranted.text).not.toContain('x-mcp');
      const person = await call('full-token', 'POST', '/api/mcp/resolve', { name: 'gh' });
      expect(person.status).toBe(403);
      expect(person.text).not.toContain(SECRET);
      // A run cannot read or change MCP settings.
      expect((await call(token.token, 'GET', '/api/mcp')).status).toBe(403);
      expect(
        (await call(token.token, 'POST', '/api/mcp/secrets', { name: 'GH_PAT', value: 'x' }))
          .status,
      ).toBe(403);
    } finally {
      await api.close();
    }
  });

  it('never returns a secret value from settings, and sets secrets write-only', async () => {
    const { call, api, env } = await mcpSetup();
    try {
      const view = await call('full-token', 'GET', '/api/mcp');
      expect(view.status).toBe(200);
      expect(view.text).not.toContain(SECRET);
      const data = JSON.parse(view.text) as {
        servers: Array<{ name: string; env: Record<string, unknown>; publish: boolean }>;
        secrets: string[];
        agents: Array<{ id: string; asked: string[]; missing: string[]; granted: object }>;
      };
      expect(data.secrets).toEqual(['GH_PAT']);
      expect(data.servers.find((s) => s.name === 'gh')!.env).toEqual({
        GH_TOKEN: { secret: 'GH_PAT', set: true },
        LOG: 'info',
      });
      expect(data.agents).toEqual([
        {
          id: 'claude:writer',
          asked: ['gh', 'x', 'other', 'nope'],
          missing: ['nope'],
          granted: { test: ['gh'] },
        },
      ]);
      for (const path of ['/api/settings', '/api/doctor']) {
        expect((await call('full-token', 'GET', path)).text).not.toContain(SECRET);
      }
      const replaced = await call('full-token', 'POST', '/api/mcp/secrets', {
        name: 'GH_PAT',
        value: 'replaced-test-secret-value-2290',
      });
      expect(replaced.status).toBe(200);
      expect(replaced.text).not.toContain('replaced-test-secret');
      expect(readFileSync(join(env.SWARMUP_CONFIG!, '..', 'secrets.yml'), 'utf8')).toContain(
        'replaced-test-secret-value',
      );

      // Add, rename and remove a server in the machine config.
      const added = await call('full-token', 'POST', '/api/mcp/servers', {
        name: 'docs',
        server: { command: 'docs-mcp', env: { KEY: { secret: 'DOCS_KEY' } }, roots: ['test'] },
      });
      expect(added.status).toBe(200);
      const config = readFileSync(env.SWARMUP_CONFIG!, 'utf8');
      expect(config).toContain('docs:');
      expect(config).toContain('secret: DOCS_KEY');
      const renamed = await call('full-token', 'POST', '/api/mcp/servers', {
        name: 'docs2',
        previous: 'docs',
        server: { command: 'docs-mcp' },
      });
      expect(JSON.parse(renamed.text).servers.map((s: { name: string }) => s.name)).toContain(
        'docs2',
      );
      const bad = await call('full-token', 'POST', '/api/mcp/servers', {
        name: 'Bad Name',
        server: { command: 'x' },
      });
      expect(bad.status).toBe(400);
      const gone = await call('full-token', 'POST', '/api/mcp/servers/docs2/delete');
      expect(JSON.parse(gone.text).servers.map((s: { name: string }) => s.name)).not.toContain(
        'docs2',
      );
    } finally {
      await api.close();
    }
  });
});

describe('doctor', () => {
  it('warns about unset secrets and role mcp names the machine does not define', () => {
    const env = { ...process.env, SWARMUP_CONFIG: join(temp(), 'config.yml') };
    const cfg = opsdConfig({
      swarmupd: {
        mcp: { servers: { gh: { command: 'gh-mcp', env: { T: { secret: 'GH_PAT' } } } } },
      },
    } as never);
    const ws = {
      agents: () => [
        { id: 'claude:writer', mcp: ['gh', 'nope'] },
        { id: 'claude:pm', mcp: ['nope'] },
      ],
    } as unknown as Workspace;
    const checks = mcpChecks(env, cfg, ws, 'win32');
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['mcp:gh', 'warn'],
      ['mcp-missing:nope', 'warn'],
    ]);
    expect(checks[1]!.detail).toContain('claude:writer, claude:pm ask for nope');
    setSecret(env, 'GH_PAT', SECRET);
    const after = mcpChecks(env, cfg, ws, 'win32');
    expect(after.map((c) => c.id)).toEqual(['mcp-missing:nope']);
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });
});
