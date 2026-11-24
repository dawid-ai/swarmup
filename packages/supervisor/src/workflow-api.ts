// Workflows over swarmupd's API for the desktop app's Workflows view (W5): each store's workflows
// with their text and stages, the starter templates, a live check with a compiled preview, and
// the person's save and delete. Workflow files are read synchronously, as `readWorkflows` does.
import type { CompiledWorkflow, DefProblem, WorkflowDef, Workspace } from '@swarmup/core';
import {
  BLANK_WORKFLOW,
  checkWorkflowText,
  compileWorkflow,
  OpsError,
  readWorkflows,
  readWorkflowText,
  sampleParams,
  templateWorkflowIds,
  templateWorkflowText,
  WORKFLOW_ID_RE,
  workflowFile,
} from '@swarmup/core';

/** A workflow as `GET /api/workflows` lists it. */
export interface WorkflowListItem {
  root: string;
  id: string;
  /** The file's path, and its text for the editor. */
  file: string;
  text: string;
  title?: string;
  description?: string;
  approval?: 'proposal' | 'starter';
  params: NonNullable<WorkflowDef['params']>;
  /** The number of stages; `def` has them in full. */
  stages: number;
  ok: boolean;
  /** `path: message` lines, as before (W5); `issues` has them with lines. */
  problems: string[];
  issues: DefProblem[];
  def: WorkflowDef | null;
}

/** Each own root's workflows, mirrors left out. */
export function listWorkflows(ws: Workspace): WorkflowListItem[] {
  return ws.roots
    .filter((r) => !r.isMirror)
    .flatMap((r) =>
      readWorkflows(r.dir).map((w) => ({
        root: r.name,
        id: w.id,
        file: w.file,
        text: readWorkflowText(w.file) ?? '',
        title: w.def?.title,
        description: w.def?.description,
        approval: w.def ? (w.def.approval ?? 'proposal') : undefined,
        params: w.def?.params ?? {},
        stages: w.def?.stages.length ?? 0,
        ok: w.def !== null,
        problems: w.problems.map((p) => `${p.path}: ${p.message}`),
        issues: w.problems,
        def: w.def,
      })),
    );
}

/** A starter template the app offers for a new workflow. */
export interface WorkflowTemplate {
  id: string;
  title: string;
  description?: string;
  text: string;
}

/** The starter templates, then a blank workflow. */
export function workflowTemplates(): WorkflowTemplate[] {
  const out: WorkflowTemplate[] = [];
  for (const id of templateWorkflowIds()) {
    const text = templateWorkflowText(id);
    const def = checkWorkflowText(id, text, { file: `${id}.yaml` }).def;
    out.push({
      id,
      title: def?.title ?? id,
      ...(def?.description ? { description: def.description } : {}),
      text,
    });
  }
  out.push({
    id: 'blank',
    title: 'Blank',
    description: 'One stage to start from.',
    text: BLANK_WORKFLOW,
  });
  return out;
}

/** `POST /api/workflows/check`: the problems of an edited text, and the plan it compiles to. */
export interface WorkflowCheck {
  ok: boolean;
  problems: DefProblem[];
  def: WorkflowDef | null;
  /** The values the preview compiled with. */
  params?: Record<string, string>;
  plan?: Pick<CompiledWorkflow, 'milestone' | 'approval' | 'dropped'> & {
    items: CompiledWorkflow['doc']['items'];
  };
  /** Why the preview did not compile with these values (the text itself may still check). */
  preview_error?: string;
}

/**
 * Checks workflow text as `id` (schema, then a compile with sample values), then compiles a
 * preview with `params` over the samples. `root` names the store whose human owns gates; without
 * one, a placeholder person.
 */
export function checkWorkflow(
  ws: Workspace,
  input: { id: string; text: string; root?: string; params?: Record<string, string> },
): WorkflowCheck {
  if (!WORKFLOW_ID_RE.test(input.id)) {
    throw new OpsError(
      `bad workflow id '${input.id}': use lowercase letters, digits and dashes, such as bugfix`,
      2,
    );
  }
  const root = input.root ? ws.roots.find((r) => r.name === input.root) : undefined;
  if (input.root && !root) throw new OpsError(`no root named '${input.root}'`, 2);
  const file = root ? workflowFile(root.dir, input.id) : `workflows/${input.id}.yaml`;
  const checked = checkWorkflowText(input.id, input.text, { file });
  const ok = !checked.problems.some((p) => p.severity === 'error');
  const out: WorkflowCheck = { ok, problems: checked.problems, def: checked.def };
  if (!checked.def) return out;
  const declared = checked.def.params ?? {};
  const given = Object.fromEntries(
    Object.entries(input.params ?? {}).filter(
      ([k, v]) => Object.hasOwn(declared, k) && typeof v === 'string' && v !== '',
    ),
  );
  const params = { ...sampleParams(checked.def), ...given };
  out.params = params;
  try {
    const human = root?.config.human || 'human:you';
    const c = compileWorkflow(checked.def, { params, human });
    out.plan = {
      milestone: c.milestone,
      approval: c.approval,
      dropped: c.dropped,
      items: c.doc.items,
    };
  } catch (err) {
    out.preview_error = (err as Error).message;
  }
  return out;
}
