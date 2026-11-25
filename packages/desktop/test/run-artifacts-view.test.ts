// @vitest-environment happy-dom
// Run artifacts in the app (W4): the Runs view's run detail shows the files a run kept, images as
// a gallery and other files as a list, and the task panel's Work section shows the files a run
// kept that its review names. Every kept file has Download, which the main process saves.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageRuns } from '../../supervisor/src/runs';
import { artifactPath, artifactRequest } from '../src/artifact-save';
import type { Nav } from '../ui/src/App';
import type { OpsEvent, RunArtifactView, RunRecord } from '../ui/src/types';
import { WorkSection } from '../ui/src/ui/work';
import { Runs } from '../ui/src/views/Runs';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const RUN = '01RUNARTIFACTS0000000000AB';
const answers = new Map<string, unknown>();
const gets: string[] = [];
/** The files Download asked the main process to save, and what it answers. */
let saved: Array<[string, string]> = [];
let saveAnswer: { ok: boolean; data?: { file: string }; error?: string } = {
  ok: true,
  data: { file: 'D:/Downloads/x' },
};
let runs: RunRecord[] = [];
let root: Root | undefined;
let box: HTMLDivElement;

const view = (name: string): string => `/api/runs/${RUN}/artifacts/${name}?view=1`;

const IMAGE: RunArtifactView = {
  name: 'home.png',
  label: 'Home page',
  type: 'image/png',
  bytes: 8,
  sha256: 'a'.repeat(64),
  kind: 'image',
  data: 'data:image/png;base64,iVBORw0KGgo=',
  file: 'C:/state/artifacts/R/home.png',
};
const TEXT: RunArtifactView = {
  name: 'report.txt',
  type: 'text/plain',
  bytes: 9,
  sha256: 'b'.repeat(64),
  kind: 'text',
  text: 'all green',
  file: 'C:/state/artifacts/R/report.txt',
};
const PDF: RunArtifactView = {
  name: 'summary.pdf',
  type: 'application/pdf',
  bytes: 2048,
  sha256: 'c'.repeat(64),
  kind: 'file',
  file: 'C:/state/artifacts/R/summary.pdf',
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  gets.length = 0;
  saved = [];
  saveAnswer = { ok: true, data: { file: 'D:/Downloads/x' } };
  answers.set(view('home.png'), IMAGE);
  answers.set(view('report.txt'), TEXT);
  answers.set(view('summary.pdf'), PDF);
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string) => {
      gets.push(path);
      if (path.startsWith('/api/runs?')) {
        const p = new URL(path, 'http://swarmupd').searchParams;
        const data = pageRuns(runs as never, {
          limit: Number(p.get('limit')),
          pick: p.get('pick') ?? undefined,
        });
        return Promise.resolve({ ok: true, data });
      }
      if (path.includes('/log')) return Promise.resolve({ ok: true, data: '' });
      return Promise.resolve({ ok: true, data: answers.get(path) ?? [] });
    },
    saveArtifact: (run: string, name: string) => {
      saved.push([run, name]);
      return Promise.resolve(saveAnswer);
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
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
  await settle();
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const KEPT = [
  { name: 'home.png', label: 'Home page', bytes: 8, type: 'image/png' },
  { name: 'report.txt', bytes: 9, type: 'text/plain' },
  { name: 'summary.pdf', bytes: 2048, type: 'application/pdf' },
];

function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN,
    agent: 'claude:engineer',
    pid: 1,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: new Date(Date.now() - 1000).toISOString(),
    status: 'ended',
    reason: 'exit',
    exit: 0,
    budget_minutes: 60,
    tokens: 10,
    task: 'T-0001',
    root: 'C:/ops',
    artifacts: KEPT,
    ...patch,
  } as RunRecord;
}

const artifactsButton = (): HTMLButtonElement | undefined =>
  [...box.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Artifacts'));

describe('the Runs view', () => {
  it("shows a run's kept images as a gallery and its other files as a list", async () => {
    runs = [run()];
    const nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
    await mount(createElement(Runs, { nav, selected: RUN }));
    expect(artifactsButton()?.textContent).toBe('Artifacts3');
    expect(box.querySelector('[data-run-artifacts-panel]')).toBeNull();
    await click(artifactsButton());
    const panel = box.querySelector('[data-run-artifacts-panel]')!;
    expect(panel.textContent).toContain('3 kept with the run');
    const img = panel.querySelector<HTMLImageElement>('[data-run-gallery] img')!;
    expect(img.getAttribute('src')).toBe(IMAGE.data);
    expect(img.getAttribute('alt')).toBe('Home page');
    const files = [...panel.querySelectorAll('[data-run-files] [data-run-artifact]')];
    expect(files.map((f) => f.getAttribute('data-run-artifact'))).toEqual([
      'report.txt',
      'summary.pdf',
    ]);
    // Files open on a click: text as text, others with Download.
    expect(gets).not.toContain(view('report.txt'));
    await click(files[0]!.querySelector('button'));
    expect(files[0]!.querySelector('[data-run-artifact-text]')?.textContent).toBe('all green');
    await click(files[1]!.querySelector('button'));
    const other = files[1]!.querySelector('[data-run-artifact-file]')!;
    expect(other.textContent).toContain('Download it to open it');
    expect(other.textContent).not.toContain(PDF.file);
    expect(other.querySelector('button')?.textContent).toBe('Download');
  });

  it('offers Download on every kept file and saves it through the main process', async () => {
    runs = [run()];
    const nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
    await mount(createElement(Runs, { nav, selected: RUN }));
    await click(artifactsButton());
    const panel = box.querySelector('[data-run-artifacts-panel]')!;
    const downloads = [...panel.querySelectorAll('[data-run-artifact-download]')];
    expect(downloads.map((b) => b.getAttribute('data-run-artifact-download'))).toEqual([
      'home.png',
      'report.txt',
      'summary.pdf',
    ]);
    // Download sits beside the row's toggle, so it saves without opening the row.
    await click(panel.querySelector('[data-run-artifact-download="summary.pdf"]'));
    expect(saved).toEqual([[RUN, 'summary.pdf']]);
    expect(panel.querySelector('[data-run-artifact-file]')).toBeNull();
    await click(panel.querySelector('[data-run-artifact-download="home.png"]'));
    expect(saved).toEqual([
      [RUN, 'summary.pdf'],
      [RUN, 'home.png'],
    ]);
    // A closed save dialog is no error.
    saveAnswer = { ok: false, error: 'cancelled' };
    await click(panel.querySelector('[data-run-artifact-download="report.txt"]'));
    expect(saved).toHaveLength(3);
  });

  it('shows no Artifacts button for a run that kept nothing', async () => {
    runs = [run({ artifacts: undefined })];
    const nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
    await mount(createElement(Runs, { nav, selected: RUN }));
    expect(box.textContent).toContain('Processes');
    expect(artifactsButton()).toBeUndefined();
  });
});

describe('the Work section', () => {
  it('shows the files a run kept that the review names, next to the review artifacts', async () => {
    const review: OpsEvent = {
      id: '01REVIEW',
      type: 'review',
      actor: 'claude:engineer',
      at: '2026-11-22T09:00:00Z',
      artifacts: [
        { kind: 'url', ref: 'https://example.com/preview' },
        ...KEPT.map((a) => ({ kind: 'run' as const, ref: a.name, run: RUN, ...a })),
      ],
      body: 'T-0001: done',
    } as OpsEvent;
    await mount(createElement(WorkSection, { task: 'ops/T-0001', events: [review] }));
    const kept = box.querySelector(`[data-work-run="${RUN}"]`)!;
    expect(kept.textContent).toContain(`Kept by run ${RUN.slice(-8)}`);
    expect(kept.querySelector('img')?.getAttribute('src')).toBe(IMAGE.data);
    // The review's other artifacts stay rows of their own.
    expect(box.querySelector('[data-artifact="https://example.com/preview"]')).toBeTruthy();
    expect(box.querySelector('[data-artifact="home.png"]')).toBeNull();
  });
});

describe('the download request', () => {
  it('takes a run id and a one-segment kept name, and nothing that leaves the route', () => {
    expect(artifactPath(artifactRequest(RUN, 'summary.pdf'))).toBe(
      `/api/runs/${RUN}/artifacts/summary.pdf`,
    );
    expect(artifactPath(artifactRequest(RUN, 'home page.png'))).toBe(
      `/api/runs/${RUN}/artifacts/home%20page.png`,
    );
    for (const name of ['..', '.', '../x.txt', 'a/b.txt', 'a\b.txt', '.hidden', 'x.', '', 7]) {
      expect(() => artifactRequest(RUN, name)).toThrow(/bad artifact name/);
    }
    for (const run of ['../runs', 'R/1', '', null]) {
      expect(() => artifactRequest(run, 'x.txt')).toThrow(/bad run id/);
    }
  });
});
