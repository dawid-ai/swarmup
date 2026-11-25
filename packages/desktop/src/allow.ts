// Kept apart from main.ts so it can be tested without Electron.

const SEG = '[^/?#]+';
const QUERY = '(\\?[^#]*)?';
/** The calls the page makes, and nothing else: no shutdown, no unknown routes. */
const ALLOWED: Record<'GET' | 'POST', RegExp[]> = {
  GET: [
    'health',
    'inbox',
    'tasks',
    `tasks/${SEG}`,
    `tasks/${SEG}/diff`,
    // One file of a task's review at the reviewed commit, for the Work section (W8).
    `tasks/${SEG}/artifact`,
    // The adapter a publish task names, for its Publish button, and the preview of what it
    // would publish (W8 phase 3).
    `tasks/${SEG}/(publish|preview)`,
    `tasks/${SEG}/plan`,
    `tasks/${SEG}/criteria-check`,
    `tasks/${SEG}/criteria-judge`,
    'milestones',
    'agents',
    'directory',
    `roles/${SEG}`,
    'runs',
    `runs/${SEG}`,
    `runs/${SEG}/log`,
    `runs/${SEG}/procs`,
    // The files a run kept (W4): the manifest, and one file to show (`?view=1`).
    `runs/${SEG}/artifacts`,
    `runs/${SEG}/artifacts/${SEG}`,
    'waits',
    'settings',
    'schedules',
    'repeats',
    'standup',
    'kb',
    'search',
    'activity',
    'report',
    // Scores (W4): per agent and per task, and each agent's trend per scorer.
    'scores',
    'scores/history',
    'timeline',
    'machines',
    'doctor',
    `kb/${SEG}/${SEG}`,
    // Learn notes that keep mattering (W6).
    'kb/promote',
    'decisions',
    `decisions/${SEG}`,
    'channels',
    `channels/${SEG}`,
    'chat',
    'usage',
    'projects',
    // The project map (W2): the map, one node and search.
    'map',
    'map/(node|search)',
    'defs',
    // Proposals (W6): the variants with their diffs and benchmarks, and the improver's state.
    'defs/variants',
    'improve',
    'bench/(sets|runs)',
    `bench/runs/${SEG}`,
    `bench/runs/${SEG}/attempt`,
    // Settings > MCP servers (W8): servers, secret names and each agent's servers.
    'mcp',
    // Workflows (W5): each root's workflows with their text, and the starter templates.
    'workflows',
    'workflows/templates',
    // Automation: git triggers, merge-check trust and the inbound webhook listener.
    'automation',
  ].map((p) => new RegExp(`^/api/${p}${QUERY}$`)),
  POST: [
    'tasks',
    `tasks/${SEG}/(comment|answer|unblock|done|release|reopen|park|priority|verdict|delegate|start|block|review|assign|retype|plan-approve|plan-reject)`,
    // Done when and the goal brief: `swarmup criteria`, `criteria check`, `criteria judge` and
    // `brief`.
    `tasks/${SEG}/(criteria|criteria-check|criteria-judge|brief)`,
    // Mark published (W8): a person records where a publish task's work went live.
    `tasks/${SEG}/published`,
    // Publish (W8 phase 3): a person runs a publish task's adapter.
    `tasks/${SEG}/publish`,
    'runs',
    `runs/${SEG}/kill`,
    `runs/${SEG}/procs`,
    'decisions',
    `decisions/${SEG}/(vote|decide)`,
    'channels',
    `channels/${SEG}`,
    'settings',
    'schedules',
    `schedules/${SEG}/(run|delete)`,
    'repeats',
    `repeats/${SEG}/(run|pause|resume|delete)`,
    `roots/${SEG}/mirror`,
    // Not relocate: it names a new folder, which only the main process's folder dialog may pick.
    'projects/(archive|unarchive|label|remove)',
    'notify/test',
    'doctor/skills',
    'roles',
    'attachments',
    'chat',
    'chat/(stop|reset)',
    'signin/resume',
    'projects/(archive|unarchive|label|remove)',
    'map/(check|index|init)',
    'defs/(validate|import|create|save)',
    // A person promotes or rejects a proposal, and files an improvement task for an agent.
    `defs/variants/${SEG}/(promote|reject)`,
    'improve',
    // A person proposes a change to a role file, and turns the improvement loop on or off (W6).
    'defs/propose',
    'improve/settings',
    // A person archives learn notes (W6).
    'kb/archive',
    'bench/(run|compare)',
    `bench/runs/${SEG}/stop`,
    // Settings > MCP servers (W8). Not resolve: that is for runs, and holds secret values.
    'mcp/(servers|secrets|strict)',
    `mcp/servers/${SEG}/delete`,
    // A person starts a workflow (W5): a milestone with the workflow's plan. The editor checks
    // its text as you type, and a person saves or deletes the file.
    'workflows/(start|check|save|delete)',
    // Automation: a person turns triggers on or off, trusts or revokes git definitions, turns the
    // inbound listener on or off and approves direct webhook actions.
    'automation/(triggers|trust|revoke|hooks|direct)',
  ].map((p) => new RegExp(`^/api/${p}$`)),
};

/**
 * True when fetch sends the path as written. The URL parser resolves '.' and '..' segments (also
 * as '%2e'), reads '\' as '/' and drops tabs and newlines, so '/api/kb/../shutdown' would pass
 * the list and reach '/api/shutdown'.
 */
function sentAsWritten(path: string): boolean {
  const route = path.split('?', 1)[0]!;
  try {
    return new URL(`http://127.0.0.1${path}`).pathname === route && !/[\t\n\r]/.test(path);
  } catch {
    return false;
  }
}

export function allowedCall(method: unknown, path: unknown): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  if (typeof path !== 'string' || !sentAsWritten(path)) return false;
  return ALLOWED[method].some((re) => re.test(path));
}

/** The scheme the page loads attached images from: `swarmup-att://file/<name>`. */
export const ATTACHMENT_SCHEME = 'swarmup-att';

/** Same as ATTACHMENT_NAME_RE in core: a ULID and an image extension, nothing else. */
const NAME_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.(png|jpg|webp|gif)$/;

/** The attachment name in an `swarmup-att://file/<name>` URL, or null for any other URL. */
export function attachmentName(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${ATTACHMENT_SCHEME}:` || u.host !== 'file' || u.search || u.hash) {
    return null;
  }
  const name = u.pathname.replace(/^\//, '');
  return NAME_RE.test(name) ? name : null;
}
