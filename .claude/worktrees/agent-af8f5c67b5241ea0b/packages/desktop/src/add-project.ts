// Add project (AO-0274): the person picks a repo in a system dialog, reviews what `swarmup adopt`
// proposes for it, and the app creates the root with the same core code as the CLI. Kept apart
// from main.ts so it can be tested without Electron. The page never names a folder: it gets the
// folders the person picked back for display, and Create uses the ones remembered here.
import {
  addRootToUserConfig,
  adoptPlan,
  adoptRepo,
  checkStoreFolder,
  currentBranch,
  inGitRepo,
  readUserConfig,
  surveyRepo,
} from '@swarmup/core';
import type { ProjectPlan, RepoSurvey, UserConfig } from '@swarmup/core';

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

/** What the page shows before anything is written. */
export interface ProjectProposal {
  kind: 'proposal';
  /** The picked repo. */
  dir: string;
  survey: RepoSurvey;
  plan: ProjectPlan;
  /** The branch checked out in the repo: the merge base when the tasks live apart from it. */
  branch: string | null;
}

/** The picked folder had a data root: it was added to `roots` and nothing else changed. */
export interface ProjectAdded {
  kind: 'added';
  dir: string;
  name: string | null;
  /** False when `roots` listed it already. */
  added: boolean;
  /** False when swarmupd could not be told: it loads the root at its next start. */
  reloaded: boolean;
}

export interface ProjectCreated {
  name: string;
  /** The new data root folder. */
  dir: string;
  /** The folder of the store when it lives apart from the repo. */
  store: string | null;
  base: string | null;
  tasks: Array<{ id: string; title: string }>;
  reloaded: boolean;
}

export interface AddProjectDeps<E> {
  env: NodeJS.ProcessEnv;
  /** Whether the call comes from the app's own page in its own window. */
  fromPage: (e: E) => boolean;
  /** Opens the system folder dialog; null when the person closes it. */
  pickFolder: (title: string) => Promise<string | null>;
  /** Tells swarmupd to read the user config again; throws when it cannot be reached. */
  reload: () => Promise<void>;
  /** Sees the user config before it is written and throws to refuse it. */
  checkConfig?: (next: UserConfig) => void;
}

export interface AddProjectHandlers<E> {
  pick: (e: E) => Promise<Reply<ProjectProposal | ProjectAdded>>;
  plan: (e: E, name: unknown) => Promise<Reply<ProjectPlan>>;
  pickStore: (e: E) => Promise<Reply<{ dir: string }>>;
  create: (e: E, input: unknown) => Promise<Reply<ProjectCreated>>;
}

const REFUSED = { ok: false, error: 'not allowed from this page' } as const;

/** What Create sends: the edited name and prefix, the ticked tasks, and where the tasks live. */
interface CreateInput {
  name: string;
  prefix: string;
  tasks: number[];
  where: 'repo' | 'store';
}

function createInput(input: unknown): CreateInput {
  const i = (input ?? {}) as Record<string, unknown>;
  const name = typeof i.name === 'string' ? i.name.trim() : '';
  const prefix = typeof i.prefix === 'string' ? i.prefix.trim().toUpperCase() : '';
  if (!name) throw new Error('give the project a name');
  if (name.length > 80 || /[\\/:\r\n]/.test(name)) {
    throw new Error('project name: at most 80 characters, without / \\ or :');
  }
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(prefix)) {
    throw new Error('id prefix: a letter, then up to 7 letters or digits, such as SHOP');
  }
  if (!Array.isArray(i.tasks) || i.tasks.some((t) => !Number.isInteger(t))) {
    throw new Error('tasks: use a list of task numbers');
  }
  if (i.where !== 'repo' && i.where !== 'store') throw new Error('where: use repo or store');
  return { name, prefix, tasks: i.tasks as number[], where: i.where };
}

/**
 * The main-process side of Add project. One pick is remembered at a time: `pick` sets the repo,
 * `pickStore` the folder for its tasks, and `create` uses both and forgets them.
 */
export function addProjectHandlers<E>(deps: AddProjectDeps<E>): AddProjectHandlers<E> {
  let picked: { survey: RepoSurvey; store: string | null } | null = null;
  const reload = async (): Promise<boolean> => {
    try {
      await deps.reload();
      return true;
    } catch {
      return false;
    }
  };
  const guard =
    <A extends unknown[], T>(fn: (...args: A) => Promise<T>) =>
    async (e: E, ...args: A): Promise<Reply<T>> => {
      if (!deps.fromPage(e)) return REFUSED;
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    };
  return {
    pick: guard(async () => {
      const dir = await deps.pickFolder('Add project: the folder of the repo');
      if (!dir) throw new Error('cancelled');
      picked = null;
      const survey = surveyRepo(dir);
      if (survey.hasRoot) {
        const res = addRootToUserConfig(deps.env, survey.dir, undefined, deps.checkConfig);
        const reloaded = await reload();
        return { kind: 'added', dir: res.root, name: res.name, added: res.added, reloaded };
      }
      // Agent runs work in git worktrees of the repo, so a folder outside git cannot be a project.
      if (!inGitRepo(survey.dir)) {
        throw new Error(`${survey.dir} is not a git repo: run \`git init\` there first`);
      }
      picked = { survey, store: null };
      return {
        kind: 'proposal',
        dir: survey.dir,
        survey,
        plan: adoptPlan(survey),
        branch: currentBranch(survey.dir),
      };
    }),
    // The first tasks name the project, so a changed name gets its plan again.
    plan: guard(async (name: unknown) => {
      if (!picked) throw new Error('pick a folder first');
      const n = typeof name === 'string' ? name.trim() : '';
      return adoptPlan(picked.survey, n ? { name: n } : {});
    }),
    pickStore: guard(async () => {
      if (!picked) throw new Error('pick a folder first');
      const dir = await deps.pickFolder('The folder for the tasks, outside the repo');
      if (!dir) throw new Error('cancelled');
      checkStoreFolder(picked.survey.dir, dir);
      picked.store = dir;
      return { dir };
    }),
    create: guard(async (input: unknown) => {
      const i = createInput(input);
      if (!picked) throw new Error('pick a folder first');
      if (i.where === 'store' && !picked.store) throw new Error('pick a folder for the tasks');
      const me = readUserConfig(deps.env).me;
      if (!me) throw new Error('the user config has no `me`: finish the setup first');
      const res = adoptRepo(picked.survey.dir, {
        env: deps.env,
        actor: me,
        human: me,
        name: i.name,
        prefix: i.prefix,
        tasks: i.tasks,
        store: i.where === 'store' ? picked.store! : undefined,
        register: true,
        requireGit: true,
        checkConfig: deps.checkConfig,
      });
      picked = null;
      return {
        name: res.name,
        dir: res.dir,
        store: res.store,
        base: res.base,
        tasks: res.tasks.map((t) => ({ id: t.id, title: t.title })),
        reloaded: await reload(),
      };
    }),
  };
}
