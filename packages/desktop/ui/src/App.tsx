import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Archive as ArchiveIcon,
  History,
  BarChart3,
  BookOpen,
  Bookmark,
  Bot,
  CalendarClock,
  ChevronRight,
  Clapperboard,
  FlaskConical,
  FolderGit2,
  FolderPlus,
  Hash,
  Inbox as InboxIcon,
  Kanban,
  ListTodo,
  Map as MapIcon,
  MessageSquare,
  Newspaper,
  Plus,
  Radar,
  RefreshCw,
  Repeat,
  Settings as SettingsIcon,
  TriangleAlert,
  Vote,
  X,
  Download,
  Workflow as WorkflowIcon,
  Zap,
} from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetupStatus } from './api';
import { api, bridge, refreshSoon, useData, useUpdate } from './api';
import { Avatar, Toaster, cx, toast } from './components';
import { Mark } from './ui/brand';
import { ProviderStatusBar } from './ui/provider-status';
import { Lightbox } from './ui/attach';
import type { SavedView } from './lib/filters';
import { loadViews, storeViews, viewProject, VIEWS_CHANGED } from './lib/filters';
import type { AddAgentRequest } from './lib/goto';
import { ADD_AGENT_EVENT } from './lib/goto';
import { mouseNav } from './lib/history';
import { findTask, isTyping, keyAction } from './lib/keys';
import { useMover } from './ui/move';
import { Palette, ShortcutHelp } from './ui/palette';
import { setRefTasks } from './lib/refs';
import { useRefTasks, useTaskFocus } from './ui/refs';
import type {
  Decision,
  InboxItem,
  Info,
  ListedProject,
  ProviderUsage,
  RunRecord,
  SignedOut,
  Task,
} from './types';
import type { Settings as SettingsData } from './types';
import { Activity as ActivityView } from './views/Activity';
import type { AddProjectState } from './views/AddProject';
import { ADD_PROJECT_EVENT, AddProject, pickProject } from './views/AddProject';
import { AddAgentDialog, Agents } from './views/Agents';
import { Bench } from './views/Bench';
import { Board } from './views/Board';
import { Channels } from './views/Channels';
import { Chat } from './views/Chat';
import { Decisions } from './views/Decisions';
import { Findings } from './views/Findings';
import { Inbox } from './views/Inbox';
import { Knowledge } from './views/Knowledge';
import { List } from './views/List';
import { ProjectMap } from './views/Map';
import { NewTask } from './views/NewTask';
import { Replay } from './views/Replay';
import { Reports } from './views/Reports';
import { Runs } from './views/Runs';
import { Repeating } from './views/Repeating';
import { Schedules } from './views/Schedules';
import { Automation } from './views/Automation';
import { Workflows } from './views/Workflows';
import { Settings } from './views/Settings';
import { Setup } from './views/Setup';
import { Search } from './views/Search';
import { Standups } from './views/Standups';
import { SEARCH_INPUT_ID, SearchBox } from './ui/search';
import { TaskPanel } from './views/TaskPanel';
import { ProjectControls, type ProjectMenuRequest } from './ui/projects';
import { projectLabels, setProjectLabels } from './ui/project-label';

export type View =
  | 'inbox'
  | 'board'
  | 'list'
  | 'findings'
  | 'standups'
  | 'activity'
  | 'reports'
  | 'bench'
  | 'replay'
  | 'agents'
  | 'runs'
  | 'schedules'
  | 'automation'
  | 'workflows'
  | 'repeating'
  | 'decisions'
  | 'chat'
  | 'channels'
  | 'knowledge'
  | 'map'
  | 'search'
  | 'settings';

type SidebarSection = 'projects' | 'work' | 'agents' | 'talk';

const GROUPS: Array<{
  section: Exclude<SidebarSection, 'projects'>;
  title: string;
  items: Array<[View, string, LucideIcon]>;
}> = [
  {
    section: 'work',
    title: 'Work',
    items: [
      ['inbox', 'Inbox', InboxIcon],
      ['board', 'Board', Kanban],
      ['list', 'Tasks', ListTodo],
      ['findings', 'Findings', Radar],
      ['standups', 'Standups', Newspaper],
      ['activity', 'Activity', History],
      ['reports', 'Reports', BarChart3],
      ['bench', 'Benchmarks', FlaskConical],
      ['replay', 'Replay', Clapperboard],
    ],
  },
  {
    section: 'agents',
    title: 'Agents',
    items: [
      ['agents', 'Agents', Bot],
      ['runs', 'Runs', Activity],
      ['schedules', 'Schedules', CalendarClock],
      ['automation', 'Automation', Zap],
      ['workflows', 'Workflows', WorkflowIcon],
      ['repeating', 'Repeating', Repeat],
    ],
  },
  {
    section: 'talk',
    title: 'Talk',
    items: [
      ['chat', 'Chat', MessageSquare],
      ['channels', 'Channels', Hash],
      ['decisions', 'Decisions', Vote],
      ['knowledge', 'Knowledge', BookOpen],
      ['map', 'Map', MapIcon],
    ],
  },
];

const VIEWS: View[] = [...GROUPS.flatMap((g) => g.items.map(([v]) => v)), 'search', 'settings'];

const SIDEBAR_SECTIONS: SidebarSection[] = ['projects', 'work', 'agents', 'talk'];
const SIDEBAR_FOLDED_KEY = 'swarmup.sidebar.folded';

function isSidebarSection(value: string | undefined): value is SidebarSection {
  return SIDEBAR_SECTIONS.includes(value as SidebarSection);
}

function loadFoldedSections(): Record<SidebarSection, boolean> {
  const folded = { projects: false, work: false, agents: false, talk: false };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SIDEBAR_FOLDED_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    for (const section of SIDEBAR_SECTIONS) folded[section] = saved[section] === true;
  } catch {
    // A corrupt or unavailable local store leaves every section open.
  }
  return folded;
}

function storeFoldedSections(folded: Record<SidebarSection, boolean>): void {
  try {
    window.localStorage.setItem(SIDEBAR_FOLDED_KEY, JSON.stringify(folded));
  } catch {
    // Folding still works for this window when the local store is unavailable.
  }
}

const pathKey = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows drive and UNC paths are case-insensitive; POSIX paths are not.
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLocaleLowerCase()
    : normalized;
};

/**
 * Loaded roots include the cwd and Master Repo mirrors; `/api/projects` adds configured roots that
 * are archived or missing. Keep the loaded order, then the remaining user-config order.
 */
function sidebarProjects(
  loaded: SettingsData['rootList'],
  configured: ListedProject[] | undefined,
  listedRoots: string[] = [],
): ListedProject[] {
  // A configured entry names a repo or its store folder; swarmupd loads the store folder. Match a
  // loaded root by either, or a project listed as its repo shows twice.
  const byPath = new Map<string, ListedProject>();
  for (const p of configured ?? []) {
    byPath.set(pathKey(p.root), p);
    if (p.dir) byPath.set(pathKey(p.dir), p);
  }
  const listedPaths = new Set(listedRoots.map(pathKey));
  const seen = new Set<string>();
  const out: ListedProject[] = [];
  for (const root of loaded.filter((r) => !r.isMaster)) {
    const key = pathKey(root.dir);
    const listed = byPath.get(key);
    // A project action has answered with a newer config than `/api/settings`: do not put a just
    // removed root back while the settings refresh is in flight. Cwd and mirror roots are not in
    // `roots`, so they remain visible.
    if (configured && listedPaths.has(key) && !listed) continue;
    seen.add(key);
    if (listed) seen.add(pathKey(listed.root));
    out.push(
      listed
        ? {
            ...listed,
            name: root.name,
            label: listed.label || root.label || root.name,
            found: true,
          }
        : {
            root: root.dir,
            name: root.name,
            label: root.label || root.name,
            archived: false,
            found: true,
          },
    );
  }
  for (const project of configured ?? []) {
    if (!seen.has(pathKey(project.root))) out.push(project);
  }
  return out;
}

interface Status {
  connected: boolean;
  error?: string;
}

export interface Nav {
  me: string | null;
  /** Opens a task: `AO-0047`, `root/AO-0047`, or `AO-0014#<event id>` scrolled to that event. */
  openTask: (ref: string) => void;
  go: (view: View, arg?: string) => void;
}

export function App() {
  const [view, setView] = useState<View>('inbox');
  const [arg, setArg] = useState<string | undefined>();
  const [folded, setFolded] = useState(loadFoldedSections);
  const setSectionFolded = useCallback((section: SidebarSection, value: boolean): void => {
    setFolded((current) => {
      if (current[section] === value) return current;
      const next = { ...current, [section]: value };
      storeFoldedSections(next);
      return next;
    });
  }, []);
  const toggleSection = useCallback(
    (section: SidebarSection): void => setSectionFolded(section, !folded[section]),
    [folded, setSectionFolded],
  );
  // The open task and the event a task reference points at.
  const { task, focus, open: setTask, back, forward } = useTaskFocus();
  // Back and Forward for the key and mouse listeners below, which are added once.
  const moves = useRef({ back, forward });
  moves.current = { back, forward };
  useEffect(() => {
    const onMouse = (e: MouseEvent): void => {
      const dir = mouseNav(e.button);
      if (!dir) return;
      // Stop Chromium's own page history on the side buttons too.
      e.preventDefault();
      if (e.type === 'mouseup') moves.current[dir]?.();
    };
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);
  // Task references in rendered text (lib/refs.ts) open the task panel.
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const el = (e.target as Element | null)?.closest?.('a[data-task-ref]');
      if (!el) return;
      e.preventDefault();
      setTask(el.getAttribute('data-task-ref'));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [setTask]);
  // A greyed, not configured agent in a picker opens Add agent for it (lib/goto.ts), as a dialog
  // above the form the picker is in: the view, the task panel and that form stay as they are.
  const [addAgent, setAddAgent] = useState<AddAgentRequest | null>(null);
  useEffect(() => {
    const onAdd = (e: Event): void => {
      const req = (e as CustomEvent<AddAgentRequest>).detail;
      if (typeof req?.id === 'string') setAddAgent(req);
    };
    window.addEventListener(ADD_AGENT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_AGENT_EVENT, onAdd);
  }, []);
  // Add project (AO-0274): the folder dialog first, then the proposal for the picked repo. A pick
  // that fails (not a git repo) shows in the dialog, with a button to pick again.
  const [adding, setAdding] = useState<AddProjectState | null>(null);
  /** The screenshot run creates the proposed project without a click. */
  const [autoCreate, setAutoCreate] = useState(false);
  const picking = useRef(false);
  const addProject = useCallback((): void => {
    if (picking.current) return;
    picking.current = true;
    pickProject()
      .then(
        (state) => setAdding(state),
        (e: Error) => setAdding({ error: e.message }),
      )
      .finally(() => {
        picking.current = false;
      });
  }, []);
  useEffect(() => {
    window.addEventListener(ADD_PROJECT_EVENT, addProject);
    return () => window.removeEventListener(ADD_PROJECT_EVENT, addProject);
  }, [addProject]);
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState<Status>({ connected: false });
  // Paused swarmupd, from the main process: the tray, Settings and `swarmup daemon pause` change it.
  const [halted, setHalted] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge()
      .desktop()
      .then((res) => live && res.ok && setHalted(Boolean(res.data?.state.paused)));
    const off = bridge().onService(
      (m) => live && setHalted(Boolean((m as { paused?: boolean }).paused)),
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  const update = useUpdate();
  const [creating, setCreating] = useState(false);
  /** New task opens on its Start a workflow step: the palette's Start a workflow. */
  const [workflowFirst, setWorkflowFirst] = useState(false);
  /** The project Add project created while New task was open: the form selects it (AO-0323). */
  const [addedProject, setAddedProject] = useState<string | undefined>(undefined);
  /** The screenshot run opens New task with its project list open and this text typed. */
  const [formSearch, setFormSearch] = useState<string | undefined>(undefined);
  const shotForm = useRef(false);
  const closeForm = useCallback((): void => {
    setCreating(false);
    setWorkflowFirst(false);
    setAddedProject(undefined);
    setFormSearch(undefined);
  }, []);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [restartNote, setRestartNote] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  /** The task whose panel opens with its diff shown. */
  const [diffOf, setDiffOf] = useState<string | null>(null);
  /** The milestone whose panel opens with its waiting plan in edit mode. */
  const [planEditOf, setPlanEditOf] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuRequest | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const projectList = useRef<ListedProject[]>([]);
  const pendingG = useRef(false);

  const loadInfo = useCallback(() => {
    bridge()
      .info()
      .then(
        (i) => {
          setInfo(i);
          setInfoError(null);
          refreshSoon();
        },
        (e: Error) => setInfoError(e.message),
      );
  }, []);

  useEffect(() => {
    let b;
    try {
      b = bridge();
    } catch (e) {
      setInfoError((e as Error).message);
      return;
    }
    // First start: set up the user config before swarmupd starts, so it loads it.
    b.setupStatus().then(
      (s) => {
        if (s.needed) setSetup(s);
        else loadInfo();
      },
      (e: Error) => setInfoError(e.message),
    );
    const offs = [
      b.onEvent((m) => {
        const ev = (m as { event: string }).event;
        // `merge`: the merge under way started, moved on or ended (AO-0161).
        if (['tasks', 'changed', 'run', 'sync', 'signin', 'merge'].includes(ev)) refreshSoon();
      }),
      b.onStatus((m) => {
        setStatus(m as Status);
        if ((m as Status).connected) refreshSoon();
      }),
      b.onNavigate((m) => {
        const nav = m as { view: string; id?: string };
        // The form the screenshot run opened closes for its next view; one a person opened stays.
        if (shotForm.current) {
          shotForm.current = false;
          closeForm();
        }
        // The screenshot run opens New task this way, its project list filtered by the id.
        if (nav.view === 'new-task') {
          shotForm.current = true;
          setFormSearch(nav.id ?? '');
          setCreating(true);
        } else if (nav.view === 'task' && nav.id) setTask(nav.id);
        // The screenshot run opens a task with its diff this way (AO-0106).
        else if (nav.view === 'diff' && nav.id) {
          setDiffOf(nav.id);
          setTask(nav.id);
        }
        // And a milestone with its waiting plan in edit mode (AO-0110).
        else if (nav.view === 'plan-edit' && nav.id) {
          setPlanEditOf(nav.id);
          setTask(nav.id);
        }
        // The screenshot run opens the palette and the shortcut list this way.
        else if (nav.view === 'palette') setPalette(true);
        else if (nav.view === 'shortcuts') setHelp(true);
        // And Add project, whose folder the screenshot run names; `create` also creates it.
        else if (nav.view === 'add-project') {
          setAutoCreate(nav.id === 'create');
          addProject();
        } else if (nav.view === 'project-menu') {
          const project = projectList.current.find(
            (p) => p.name === nav.id || p.label === nav.id || p.root === nav.id,
          );
          if (project) setProjectMenu({ project, x: 172, y: 180 });
        } else if (nav.view === 'archived-projects') {
          setArchivedOpen(true);
        } else if (nav.view === 'sidebar-fold' && isSidebarSection(nav.id)) {
          // The smoke run captures an intentionally folded section.
          setSectionFolded(nav.id, true);
        } else if (VIEWS.includes(nav.view as View)) {
          setView(nav.view as View);
          setArg(nav.id);
          setTask(null);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [loadInfo, setTask, addProject, closeForm, setSectionFolded]);

  // A swarmupd older than the app restarts once no run is live: look again every 30 s.
  useEffect(() => {
    if (!info?.stale) return;
    const timer = setInterval(loadInfo, 30_000);
    return () => clearInterval(timer);
  }, [info?.stale, loadInfo]);

  const me = info?.me ?? null;
  const inbox = useData<InboxItem[]>(me ? `/api/inbox?as=${encodeURIComponent(me)}` : null);
  const live = useData<RunRecord[]>(info ? '/api/runs?live' : null);
  const votes = useData<Decision[]>(info ? '/api/decisions' : null);
  const tasks = useData<Task[]>(info ? '/api/tasks' : null);
  // The loaded data roots, for the sidebar's project list.
  const settings = useData<SettingsData>(info ? '/api/settings' : null);
  // Unlike `/api/settings`, this includes roots archived out of swarmupd's live workspace.
  const configuredProjects = useData<ListedProject[]>(info ? '/api/projects' : null);
  const projects = sidebarProjects(
    settings.data?.rootList ?? [],
    configuredProjects.data,
    settings.data?.roots,
  );
  projectList.current = projects;
  // Every view shows a project by its label (AO-0353); a rename updates `projects` at once.
  const labels = projectLabels(settings.data?.rootList, projects);
  useEffect(() => setProjectLabels(labels));
  const activeProjects = projects.filter((project) => !project.archived);
  const archivedProjects = projects.filter((project) => project.archived);
  // Signed-out providers (AO-0154): a banner on every view until each is signed in again.
  const usage = useData<Record<string, ProviderUsage>>(info ? '/api/usage' : null);
  const signedOut = Object.entries(usage.data ?? {}).flatMap(([p, u]) =>
    u.signed_out ? [[p, u.signed_out] as const] : [],
  );
  const [saved, setSaved] = useState<SavedView[]>(() => loadViews());
  useEffect(() => {
    const reload = (): void => setSaved(loadViews());
    window.addEventListener(VIEWS_CHANGED, reload);
    return () => window.removeEventListener(VIEWS_CHANGED, reload);
  }, []);
  const nav: Nav = {
    me,
    openTask: setTask,
    go: (v, a) => {
      setView(v);
      setArg(a);
    },
  };
  const mover = useMover(nav, setMoveError);
  // Closed tasks too: task reference chips show their status and title, and the palette, the task
  // panel and the # picker search them.
  const allTasks = useData<Task[]>(info ? '/api/tasks?all' : null);
  useEffect(() => {
    if (allTasks.data) setRefTasks(allTasks.data);
  }, [allTasks.data]);
  // Markdown views draw chips from the index as they render, so App draws again when it changes.
  useRefTasks();

  // Ctrl+K anywhere; single keys only outside fields (see lib/keys.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const r = keyAction(e, {
        pendingG: pendingG.current,
        typing: isTyping(document.activeElement as HTMLElement | null),
        // With a dialog open only Ctrl+K acts, and no `g` sequence starts or carries over.
        modal: document.querySelector('[data-modal]') !== null,
      });
      pendingG.current = r.pendingG;
      if (!r.action) return;
      e.preventDefault();
      switch (r.action.kind) {
        case 'palette':
          setPalette((p) => !p);
          break;
        case 'find': {
          const box = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
          box?.focus();
          box?.select();
          break;
        }
        case 'new':
          setCreating(true);
          break;
        case 'help':
          setHelp(true);
          break;
        case 'back':
        case 'forward':
          moves.current[r.action.kind]?.();
          break;
        case 'search':
          document
            .querySelector<HTMLInputElement>('main input:not([type]), main input[type="text"]')
            ?.focus();
          break;
        case 'go':
          setView(r.action.view as View);
          setArg(undefined);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const counts: Partial<Record<View, { n: number; tone: string }>> = {
    inbox: { n: inbox.data?.length ?? 0, tone: '#5ce1e6' },
    runs: { n: live.data?.length ?? 0, tone: '#3ddc97' },
    decisions: { n: (votes.data ?? []).filter((d) => !d.outcome).length, tone: '#b18cff' },
    findings: {
      n: (tasks.data ?? []).filter(
        (t) => t.type === 'finding' && !['done', 'parked'].includes(t.status),
      ).length,
      tone: '#ffb547',
    },
  };
  const isGroupItemActive = (item: View): boolean =>
    view === item && !(item === 'list' && arg?.startsWith('project:'));
  const isProjectActive = (name: string): boolean => view === 'list' && arg === `project:${name}`;

  if (setup) {
    return (
      <Setup
        status={setup}
        onDone={(restart) => {
          setSetup(null);
          setRestartNote(restart);
          loadInfo();
        }}
      />
    );
  }

  if (infoError && !info) {
    return (
      <div className="stage flex h-screen items-center justify-center p-8 text-center">
        <div className="panel max-w-md p-8">
          <TriangleAlert size={28} className="mx-auto text-warn" />
          <div className="mt-3 font-display text-lg font-semibold tracking-wide">
            Cannot reach swarmupd
          </div>
          <div className="mt-1 text-sm text-fg-3">{infoError}</div>
        </div>
      </div>
    );
  }

  const restart = (): void => {
    setRestarting('Restarting…');
    bridge()
      .restart()
      .then((res) => {
        setRestarting(res.ok ? null : (res.error ?? 'restart failed'));
        if (res.ok) loadInfo();
      });
  };

  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-white/6 bg-ink-950">
          <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
            <Mark size={30} />
            <div>
              <div className="font-display text-[17px] leading-none font-bold tracking-[0.08em] uppercase">
                SwarmUp
              </div>
              <div className="mt-1 text-[10px] tracking-[0.2em] text-fg-4 uppercase">
                control room
              </div>
            </div>
          </div>
          <div className="px-3 pb-2">
            <button
              onClick={() => setCreating(true)}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-signal text-sm font-semibold text-ink-950 shadow-[0_0_24px_-6px_rgba(92,225,230,0.8)] transition hover:bg-[#7debef] active:translate-y-px"
            >
              <Plus size={16} strokeWidth={2.6} /> New task
            </button>
            {/* The conversation with the PM, one click from every view (AO-0134). */}
            <button
              type="button"
              data-chat-button
              onClick={() => nav.go('chat')}
              title="One conversation with the project's PM; an answer never closes it"
              className={cx(
                'mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-sm font-medium transition active:translate-y-px',
                view === 'chat'
                  ? 'border-signal/50 bg-signal/10 text-signal'
                  : 'border-white/10 text-fg-2 hover:border-white/20 hover:bg-white/4 hover:text-fg',
              )}
            >
              <MessageSquare size={16} /> Chat with the PM
            </button>
          </div>
          <SearchBox nav={nav} />
          <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-2 py-2">
            {/* First, so Add project shows without scrolling in a window of the smallest size. */}
            <div data-projects>
              <SectionHeader
                title="Projects"
                section="projects"
                folded={folded.projects}
                onToggle={toggleSection}
              />
              <div id="sidebar-section-projects">
                {activeProjects
                  .filter((p) => !folded.projects || isProjectActive(p.name ?? ''))
                  .map((p) => (
                    <NavItem
                      key={p.root}
                      active={isProjectActive(p.name ?? '')}
                      icon={FolderGit2}
                      label={p.label || p.name || p.root}
                      title={p.root}
                      onClick={() => p.name && nav.go('list', `project:${p.name}`)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setProjectMenu({ project: p, x: event.clientX, y: event.clientY });
                      }}
                    />
                  ))}
                {!folded.projects && archivedProjects.length > 0 && (
                  <div data-archived-projects className="mt-1">
                    <button
                      type="button"
                      aria-expanded={archivedOpen}
                      aria-controls="sidebar-archived-projects"
                      onClick={() => setArchivedOpen((open) => !open)}
                      className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-fg-4 transition hover:bg-white/4 hover:text-fg-2"
                    >
                      <ChevronRight
                        size={12}
                        strokeWidth={2.4}
                        className={cx('transition-transform', archivedOpen && 'rotate-90')}
                      />
                      <ArchiveIcon size={14} strokeWidth={1.9} />
                      <span className="flex-1 font-medium tracking-wide">Archived</span>
                      <span className="font-mono text-[10px]">{archivedProjects.length}</span>
                    </button>
                    {archivedOpen && (
                      <div
                        id="sidebar-archived-projects"
                        className="ml-3 border-l border-white/8 pl-1"
                      >
                        {archivedProjects.map((p) => (
                          <NavItem
                            key={p.root}
                            active={isProjectActive(p.name ?? '')}
                            icon={FolderGit2}
                            label={p.label || p.name || p.root}
                            title={p.found ? p.root : `${p.root} (folder not found)`}
                            onClick={() => p.name && nav.go('list', `project:${p.name}`)}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setProjectMenu({ project: p, x: event.clientX, y: event.clientY });
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!folded.projects && (
                  <NavItem
                    active={false}
                    icon={FolderPlus}
                    label="Add project"
                    onClick={addProject}
                  />
                )}
              </div>
            </div>
            {GROUPS.map((g) => {
              const section = g.section;
              return (
                <div key={g.title}>
                  <SectionHeader
                    title={g.title}
                    section={section}
                    folded={folded[section]}
                    onToggle={toggleSection}
                  />
                  <div id={`sidebar-section-${section}`}>
                    {g.items
                      .filter(([v]) => !folded[section] || isGroupItemActive(v))
                      .map(([v, label, Icon]) => (
                        <NavItem
                          key={v}
                          // A project from the list above shows the task list; the mark stays on it.
                          active={isGroupItemActive(v)}
                          icon={Icon}
                          label={label}
                          count={counts[v]}
                          onClick={() => nav.go(v)}
                        />
                      ))}
                  </div>
                </div>
              );
            })}
            {saved.length > 0 && (
              <div>
                <div className="label-caps px-3 pb-1.5 !text-[10px]">Saved views</div>
                {saved.map((v) => (
                  <div key={v.name} className="group/view relative">
                    <NavItem
                      active={view === v.view && arg === `saved:${v.name}`}
                      icon={v.view === 'board' ? Kanban : Bookmark}
                      label={v.name}
                      onClick={() => nav.go(v.view, `saved:${v.name}`)}
                    />
                    <button
                      type="button"
                      aria-label={`Delete the view ${v.name}`}
                      title="Delete this view"
                      onClick={() => storeViews(saved.filter((x) => x.name !== v.name))}
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-fg-4 opacity-0 transition group-hover/view:opacity-100 hover:bg-white/10 hover:text-fg"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </nav>
          <div className="border-t border-white/6 px-2 py-2">
            <NavItem
              active={view === 'settings'}
              icon={SettingsIcon}
              label="Settings"
              onClick={() => nav.go('settings')}
            />
          </div>
          <div className="flex items-center gap-2.5 border-t border-white/6 px-4 py-3">
            {me ? (
              <Avatar id={me} size={30} />
            ) : (
              <span className="h-[30px] w-[30px] rounded-[30%] bg-ink-700" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs text-fg-2">{me ?? 'no me set'}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-4">
                <span
                  className={cx(
                    'h-1.5 w-1.5 rounded-full',
                    status.connected ? 'animate-pulse-dot bg-ok text-ok' : 'bg-bad',
                  )}
                />
                {status.connected ? `swarmupd · pid ${info?.pid ?? '-'}` : 'swarmupd offline'}
                {status.connected && halted && <span className="text-warn">· paused</span>}
              </div>
            </div>
          </div>
          {(restartNote || (!status.connected && status.error)) && (
            <div className="px-4 pb-3 text-[11px] text-warn">
              {restartNote ? (
                <button
                  type="button"
                  className="text-left hover:text-fg"
                  onClick={() => nav.go('settings', 'general')}
                >
                  swarmupd runs agents: open Settings &gt; General to restart and load the new
                  config
                </button>
              ) : (
                status.error
              )}
            </div>
          )}
        </aside>
        <main className="stage flex min-w-0 flex-1 flex-col">
          {signedOut.map(([p, s]) => (
            <SignedOutBanner key={p} provider={p} state={s} onResumed={usage.reload} />
          ))}
          {update?.status === 'ready' && (
            <div className="flex items-center gap-3 border-b border-signal/25 bg-signal/8 px-6 py-2 text-sm text-signal">
              <Download size={16} />
              <span className="min-w-0 flex-1">
                SwarmUp {update.version} is ready. It installs on its own once no agent run is live
                and this window is closed.
              </span>
              <button
                type="button"
                onClick={() => nav.go('settings', 'updates')}
                className="rounded-md px-2.5 py-1 text-xs font-medium hover:bg-signal/10"
              >
                Settings &gt; Updates
              </button>
              <button
                onClick={() => void bridge().update('install')}
                className="inline-flex items-center gap-1.5 rounded-md bg-signal/15 px-2.5 py-1 text-xs font-medium hover:bg-signal/25"
              >
                <RefreshCw size={13} /> Restart and install
              </button>
            </div>
          )}
          {info?.stale && (
            <div className="flex items-center gap-3 border-b border-warn/25 bg-warn/8 px-6 py-2 text-sm text-warn">
              <TriangleAlert size={16} />
              <span className="min-w-0 flex-1">
                swarmupd runs an older build than this app
                {info.live ? ` and ${info.live} run${info.live === 1 ? ' is' : 's are'} live` : ''}.
                It restarts on its own once no run is live; until then some views may lack data.
              </span>
              {restarting && <span className="text-xs">{restarting}</span>}
              <button
                onClick={restart}
                className="inline-flex items-center gap-1.5 rounded-md bg-warn/15 px-2.5 py-1 text-xs font-medium hover:bg-warn/25"
              >
                <RefreshCw size={13} /> Restart now if idle
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {view === 'inbox' && <Inbox nav={nav} items={inbox.data} error={inbox.error} />}
            {/* Keyed on the saved view, so leaving one starts from the default filters. */}
            {view === 'board' && <Board key={arg ?? ''} nav={nav} preset={arg} />}
            {view === 'list' && <List key={arg ?? ''} nav={nav} preset={arg} />}
            {view === 'findings' && <Findings nav={nav} />}
            {view === 'knowledge' && <Knowledge key={arg ?? ''} nav={nav} selected={arg} />}
            {view === 'map' && <ProjectMap key={arg ?? ''} nav={nav} selected={arg} />}
            {view === 'search' && <Search nav={nav} initial={arg} />}
            {view === 'standups' && <Standups nav={nav} />}
            {view === 'activity' && <ActivityView nav={nav} />}
            {view === 'reports' && <Reports nav={nav} />}
            {view === 'bench' && <Bench nav={nav} selected={arg} />}
            {view === 'replay' && <Replay />}
            {view === 'agents' && <Agents nav={nav} selected={arg} />}
            {view === 'runs' && <Runs nav={nav} selected={arg} />}
            {view === 'schedules' && <Schedules nav={nav} selected={arg} />}
            {view === 'automation' && <Automation nav={nav} />}
            {view === 'workflows' && <Workflows nav={nav} />}
            {view === 'repeating' && <Repeating nav={nav} />}
            {view === 'decisions' && <Decisions key={arg ?? ''} nav={nav} selected={arg} />}
            {view === 'chat' && <Chat nav={nav} />}
            {view === 'channels' && <Channels nav={nav} selected={arg} />}
            {view === 'settings' && (
              <Settings nav={nav} info={info} onRestarted={loadInfo} section={arg} />
            )}
          </div>
        </main>
        {task && (
          <TaskPanel
            key={task}
            id={task}
            focus={focus ?? undefined}
            showDiff={diffOf === task}
            editPlan={planEditOf === task}
            nav={nav}
            onClose={() => setTask(null)}
            onBack={back ?? undefined}
            onForward={forward ?? undefined}
          />
        )}
      </div>
      <ProviderStatusBar
        usage={usage.data}
        pause={settings.data?.opsd}
        onOpen={(provider) => nav.go('agents', provider)}
      />{' '}
      <Toaster />
      <ProjectControls
        menu={projectMenu}
        onCloseMenu={() => setProjectMenu(null)}
        onChanged={(projects) => {
          configuredProjects.set(projects);
          settings.reload();
        }}
        onProjectUnavailable={(project) => {
          if (project.name && isProjectActive(project.name)) nav.go('board');
        }}
      />
      <Lightbox />
      {palette && (
        <Palette
          nav={nav}
          tasks={allTasks.data ?? tasks.data ?? []}
          open={findTask(allTasks.data ?? tasks.data ?? [], task)}
          onMove={mover.request}
          onNew={() => setCreating(true)}
          onStartWorkflow={() => {
            setWorkflowFirst(true);
            setCreating(true);
          }}
          onHelp={() => setHelp(true)}
          onClose={() => setPalette(false)}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {mover.dialog}
      {moveError && (
        <div className="animate-rise fixed right-5 bottom-5 z-50 flex max-w-md items-start gap-3 rounded-xl border border-bad/30 bg-ink-850 px-4 py-3 text-sm text-bad shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
          <span className="flex-1">{moveError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setMoveError(null)}
            className="text-fg-3 hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {creating && (
        <NewTask
          me={me}
          roots={settings.data?.rootList}
          tasks={allTasks.data ?? tasks.data ?? undefined}
          // The project the Board or List is filtered to, whichever way the form opened.
          project={viewProject()}
          added={addedProject}
          search={formSearch}
          workflow={workflowFirst}
          onClose={closeForm}
          onCreated={(id) => {
            closeForm();
            setTask(id);
          }}
          onOpenWorkflows={() => {
            closeForm();
            nav.go('workflows');
          }}
        />
      )}
      {adding && (
        <AddProject
          // A new pick starts the form again from its proposal.
          key={'proposal' in adding ? adding.proposal.dir : 'error'}
          state={adding}
          auto={autoCreate}
          onPick={addProject}
          onClose={() => setAdding(null)}
          onCreated={(p) => {
            setAdding(null);
            setAutoCreate(false);
            settings.reload();
            configuredProjects.reload();
            toast(
              p.reloaded
                ? `Created ${p.name} with ${p.tasks.length} ${p.tasks.length === 1 ? 'task' : 'tasks'}`
                : `Created ${p.name}. Restart swarmupd in Settings to load it`,
            );
            // With New task open, the form stays as it is and takes the new project; otherwise
            // the list shows it.
            if (!p.reloaded) return;
            if (creating) setAddedProject(p.name);
            else nav.go('list', `project:${p.name}`);
          }}
        />
      )}
      {addAgent && (
        <AddAgentDialog
          key={addAgent.id}
          id={addAgent.id}
          onAdded={addAgent.onAdded}
          onClose={() => setAddAgent(null)}
        />
      )}
    </div>
  );
}

/** Text with `code` spans, such as a provider's sign-in steps. */
function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-white/8 px-1 font-mono text-[12px]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * A provider is signed out (AO-0154): no run of it starts until the person signs in. swarmupd checks
 * by itself; **Resume** tries at once, for after the person signed in.
 */
function SignedOutBanner(props: { provider: string; state: SignedOut; onResumed: () => void }) {
  const { provider, state } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = (): void => {
    setBusy(true);
    setError(null);
    api('POST', '/api/signin/resume', { provider }).then(
      () => {
        setBusy(false);
        props.onResumed();
        refreshSoon();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  return (
    <div
      data-signed-out={provider}
      className="flex items-center gap-3 border-b border-warn/25 bg-warn/8 px-6 py-2 text-sm text-warn"
    >
      <TriangleAlert size={16} />
      <span className="min-w-0 flex-1">
        <b>{provider}</b> is signed out on this PC, so no {provider} run starts. To sign in,{' '}
        <CodeText text={state.steps} />.{' '}
        {state.check
          ? 'swarmupd checks every few minutes and starts its runs again by itself.'
          : 'swarmupd tries one run an hour.'}{' '}
        Click Resume after you sign in to start at once.
        {error && <span className="ml-1 text-bad">{error}</span>}
      </span>
      <button
        onClick={resume}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md bg-warn/15 px-2.5 py-1 text-xs font-medium hover:bg-warn/25 disabled:opacity-50"
      >
        <RefreshCw size={13} /> Resume
      </button>
    </div>
  );
}

function SectionHeader(props: {
  title: string;
  section: SidebarSection;
  folded: boolean;
  onToggle: (section: SidebarSection) => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!props.folded}
      aria-controls={`sidebar-section-${props.section}`}
      onClick={() => props.onToggle(props.section)}
      className="label-caps flex w-full items-center gap-1 px-3 pb-1.5 text-left !text-[10px] transition hover:text-fg-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
    >
      <ChevronRight
        aria-hidden="true"
        size={12}
        strokeWidth={2.4}
        className={cx('transition-transform', !props.folded && 'rotate-90')}
      />
      <span>{props.title}</span>
    </button>
  );
}

function NavItem(props: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  count?: { n: number; tone: string };
  title?: string;
  onClick: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = props.icon;
  return (
    <button
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      title={props.title}
      className={cx(
        'group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-[7px] text-left text-sm transition',
        props.active ? 'bg-white/7 text-fg' : 'text-fg-3 hover:bg-white/4 hover:text-fg-2',
      )}
    >
      {props.active && (
        <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-signal shadow-[0_0_10px_rgba(92,225,230,0.9)]" />
      )}
      <Icon
        size={16}
        className={props.active ? 'text-signal' : 'text-fg-4 group-hover:text-fg-3'}
        strokeWidth={2}
      />
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.count && props.count.n > 0 && (
        <span
          className="min-w-5 rounded-full px-1.5 text-center font-mono text-[11px] font-semibold"
          style={{
            color: props.count.tone,
            background: `color-mix(in oklab, ${props.count.tone} 15%, transparent)`,
          }}
        >
          {props.count.n}
        </span>
      )}
    </button>
  );
}
