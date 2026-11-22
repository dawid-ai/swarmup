// @vitest-environment happy-dom
// Settings > MCP servers (W8): the servers with their scope and tool rules, add and edit through
// the person-only endpoints, secrets that are set or replaced but never shown, and each agent's
// asked-for and granted servers. Also the routes the page may call.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedCall } from '../src/allow';
import type { McpView } from '../ui/src/types';
import { envText, McpServersPanel, parseEnvText } from '../ui/src/ui/mcp';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const VIEW: McpView = {
  path: 'C:/cfg/config.yml',
  secrets_path: 'C:/cfg/secrets.yml',
  strict: false,
  servers: [
    {
      name: 'gh',
      command: 'npx',
      args: ['-y', 'gh-mcp'],
      env: { GH_TOKEN: { secret: 'GH_PAT', set: true }, LOG: 'info' },
      roots: ['launch'],
      agents: ['claude:researcher'],
      tools: { allow: ['search_*'], deny: ['delete_*'] },
      publish: false,
    },
    {
      name: 'x',
      command: 'x-mcp',
      args: [],
      env: { X_KEY: { secret: 'X_KEY', set: false } },
      roots: [],
      agents: [],
      tools: {},
      publish: true,
    },
  ],
  secrets: ['GH_PAT'],
  agents: [
    {
      id: 'claude:researcher',
      asked: ['gh', 'nope'],
      missing: ['nope'],
      granted: { launch: ['gh'], swarmup: [] },
    },
  ],
};

const posts: Array<{ path: string; body: unknown }> = [];
let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  posts.length = 0;
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: unknown) => {
      if (method === 'POST') posts.push({ path, body });
      return Promise.resolve({ ok: true, data: VIEW });
    },
    info: () => Promise.resolve({ me: 'human:dawid', pid: 1, roots: [] }),
    onService: off,
    onEvent: off,
    onStatus: off,
    onNavigate: off,
  } as unknown as NonNullable<Window['swarmup']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  document.body.innerHTML = '';
  delete window.swarmup;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(createElement(McpServersPanel)));
  await settle();
  await settle();
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(scope: Element, label: string): HTMLButtonElement {
  const b = [...scope.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no ${label} button`);
  return b;
}

describe('Settings > MCP servers', () => {
  it('lists each server with its scope, tool rules and whether its secrets are set', async () => {
    await mount();
    const gh = box.querySelector('[data-mcp-server="gh"]')!;
    expect(gh.textContent).toContain('npx -y gh-mcp');
    expect(gh.querySelector('[data-mcp-scope]')!.textContent).toBe(
      'Projects: launch · Agents: claude:researcher',
    );
    expect(gh.querySelector('[data-mcp-tools]')!.textContent).toBe(
      'Tools allowed: search_* · Tools denied: delete_*',
    );
    expect(gh.textContent).toContain('GH_TOKEN from secret GH_PAT: set');
    const x = box.querySelector('[data-mcp-server="x"]')!;
    expect(x.textContent).toContain('publish only');
    expect(x.querySelector('[data-mcp-scope]')!.textContent).toBe('Never granted to a role');
  });

  it('shows each agent its asked-for and granted servers', async () => {
    await mount();
    const a = box.querySelector('[data-mcp-agent="claude:researcher"]')!;
    expect(a.textContent).toContain('Asked for: gh, nope');
    expect(a.querySelector('[data-mcp-missing]')!.textContent).toContain('Not defined here: nope');
    expect(a.querySelector('[data-mcp-granted="launch"]')!.textContent).toBe(
      'Granted in launch: gh',
    );
    expect(a.querySelector('[data-mcp-granted="swarmup"]')!.textContent).toBe(
      'Granted in swarmup: none',
    );
  });

  it('adds a server with its scope, tool rules and secret references', async () => {
    await mount();
    await click(button(box, 'Add server'));
    const form = box.querySelector('[data-mcp-form]')!;
    const inputs = [...form.querySelectorAll('input')];
    type(inputs[0]!, 'docs');
    type(inputs[1]!, 'docs-mcp');
    type(inputs[2]!, '--port 0');
    type(form.querySelector('textarea')!, 'KEY=secret:DOCS_KEY\nMODE=read');
    type(inputs[3]!, 'launch');
    type(inputs[4]!, '*:writer, claude:pm');
    type(inputs[6]!, 'delete_*');
    await click(button(form, 'Add server'));
    expect(posts).toEqual([
      {
        path: '/api/mcp/servers',
        body: {
          name: 'docs',
          server: {
            command: 'docs-mcp',
            args: ['--port', '0'],
            env: { KEY: { secret: 'DOCS_KEY' }, MODE: 'read' },
            roots: ['launch'],
            agents: ['*:writer', 'claude:pm'],
            tools: { allow: [], deny: ['delete_*'] },
            publish: false,
          },
        },
      },
    ]);
  });

  it('edits a server under its old name and removes one', async () => {
    await mount();
    await click(button(box.querySelector('[data-mcp-server="gh"]')!, 'Edit'));
    const form = box.querySelector('[data-mcp-form]')!;
    expect(form.querySelector('textarea')!.value).toBe('GH_TOKEN=secret:GH_PAT\nLOG=info');
    await click(button(form, 'Save server'));
    expect(posts[0]).toMatchObject({
      path: '/api/mcp/servers',
      body: { name: 'gh', previous: 'gh', server: { env: { GH_TOKEN: { secret: 'GH_PAT' } } } },
    });
    await click(button(box.querySelector('[data-mcp-server="x"]')!, 'Remove'));
    expect(posts[1]).toEqual({ path: '/api/mcp/servers/x/delete', body: undefined });
  });

  it('sets and replaces secrets without ever showing a value', async () => {
    await mount();
    const gh = box.querySelector('[data-mcp-secret="GH_PAT"]')!;
    const xKey = box.querySelector('[data-mcp-secret="X_KEY"]')!;
    expect(gh.textContent).toContain('set');
    expect(xKey.textContent).toContain('not set');
    const field = gh.querySelector('input')!;
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    type(field, 'ghp_new_value');
    await click(button(gh, 'Replace'));
    expect(posts).toEqual([
      { path: '/api/mcp/secrets', body: { name: 'GH_PAT', value: 'ghp_new_value' } },
    ]);
    // The field is cleared once saved, and the page never renders a value.
    expect(box.querySelector<HTMLInputElement>('[data-mcp-secret="GH_PAT"] input')!.value).toBe('');
    expect(box.innerHTML).not.toContain('ghp_new_value');
    await click(button(box.querySelector('[data-mcp-secret="GH_PAT"]')!, 'Remove'));
    expect(posts[1]).toEqual({ path: '/api/mcp/secrets', body: { name: 'GH_PAT', value: null } });
    expect(button(xKey, 'Set').disabled).toBe(true);
  });

  it('reads and writes the environment text', () => {
    expect(envText(VIEW.servers[0]!.env)).toBe('GH_TOKEN=secret:GH_PAT\nLOG=info');
    expect(parseEnvText('A=1\n\nB=secret:B_KEY')).toEqual({
      env: { A: '1', B: { secret: 'B_KEY' } },
    });
    expect(parseEnvText('no equals')).toEqual({
      error: 'Line 1: write NAME=value or NAME=secret:KEY',
    });
  });

  it('lets the page call the settings routes but never resolve', () => {
    expect(allowedCall('GET', '/api/mcp')).toBe(true);
    expect(allowedCall('POST', '/api/mcp/servers')).toBe(true);
    expect(allowedCall('POST', '/api/mcp/secrets')).toBe(true);
    expect(allowedCall('POST', '/api/mcp/strict')).toBe(true);
    expect(allowedCall('POST', '/api/mcp/servers/gh/delete')).toBe(true);
    expect(allowedCall('POST', '/api/mcp/resolve')).toBe(false);
    expect(allowedCall('POST', '/api/tasks/LC-0010/published')).toBe(true);
  });
});
