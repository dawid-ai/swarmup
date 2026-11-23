import { describe, expect, it } from 'vitest';
import { allowedCall, attachmentName } from '../src/allow';

describe('IPC allowlist', () => {
  it('passes the calls the page makes', () => {
    expect(allowedCall('GET', '/api/health')).toBe(true);
    expect(allowedCall('GET', '/api/waits')).toBe(true);
    expect(allowedCall('GET', '/api/usage')).toBe(true);
    expect(allowedCall('POST', '/api/usage')).toBe(false);
    expect(allowedCall('POST', '/api/signin/resume')).toBe(true);
    expect(allowedCall('GET', '/api/signin/resume')).toBe(false);
    expect(allowedCall('POST', '/api/signin/other')).toBe(false);
    expect(allowedCall('GET', '/api/projects')).toBe(true);
    expect(allowedCall('POST', '/api/projects/archive')).toBe(true);
    expect(allowedCall('POST', '/api/projects/unarchive')).toBe(true);
    expect(allowedCall('POST', '/api/projects/label')).toBe(true);
    expect(allowedCall('POST', '/api/projects/remove')).toBe(true);
    // The renderer cannot name a new folder. The main process exposes a system-folder picker.
    expect(allowedCall('POST', '/api/projects/relocate')).toBe(false);
    expect(allowedCall('POST', '/api/projects/other')).toBe(false);
    expect(allowedCall('GET', '/api/runs/01ABC/procs')).toBe(true);
    expect(allowedCall('POST', '/api/runs/01ABC/procs')).toBe(true);
    expect(allowedCall('POST', '/api/waits')).toBe(false);
    expect(allowedCall('GET', '/api/inbox?as=human%3Adawid&markRead=1')).toBe(true);
    expect(allowedCall('GET', '/api/tasks?all')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001')).toBe(true);
    expect(allowedCall('GET', '/api/runs/01ABC/log?tail=262144')).toBe(true);
    expect(allowedCall('POST', '/api/tasks')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/AO-0001/verdict')).toBe(true);
    // The diff of a task's work is read-only (AO-0106).
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001/diff')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/AO-0001/diff')).toBe(false);
    // A review artifact at its commit is read-only too (W8).
    expect(
      allowedCall('GET', '/api/tasks/demo%2FLC-0004/artifact?path=posts%2Fx.md&commit=abc1234'),
    ).toBe(true);
    expect(allowedCall('POST', '/api/tasks/LC-0004/artifact')).toBe(false);
    // A publish task's adapter: read which, and run it (W8 phase 3).
    expect(allowedCall('GET', '/api/tasks/demo%2FLC-0004/publish')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/demo%2FLC-0004/publish')).toBe(true);
    // A milestone's plan (AO-0321): read it, approve it, send it back; progress for the board.
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001/plan')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/plan-approve')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/plan-reject')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/plan')).toBe(false);
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/plan-apply')).toBe(false);
    expect(allowedCall('GET', '/api/milestones')).toBe(true);
    // Done when and the goal brief: change the criteria, run the checks, write a brief.
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/criteria')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/criteria-check')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001/criteria-check')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/criteria-judge')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001/criteria-judge')).toBe(true);
    expect(allowedCall('POST', '/api/tasks/demo%2FAO-0001/brief')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001/brief')).toBe(false);
    expect(allowedCall('GET', '/api/scores?task=demo%2FAO-0001')).toBe(true);
    expect(allowedCall('POST', '/api/milestones')).toBe(false);
    // Settings > Definitions and Benchmarks.
    expect(allowedCall('GET', '/api/defs')).toBe(true);
    expect(allowedCall('POST', '/api/defs/validate')).toBe(true);
    expect(allowedCall('POST', '/api/defs/import')).toBe(true);
    expect(allowedCall('POST', '/api/defs/create')).toBe(true);
    expect(allowedCall('POST', '/api/defs/save')).toBe(true);
    expect(allowedCall('POST', '/api/defs/other')).toBe(false);
    expect(allowedCall('GET', '/api/bench/sets')).toBe(true);
    expect(allowedCall('GET', '/api/bench/runs')).toBe(true);
    expect(allowedCall('GET', '/api/bench/runs/demo-20261121-120000')).toBe(true);
    expect(
      allowedCall('GET', '/api/bench/runs/demo-20261121-120000/attempt?entry=E-1&n=1&file=diff'),
    ).toBe(true);
    expect(allowedCall('POST', '/api/bench/run')).toBe(true);
    expect(allowedCall('POST', '/api/bench/compare')).toBe(true);
    expect(allowedCall('POST', '/api/bench/runs/demo-20261121-120000/stop')).toBe(true);
    expect(allowedCall('POST', '/api/bench/runs/demo-20261121-120000')).toBe(false);
    expect(allowedCall('GET', '/api/bench/run')).toBe(false);
    expect(allowedCall('POST', '/api/runs/01ABC/kill')).toBe(true);
    expect(allowedCall('POST', '/api/decisions/D-0001/vote')).toBe(true);
    // The decision log and a new record (AO-0315).
    expect(allowedCall('GET', '/api/decisions?log&all')).toBe(true);
    expect(allowedCall('GET', '/api/decisions?log&task=r%2FAO-0110')).toBe(true);
    expect(allowedCall('POST', '/api/decisions')).toBe(true);
    expect(allowedCall('POST', '/api/channels/dev')).toBe(true);
  });

  it('passes the project map calls of the Map view and nothing past them', () => {
    expect(allowedCall('GET', '/api/map?root=site')).toBe(true);
    expect(allowedCall('GET', '/api/map/node?root=site&id=core%2Ffold')).toBe(true);
    expect(allowedCall('GET', '/api/map/search?root=site&file=src%2Fa.ts')).toBe(true);
    for (const a of ['check', 'index', 'init']) {
      expect(allowedCall('POST', `/api/map/${a}`)).toBe(true);
      expect(allowedCall('GET', `/api/map/${a}`)).toBe(false);
    }
    expect(allowedCall('POST', '/api/map')).toBe(false);
    expect(allowedCall('GET', '/api/map/node/more')).toBe(false);
  });

  it('passes the settings, schedules, standup and status-change calls', () => {
    expect(allowedCall('GET', '/api/kb?q=git&topic=windows')).toBe(true);
    expect(allowedCall('POST', '/api/kb')).toBe(false);
    expect(allowedCall('GET', '/api/doctor')).toBe(true);
    expect(allowedCall('POST', '/api/doctor/skills')).toBe(true);
    expect(allowedCall('GET', '/api/report?days=30')).toBe(true);
    expect(allowedCall('GET', '/api/scores?task=site%2FT-0002')).toBe(true);
    expect(allowedCall('GET', '/api/scores/history?since=2026-11-01T00%3A00%3A00Z&tz=-60')).toBe(
      true,
    );
    expect(allowedCall('POST', '/api/scores/refresh')).toBe(false);
    expect(allowedCall('POST', '/api/notify/test')).toBe(true);
    expect(allowedCall('GET', '/api/machines')).toBe(true);
    expect(allowedCall('GET', '/api/notify/test')).toBe(false);
    expect(allowedCall('GET', '/api/activity?limit=400')).toBe(true);
    expect(allowedCall('POST', '/api/roots/site/mirror')).toBe(true);
    expect(allowedCall('GET', '/api/roots/site/mirror')).toBe(false);
    expect(allowedCall('POST', '/api/doctor')).toBe(false);
    expect(allowedCall('GET', '/api/kb/git/rebase-first?root=site')).toBe(true);
    expect(allowedCall('GET', '/api/kb/git/rebase-first/more')).toBe(false);
    expect(allowedCall('GET', '/api/kb/promote?days=30')).toBe(true);
    expect(allowedCall('POST', '/api/kb/archive')).toBe(true);
    expect(allowedCall('POST', '/api/kb/promote')).toBe(false);
    for (const a of ['start', 'block', 'review', 'assign', 'retype']) {
      expect(allowedCall('POST', `/api/tasks/AO-0001/${a}`)).toBe(true);
    }
    expect(allowedCall('POST', '/api/channels')).toBe(true);
    expect(allowedCall('GET', '/api/settings')).toBe(true);
    expect(allowedCall('POST', '/api/settings')).toBe(true);
    expect(allowedCall('GET', '/api/schedules')).toBe(true);
    expect(allowedCall('POST', '/api/schedules')).toBe(true);
    expect(allowedCall('POST', '/api/schedules/daily-standup/run')).toBe(true);
    expect(allowedCall('POST', '/api/schedules/daily-standup/delete')).toBe(true);
    expect(allowedCall('POST', '/api/schedules/daily-standup/edit')).toBe(false);
    expect(allowedCall('GET', '/api/standup?hours=24')).toBe(true);
    expect(allowedCall('POST', '/api/standup')).toBe(false);
  });

  it('refuses shutdown, unknown routes and other methods', () => {
    expect(allowedCall('POST', '/api/shutdown')).toBe(false);
    expect(allowedCall('GET', '/api/shutdown')).toBe(false);
    expect(allowedCall('POST', '/api/tasks/AO-0001/delete')).toBe(false);
    expect(allowedCall('POST', '/api/runs')).toBe(true);
    expect(allowedCall('POST', '/api/runs?x=1')).toBe(false);
    expect(allowedCall('GET', '/api/tasks/a/b/c')).toBe(false);
    expect(allowedCall('GET', '/other')).toBe(false);
    expect(allowedCall('DELETE', '/api/tasks')).toBe(false);
    expect(allowedCall('GET', 42)).toBe(false);
  });
});

describe('IPC allowlist: paths the URL parser rewrites', () => {
  it('refuses dot segments, backslashes and stripped characters that reach unlisted routes', () => {
    for (const p of [
      '/api/kb/../shutdown',
      '/api/kb/../events',
      '/api/kb/%2e%2e/shutdown',
      '/api/kb/.%2E/shutdown',
      '/api/tasks/..',
      '/api/tasks/.',
      '/api/runs/x/../../shutdown',
      '/api/tasks/..\\shutdown',
      '/api/kb/.\t./shutdown',
      '/api/kb/.\n./shutdown',
      '/api/tasks/AO 1',
    ]) {
      expect(allowedCall('GET', p), p).toBe(false);
    }
    expect(allowedCall('POST', '/api/runs/../shutdown/kill')).toBe(false);
  });

  it('still passes encoded IDs and dots inside a segment or the query', () => {
    expect(allowedCall('GET', '/api/tasks/demo%2FAO-0001')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/v2.1')).toBe(true);
    expect(allowedCall('GET', '/api/tasks/...')).toBe(true);
    expect(allowedCall('GET', '/api/search?q=..%2Fshutdown')).toBe(true);
    expect(allowedCall('GET', '/api/search?q=../shutdown')).toBe(true);
  });
});

describe('IPC allowlist: roles and the directory', () => {
  it('passes reading the directory and role files, and saving a role', () => {
    expect(allowedCall('GET', '/api/directory')).toBe(true);
    expect(allowedCall('POST', '/api/directory')).toBe(false);
    expect(allowedCall('GET', '/api/roles/claude%3Awriter')).toBe(true);
    expect(allowedCall('POST', '/api/roles')).toBe(true);
    expect(allowedCall('POST', '/api/roles/claude%3Awriter')).toBe(false);
    expect(allowedCall('GET', '/api/roles/claude%3Awriter/more')).toBe(false);
  });
});

describe('IPC allowlist: chat', () => {
  it('passes reading the chat, sending, stopping and starting over', () => {
    expect(allowedCall('GET', '/api/chat')).toBe(true);
    expect(allowedCall('POST', '/api/chat')).toBe(true);
    expect(allowedCall('POST', '/api/chat/stop')).toBe(true);
    expect(allowedCall('POST', '/api/chat/reset')).toBe(true);
    expect(allowedCall('GET', '/api/chat/stop')).toBe(false);
    expect(allowedCall('POST', '/api/chat/delete')).toBe(false);
  });
});

describe('IPC allowlist: search', () => {
  it('passes reading search results only', () => {
    expect(allowedCall('GET', '/api/search?q=tray%20agent%3Acodex&limit=8')).toBe(true);
    expect(allowedCall('POST', '/api/search')).toBe(false);
    expect(allowedCall('GET', '/api/search/x')).toBe(false);
  });

  it('passes image uploads; images load through the swarmup-att scheme, not the bridge', () => {
    expect(allowedCall('POST', '/api/attachments')).toBe(true);
    expect(allowedCall('GET', '/api/attachments')).toBe(false);
    expect(allowedCall('GET', '/api/attachments/01M6J3V01Z93MGX79812GGJG33.png')).toBe(false);
  });
});

describe('attachment URLs', () => {
  const name = '01M6J3V01Z93MGX79812GGJG33.png';
  it('reads the name from an swarmup-att URL', () => {
    expect(attachmentName(`swarmup-att://file/${name}`)).toBe(name);
    expect(attachmentName('swarmup-att://file/01M6J3V01Z93MGX79812GGJG33.webp')).toBe(
      '01M6J3V01Z93MGX79812GGJG33.webp',
    );
  });

  it('refuses every other URL', () => {
    for (const url of [
      `swarmup-att://other/${name}`,
      `swarmup-att://file/${name}?x=1`,
      `swarmup-att://file/${name}#x`,
      `swarmup-att://file/sub/${name}`,
      'swarmup-att://file/..%2Fconfig.yml',
      'swarmup-att://file/../config.yml',
      `swarmup-att://file/${name.toLowerCase()}`,
      'swarmup-att://file/01M6J3V01Z93MGX79812GGJG33.svg',
      `https://example.com/${name}`,
      `file:///C:/${name}`,
      'not a url',
    ]) {
      expect(attachmentName(url), url).toBeNull();
    }
  });
});
