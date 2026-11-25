// The workflow editor's form edits the YAML text in place (W5): each field reads from the parsed
// document and writes one path back, so comments, key order and every key the form does not show
// stay as they are. The text is the one source; the form is a view of it.
import { parseDocument } from 'yaml';

/** A path into the document, such as `['stages', 0, 'gate', 'ask']`. */
export type YamlPath = Array<string | number>;

const TO_STRING = { lineWidth: 0 } as const;

/** The parsed value of workflow text, or why it does not parse. */
export function readWorkflowYaml(text: string): {
  value: Record<string, unknown> | null;
  error?: string;
} {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const line = e.linePos?.[0]?.line;
    return { value: null, error: `${line ? `line ${line}: ` : ''}${e.message.split('\n')[0]}` };
  }
  const v = doc.toJS() as unknown;
  if (v === null || v === undefined) return { value: {} };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { value: null, error: 'the file is not a map of keys' };
  }
  return { value: v as Record<string, unknown> };
}

/** Whether a form value means "leave the key out": empty text, an empty list, false or nothing. */
function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * `text` with `path` set to `value`, or with the key removed when the value is empty. Text that
 * does not parse comes back unchanged.
 */
export function setYaml(text: string, path: YamlPath, value: unknown): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return text;
  if (empty(value)) {
    if (doc.hasIn(path)) doc.deleteIn(path);
  } else if (typeof value === 'object') {
    // A list of plain values reads best on one line, as the templates write `after: [a, b]`.
    const flow = Array.isArray(value) && value.every((v) => typeof v !== 'object');
    doc.setIn(path, doc.createNode(value, { flow }));
  } else {
    doc.setIn(path, value);
  }
  return doc.toString(TO_STRING);
}

/** A comma list for a text field: `a, b`. */
export function listText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return (Array.isArray(v) ? v : [v]).map(String).join(', ');
}

/** A text field's comma list as values, blanks dropped. */
export function textList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** A list as lines for a text area, one value per line, for values that may hold commas. */
export function linesText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return (Array.isArray(v) ? v : [v]).map(String).join('\n');
}

/** A text area's lines as values, blanks dropped. */
export function textLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** A key for a new stage that no stage has yet: `stage-2`, `stage-3`. */
export function newStageKey(stages: unknown): string {
  const keys = new Set(
    (Array.isArray(stages) ? stages : []).map((s) =>
      s && typeof s === 'object' ? String((s as { key?: unknown }).key ?? '') : '',
    ),
  );
  let n = keys.size + 1;
  while (keys.has(`stage-${n}`)) n++;
  return `stage-${n}`;
}
