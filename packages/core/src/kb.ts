import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { OpsError } from './ids.js';
import type { Root } from './root.js';
import { slugify } from './units.js';

/** Frontmatter of `kb/<topic>/<slug>.md`. */
export interface KbMeta {
  title: string;
  topic: string;
  author: string;
  created_at: string;
  /** The task the lesson came from. */
  task?: string;
  tags?: string[];
}

export interface KbNote extends KbMeta {
  root: string;
  slug: string;
  /** `<topic>/<slug>`, the note's id. */
  ref: string;
  file: string;
  body: string;
}

export interface KbHit {
  note: KbNote;
  score: number;
}

/** Checks a topic name and returns its canonical form. */
export function kbTopic(topic: string): string {
  const t = slugify(topic, 40);
  if (!t) throw new OpsError(`bad topic '${topic}': use letters, digits and hyphens`, 2);
  return t;
}

/** Writes a new learn note. A title that is taken gets a numbered slug. */
export function writeNote(root: Root, meta: KbMeta, body: string): KbNote {
  const topic = kbTopic(meta.topic);
  const base = slugify(meta.title) || 'note';
  const kb = join(root.dir, 'kb');
  const dir = join(kb, topic);
  // Check each level before creating anything in it, so nothing lands behind a link.
  const ensure = (path: string, name: string): void => {
    if (!existsSync(path)) mkdirSync(path);
    if (!plain(path, 'dir')) {
      throw new OpsError(`${name} is a link; learn notes go in a real folder`, 2);
    }
  };
  ensure(kb, 'kb');
  ensure(dir, `kb/${topic}`);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const file = join(dir, `${slug}.md`);
    try {
      // Reserve the name first, so two writers never pick the same slug.
      closeSync(openSync(file, 'wx'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    const full: KbMeta = { ...meta, topic };
    root.writeAtomic(file, stringifyDoc(full, body));
    return { ...full, root: root.name, slug, ref: `${topic}/${slug}`, file, body: body.trim() };
  }
}

/** True for a real folder or file, never a link: links in a synced repo could point anywhere. */
function plain(path: string, kind: 'dir' | 'file'): boolean {
  try {
    const s = lstatSync(path);
    return kind === 'dir' ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

/** One note file found by `noteFiles`. */
export interface NoteFile {
  topic: string;
  slug: string;
  file: string;
}

/** Note files in the root's `kb/` folder, or in one topic. Symlinks and junctions are skipped. */
export function noteFiles(root: Root, topic?: string): NoteFile[] {
  const kb = join(root.dir, 'kb');
  if (!plain(kb, 'dir')) return [];
  const topics = topic
    ? [kbTopic(topic)]
    : readdirSync(kb, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
  const out: NoteFile[] = [];
  for (const t of topics) {
    const dir = join(kb, t);
    if (!plain(dir, 'dir')) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = join(dir, name);
      if (plain(file, 'file')) out.push({ topic: t, slug: name.slice(0, -3), file });
    }
  }
  return out;
}

/** Reads one note file found by `noteFiles`. */
export function readNote(root: Root, f: NoteFile): KbNote {
  const doc = parseDoc<Partial<KbMeta>>(readFileSync(f.file, 'utf8'));
  return {
    title: doc.data.title ?? f.slug,
    topic: f.topic,
    author: doc.data.author ?? '',
    created_at: doc.data.created_at ?? '',
    task: doc.data.task,
    tags: doc.data.tags,
    root: root.name,
    slug: f.slug,
    ref: `${f.topic}/${f.slug}`,
    file: f.file,
    body: doc.body.trim(),
  };
}

/** Every note in the root's `kb/` folder, or in one topic. Symlinks and junctions are skipped. */
export function readNotes(root: Root, topic?: string): KbNote[] {
  return noteFiles(root, topic).map((f) => readNote(root, f));
}

/**
 * Ranks notes that contain every word (case-insensitive) in the title, tags, topic or body. A hit
 * in the title or tags counts more than one in the body. No words lists every note, newest first.
 */
export function searchNotes(notes: KbNote[], words: string[]): KbHit[] {
  const terms = words.map((w) => w.toLowerCase()).filter(Boolean);
  const hits: KbHit[] = [];
  for (const note of notes) {
    const head = `${note.title} ${(note.tags ?? []).join(' ')} ${note.topic}`.toLowerCase();
    const body = note.body.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inHead = head.includes(t);
      const bodyCount = body.split(t).length - 1;
      if (!inHead && bodyCount === 0) {
        all = false;
        break;
      }
      score += (inHead ? 5 : 0) + Math.min(bodyCount, 5);
    }
    if (all) hits.push({ note, score });
  }
  return hits.sort((a, b) => b.score - a.score || (a.note.created_at < b.note.created_at ? 1 : -1));
}

/**
 * Words too common in task text to say what a task is about. Words under four letters are
 * dropped before this list applies.
 */
const COMMON = new Set(
  (
    'about after again agent also because been before being both cannot could does done each every ' +
    'first from have here into just like make made more most must need needs never note notes ' +
    'only other over same should some such task tasks than that their them then there these ' +
    'they this those through today under until very want were what when where which while ' +
    'will with without would your'
  ).split(' '),
);

/** The distinct words of a text that can say what it is about, lowercased, plural `s` dropped. */
export function topicWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 4 || /^\d+$/.test(raw) || COMMON.has(raw)) continue;
    const word =
      raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    if (!COMMON.has(word)) out.add(word);
  }
  return out;
}

/**
 * Fewest points a note needs to count as related; see `relatedNotes`. One rare word in the task
 * title and the note title scores just under 6, so a note needs a little more than that.
 */
export const RELATED_MIN_SCORE = 7;

/**
 * Learn notes that may apply to a task, best first (AO-0049). Unlike `searchNotes`, any word may
 * match. Each word has a weight from 0 to 1 for how rare it is among the notes and `corpus` (such
 * as every task title), so words most of them share, like `run` in a store about runs, count for
 * little. A word in the note's title, tags or topic scores 6 times its weight when it is in the
 * task title, 3 times when only in the task body; a task-title word only in the note body scores
 * once. Body-to-body overlap scores nothing: long texts share words by chance. A note needs a
 * title, tag or topic hit and `RELATED_MIN_SCORE` points. Ties go to the newer note.
 */
export function relatedNotes(
  notes: KbNote[],
  task: { title: string; body?: string },
  opts: { limit?: number; corpus?: string[] } = {},
): KbHit[] {
  const limit = opts.limit ?? 5;
  const titleWords = topicWords(task.title);
  const words = new Set([...titleWords, ...topicWords(task.body ?? '')]);
  if (words.size === 0 || limit <= 0 || notes.length === 0) return [];
  const read = notes.map((note) => ({
    note,
    head: topicWords(`${note.title} ${(note.tags ?? []).join(' ')} ${note.topic}`),
    body: topicWords(note.body),
  }));
  const frequency = new Map<string, number>();
  const count = (found: Iterable<string>): void => {
    for (const word of found) {
      if (words.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  };
  for (const item of read) count(new Set([...item.head, ...item.body]));
  const corpus = opts.corpus ?? [];
  for (const document of corpus) count(topicWords(document));
  const documents = notes.length + corpus.length;
  // One spare document in the count, so a word in every one still weighs a little; dividing by
  // the weight of a word in one document keeps the points the same for small and large stores.
  const top = Math.log(documents + 1);
  const weight = (word: string): number =>
    Math.log((documents + 1) / (frequency.get(word) ?? 1)) / top;
  const hits: KbHit[] = [];
  for (const item of read) {
    let score = 0;
    let inHead = false;
    for (const word of words) {
      const inTitle = titleWords.has(word);
      if (item.head.has(word)) {
        inHead = true;
        score += (inTitle ? 6 : 3) * weight(word);
      } else if (inTitle && item.body.has(word)) {
        score += weight(word);
      }
    }
    if (inHead && score >= RELATED_MIN_SCORE) {
      hits.push({ note: item.note, score: Math.round(score * 100) / 100 });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.note.created_at < b.note.created_at ? 1 : -1));
  return hits.slice(0, limit);
}
