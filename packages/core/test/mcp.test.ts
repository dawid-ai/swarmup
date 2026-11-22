import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentDef, McpConfig } from '../src/index.js';
import {
  agentMatches,
  checkMcpConfig,
  mcpArgsHash,
  mcpGrant,
  mcpPromptNote,
  mcpToolAllowed,
  readSecrets,
  resolveMcpEnv,
  secretNames,
  secretsExposure,
  secretsPath,
  setSecret,
  validateDefinitions,
} from '../src/index.js';
import { tempDir } from './helpers.js';

// MCP servers on roles (W8): the machine's server config, the grant a run gets, tool rules,
// secrets.yml, and the validate warning for names the machine does not define.

const CFG: McpConfig = checkMcpConfig({
  servers: {
    docs: { command: 'docs-mcp' },
    gh: {
      command: 'npx',
      args: ['-y', 'gh-mcp'],
      env: { GH_TOKEN: { secret: 'GH_PAT' }, LOG: 'info' },
      roots: ['launch'],
      agents: ['claude:researcher', '*:editor'],
      tools: { allow: ['search_*', 'get_file'], deny: ['search_secrets'] },
    },
    x: { command: 'x-mcp', publish: true },
  },
});

describe('swarmupd.mcp', () => {
  it('reads servers and refuses bad entries with the key path', () => {
    expect(checkMcpConfig(undefined)).toEqual({ strict: false, servers: {} });
    expect(CFG.servers.gh).toMatchObject({
      command: 'npx',
      env: { GH_TOKEN: { secret: 'GH_PAT' }, LOG: 'info' },
      roots: ['launch'],
    });
    expect(CFG.servers.x!.publish).toBe(true);
    expect(() => checkMcpConfig({ servers: { gh: {} } })).toThrow(
      /swarmupd\.mcp\.servers\.gh\.command/,
    );
    expect(() => checkMcpConfig({ servers: { GH: { command: 'x' } } })).toThrow(/lowercase/);
    expect(() =>
      checkMcpConfig({ servers: { gh: { command: 'x', env: { T: { value: 'y' } } } } }),
    ).toThrow(/env\.T: use text or \{secret: NAME\}/);
    expect(() =>
      checkMcpConfig({ servers: { gh: { command: 'x', tools: { only: [] } } } }),
    ).toThrow(/unknown key only/);
    expect(() => checkMcpConfig({ strict: 'yes' })).toThrow(/strict/);
    expect(() => checkMcpConfig({ servers: { gh: { command: 'x', port: 1 } } })).toThrow(
      /unknown key port/,
    );
  });
});

describe('the grant of a run', () => {
  it('is the intersection of the role file and what the machine defines and grants', () => {
    const g = mcpGrant(CFG, ['docs', 'gh', 'nope', 'docs'], {
      agent: 'claude:researcher',
      root: 'launch',
    });
    expect(g).toEqual({ granted: ['docs', 'gh'], missing: ['nope'], withheld: [] });
    expect(mcpGrant(CFG, undefined, { agent: 'claude:researcher' })).toEqual({
      granted: [],
      missing: [],
      withheld: [],
    });
  });

  it('scopes a server by root and by agent', () => {
    const other = mcpGrant(CFG, ['gh'], { agent: 'claude:researcher', root: 'swarmup' });
    expect(other.granted).toEqual([]);
    expect(other.withheld).toEqual([{ name: 'gh', why: 'it is not granted to swarmup' }]);
    // A run with no task has no root: only servers that name no roots.
    expect(mcpGrant(CFG, ['gh', 'docs'], { agent: 'claude:researcher' }).granted).toEqual(['docs']);
    expect(mcpGrant(CFG, ['gh'], { agent: 'codex:editor', root: 'launch' }).granted).toEqual([
      'gh',
    ]);
    const writer = mcpGrant(CFG, ['gh'], { agent: 'claude:writer', root: 'launch' });
    expect(writer.withheld).toEqual([{ name: 'gh', why: 'it is not granted to claude:writer' }]);
    expect(agentMatches('writer', 'claude:writer')).toBe(true);
    expect(agentMatches('claude:*', 'claude:writer')).toBe(true);
    expect(agentMatches('codex:*', 'claude:writer')).toBe(false);
    expect(agentMatches('*', 'codex:editor')).toBe(true);
  });

  it('never grants a publish server to a role', () => {
    const g = mcpGrant(CFG, ['x'], { agent: 'claude:writer', root: 'launch' });
    expect(g.granted).toEqual([]);
    expect(g.withheld[0]).toMatchObject({ name: 'x', why: expect.stringMatching(/publish/) });
  });

  it('tells the run which servers it asked for and does not have', () => {
    const note = mcpPromptNote(
      mcpGrant(CFG, ['nope', 'x'], { agent: 'claude:writer', root: 'launch' }),
    );
    expect(note).toContain('nope: this machine does not define it');
    expect(note).toContain('x: it is a publish server');
    expect(mcpPromptNote({ granted: ['docs'], missing: [], withheld: [] })).toBe('');
  });
});

describe('tool rules', () => {
  it('allows listed tools, denies denied ones, and allows all with no rules', () => {
    const rules = CFG.servers.gh!.tools;
    expect(mcpToolAllowed(rules, 'search_code')).toBe(true);
    expect(mcpToolAllowed(rules, 'get_file')).toBe(true);
    expect(mcpToolAllowed(rules, 'search_secrets')).toBe(false);
    expect(mcpToolAllowed(rules, 'delete_repo')).toBe(false);
    expect(mcpToolAllowed(undefined, 'anything')).toBe(true);
    expect(mcpToolAllowed({ deny: ['push*'] }, 'push_files')).toBe(false);
    expect(mcpArgsHash({ q: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(mcpArgsHash({ q: 1 })).not.toBe(mcpArgsHash({ q: 2 }));
  });
});

describe('secrets.yml', () => {
  function env(): NodeJS.ProcessEnv {
    return { ...process.env, SWARMUP_CONFIG: join(tempDir(), 'config.yml') };
  }

  it('lives next to the user config, sets, replaces and removes values', () => {
    const e = env();
    expect(secretsPath(e)).toBe(join(e.SWARMUP_CONFIG!, '..', 'secrets.yml'));
    expect(readSecrets(e)).toEqual({});
    setSecret(e, 'GH_PAT', 'ghp_first');
    setSecret(e, 'GH_PAT', 'ghp_second');
    setSecret(e, 'OTHER', 'x');
    expect(readSecrets(e)).toEqual({ GH_PAT: 'ghp_second', OTHER: 'x' });
    expect(secretNames(e)).toEqual(['GH_PAT', 'OTHER']);
    setSecret(e, 'OTHER', null);
    expect(secretNames(e)).toEqual(['GH_PAT']);
    expect(readFileSync(secretsPath(e), 'utf8')).toContain('Keep this file out of every repo');
    expect(() => setSecret(e, '1BAD', 'x')).toThrow(/secret name/);
    expect(() => setSecret(e, 'OK', 'two\nlines')).toThrow(/one line/);
  });

  it('fills {secret: NAME} values and names the ones not set', () => {
    const server = CFG.servers.gh!;
    expect(resolveMcpEnv(server, { GH_PAT: 'ghp_x' })).toEqual({
      env: { GH_TOKEN: 'ghp_x', LOG: 'info' },
      missing: [],
    });
    expect(resolveMcpEnv(server, {})).toEqual({ env: { LOG: 'info' }, missing: ['GH_PAT'] });
  });

  it('says when the file is readable by others, where the system can tell', () => {
    const e = env();
    setSecret(e, 'GH_PAT', 'ghp_x');
    expect(secretsExposure(e, 'win32')).toBeNull();
    if (process.platform === 'win32') return;
    expect(secretsExposure(e)).toBeNull();
    chmodSync(secretsPath(e), 0o644);
    expect(secretsExposure(e)).toMatch(/readable by other users \(mode 644\)/);
  });

  it('refuses a file that is not YAML without quoting it', () => {
    const e = env();
    writeFileSync(secretsPath(e), 'GH_PAT: [ghp_leaky');
    expect(() => readSecrets(e)).toThrow(/is not valid YAML/);
    try {
      readSecrets(e);
    } catch (err) {
      expect((err as Error).message).not.toContain('ghp_leaky');
    }
  });
});

describe('swarmup validate', () => {
  it('warns about role mcp names the machine does not define', () => {
    const agent = (id: string, mcp: string[]): AgentDef => ({
      id,
      status: 'active',
      mcp,
      file: `/store/agents/${id.replace(':', '-')}.md`,
      body: '',
    });
    const problems = validateDefinitions({
      root: '/store',
      swarm: null,
      agents: [agent('claude:writer', ['docs', 'gh']), agent('claude:pm', ['docs'])],
      agentValues: new Map(),
      texts: new Map(),
      machineMcp: ['docs'],
    });
    expect(problems).toEqual([
      expect.objectContaining({
        file: '/store/agents/claude-writer.md',
        path: 'mcp',
        severity: 'warning',
        message: expect.stringMatching(
          /defines no MCP server gh; add it in Settings > MCP servers/,
        ),
      }),
    ]);
    // Without the machine's servers (no user config), nothing to check against.
    expect(
      validateDefinitions({
        root: '/store',
        swarm: null,
        agents: [agent('claude:writer', ['gh'])],
        agentValues: new Map(),
        texts: new Map(),
      }),
    ).toEqual([]);
  });
});
