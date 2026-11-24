import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { defaultRootConfig, OLD_ROOT_DIR_NAME, ROOT_DIR_NAME } from './config.js';
import { assertActor, OpsError } from './ids.js';

export interface InitOptions {
  name?: string;
  prefix?: string;
  human?: string;
  /** Copy the role and people templates into agents/ and people/. */
  withAgents?: boolean;
  /** Copy only these role templates, such as `claude:qa`, and the people templates. */
  agents?: string[];
  /** The root's `workspace_types` (W8); left out of `config.yml` when unset. */
  workspaceTypes?: string[];
  /** Starter workflows to copy from `templates/workflows/<id>.yaml` into `workflows/` (W5). */
  workflows?: string[];
}

/** Ids of the starter workflows in `templates/workflows/`, such as `bugfix`. */
export function templateWorkflowIds(): string[] {
  const src = join(TEMPLATES_DIR, 'workflows');
  if (!existsSync(src)) return [];
  return readdirSync(src)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** The text of starter workflow `id` from `templates/workflows/`; refuses an unknown id. */
export function templateWorkflowText(id: string): string {
  const known = templateWorkflowIds();
  if (!known.includes(id)) {
    throw new OpsError(
      `no starter workflow '${id}'${known.length ? `: use ${known.join(', ')}` : ''}`,
      2,
    );
  }
  return readFileSync(join(TEMPLATES_DIR, 'workflows', `${id}.yaml`), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

/** Role and people templates shipped with the core package. */
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url));

/** Ids of the role templates in `templates/agents/`, such as `claude:qa`. */
export function templateAgentIds(): string[] {
  const src = join(TEMPLATES_DIR, 'agents');
  if (!existsSync(src)) return [];
  return readdirSync(src)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3).replace('-', ':'));
}

const FOLDERS = ['agents', 'people', 'projects', 'tasks', 'channels', 'decisions', 'kb'];

const README = `# SwarmUp data

This folder holds tasks, events, agents and notes for SwarmUp. Use the \`swarmup\` command to
change it; every change is a new file under \`tasks/<id>/events/\`. \`.ops/\` is local and
git-ignored.
`;

/**
 * Creates a data root. A path that already ends in `.swarmup` is used as is; any other path
 * gets a `.swarmup` folder inside it. A repo that has an old `.agent-ops/` store is refused:
 * `swarmup migrate` moves that one.
 */
export function initRoot(target: string, opts: InitOptions = {}): string {
  const abs = resolve(target);
  const dir = basename(abs) === ROOT_DIR_NAME ? abs : join(abs, ROOT_DIR_NAME);
  if (existsSync(join(dir, 'config.yml'))) throw new OpsError(`${dir} is already a data root`, 2);
  const old = join(dirname(dir), OLD_ROOT_DIR_NAME);
  if (existsSync(join(old, 'config.yml'))) {
    throw new OpsError(`${old} is already a data root; run swarmup migrate to move it`, 2);
  }
  if (opts.human) assertActor(opts.human, 'human');
  const prefix = (opts.prefix ?? 'T').toUpperCase();
  if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) throw new OpsError(`bad id prefix '${prefix}'`, 2);
  const name = opts.name ?? basename(basename(abs) === ROOT_DIR_NAME ? dirname(abs) : abs);
  mkdirSync(dir, { recursive: true });
  for (const f of FOLDERS) {
    mkdirSync(join(dir, f), { recursive: true });
    writeFileSync(join(dir, f, '.gitkeep'), '');
  }
  const config = defaultRootConfig(name, prefix, opts.human);
  if (opts.workspaceTypes?.length) config.workspace_types = [...opts.workspaceTypes];
  writeFileSync(join(dir, 'config.yml'), YAML.stringify(config));
  writeFileSync(join(dir, '.gitignore'), '.ops/\n');
  // Data files stay LF on every machine, even with core.autocrlf=true.
  writeFileSync(join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  if (opts.withAgents || opts.agents) {
    const only = opts.agents && new Set(opts.agents.map((a) => `${a.replace(':', '-')}.md`));
    for (const sub of ['agents', 'people']) {
      const src = join(TEMPLATES_DIR, sub);
      if (!existsSync(src)) continue;
      for (const f of readdirSync(src)) {
        if (!f.endsWith('.md') || (sub === 'agents' && only && !only.has(f))) continue;
        copyFileSync(join(src, f), join(dir, sub, f));
      }
    }
  }
  if (opts.workflows?.length) {
    const known = templateWorkflowIds();
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    for (const id of opts.workflows) {
      if (!known.includes(id)) {
        throw new OpsError(`no starter workflow '${id}': use ${known.join(', ')}`, 2);
      }
      copyFileSync(
        join(TEMPLATES_DIR, 'workflows', `${id}.yaml`),
        join(dir, 'workflows', `${id}.yaml`),
      );
    }
  }
  writeFileSync(join(dir, 'README.md'), README);
  return dir;
}
