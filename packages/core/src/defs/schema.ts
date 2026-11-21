/**
 * A small schema language for definition files (`swarm.yaml`, agent frontmatter). One schema
 * both checks a parsed YAML document, with the file, key path, line and column of each problem,
 * and emits the JSON Schema (2020-12) that editors read. No dependency beyond `yaml`.
 */
import type { Document, LineCounter, Node } from 'yaml';
import YAML, { isAlias, isMap, isScalar, isSeq } from 'yaml';

export type Severity = 'error' | 'warning';

/** One problem in a definition file. `line` and `col` count from 1. */
export interface DefProblem {
  file: string;
  /** Key path such as `roles.engineer.per_project` or `tools[2]`; `(top)` for the document. */
  path: string;
  line: number;
  col: number;
  severity: Severity;
  message: string;
}

interface Base {
  /** What the value is for; the JSON Schema `description`. */
  doc?: string;
  /** `null` (an empty value in YAML) is allowed and means unset. */
  nullable?: boolean;
  /**
   * Accepted, but nothing reads it yet: a warning names when it applies. The value is not
   * checked further.
   */
  inactive?: string;
}

export type Schema =
  | (Base & { kind: 'str'; pattern?: RegExp; hint?: string; maxLength?: number })
  | (Base & { kind: 'int'; min?: number; max?: number })
  | (Base & { kind: 'num'; min?: number; max?: number })
  | (Base & { kind: 'bool' })
  | (Base & { kind: 'list'; items: Schema; maxItems?: number })
  | (Base & {
      kind: 'obj';
      props: Record<string, Schema>;
      required?: string[];
      /** Schema of the values of keys not in `props`: the object is a map by name. */
      additional?: Schema;
      /** Pattern every key of a map (`additional`) must match. */
      keyPattern?: RegExp;
      keyHint?: string;
      /** Keys refused with their own message, such as keys that belong in the user config. */
      refuse?: Record<string, string>;
    })
  | (Base & { kind: 'enum'; values: Array<string | number | boolean> })
  | (Base & { kind: 'oneOf'; options: Schema[] })
  | (Base & { kind: 'ref'; name: string; schema: () => Schema })
  | (Base & { kind: 'any' });

type Opts<K extends Schema['kind']> = Omit<Extract<Schema, { kind: K }>, 'kind'>;

export const str = (o: Opts<'str'> = {}): Schema => ({ kind: 'str', ...o });
export const int = (o: Opts<'int'> = {}): Schema => ({ kind: 'int', ...o });
export const num = (o: Opts<'num'> = {}): Schema => ({ kind: 'num', ...o });
export const bool = (o: Opts<'bool'> = {}): Schema => ({ kind: 'bool', ...o });
export const any = (o: Opts<'any'> = {}): Schema => ({ kind: 'any', ...o });
export const list = (items: Schema, o: Omit<Opts<'list'>, 'items'> = {}): Schema => ({
  kind: 'list',
  items,
  ...o,
});
export const obj = (props: Record<string, Schema>, o: Omit<Opts<'obj'>, 'props'> = {}): Schema => ({
  kind: 'obj',
  props,
  ...o,
});
/** A map from names (matching `keyPattern`) to values of one schema. */
export const map = (values: Schema, o: Omit<Opts<'obj'>, 'props' | 'additional'> = {}): Schema => ({
  kind: 'obj',
  props: {},
  additional: values,
  ...o,
});
export const enumOf = (
  values: Array<string | number | boolean>,
  o: Omit<Opts<'enum'>, 'values'> = {},
): Schema => ({ kind: 'enum', values, ...o });
export const oneOf = (options: Schema[], o: Omit<Opts<'oneOf'>, 'options'> = {}): Schema => ({
  kind: 'oneOf',
  options,
  ...o,
});
/** A named schema, emitted once under `$defs` and referred to by `$ref`. */
export const ref = (
  name: string,
  schema: () => Schema,
  o: Omit<Opts<'ref'>, 'name' | 'schema'> = {},
): Schema => ({ kind: 'ref', name, schema, ...o });

// ---- Checking ------------------------------------------------------------------------------------

export interface CheckOptions {
  /** The file name problems carry. */
  file: string;
  /** Unknown keys are errors instead of warnings. */
  strict?: boolean;
  /** Lines before the YAML text in the file, such as the `---` line of frontmatter. */
  lineOffset?: number;
}

interface Ctx extends CheckOptions {
  doc: Document;
  lc?: LineCounter;
  problems: DefProblem[];
}

/** A short name of what a schema accepts, for messages: `a whole number of at least 0`. */
export function describe(s: Schema): string {
  switch (s.kind) {
    case 'str':
      return s.hint ?? 'text';
    case 'int':
      return s.min !== undefined ? `a whole number of at least ${s.min}` : 'a whole number';
    case 'num':
      return s.min !== undefined ? `a number of at least ${s.min}` : 'a number';
    case 'bool':
      return 'true or false';
    case 'list':
      return `a list of ${plural(describe(s.items))}`;
    case 'obj':
      return s.additional ? 'one entry per name' : 'a set of `key: value` fields';
    case 'enum':
      return s.values.length === 1 ? String(s.values[0]) : `one of ${s.values.join(', ')}`;
    case 'oneOf':
      return s.options.map(describe).join(', or ');
    case 'ref':
      return describe(s.schema());
    case 'any':
      return 'any value';
  }
}

function plural(what: string): string {
  if (what === 'text') return 'texts';
  return what.replace(/^an? /, '');
}

function got(v: unknown): string {
  if (isMap(v)) return 'a set of fields';
  if (isSeq(v)) return 'a list';
  const value = isScalar(v) ? v.value : v;
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return 'text';
  return typeof value;
}

function posOf(ctx: Ctx, node: unknown): { line: number; col: number } {
  const offset = (node as Node | undefined)?.range?.[0];
  if (offset === undefined || !ctx.lc) return { line: 1 + (ctx.lineOffset ?? 0), col: 1 };
  const p = ctx.lc.linePos(offset);
  return { line: p.line + (ctx.lineOffset ?? 0), col: p.col };
}

function add(ctx: Ctx, at: unknown, path: string, severity: Severity, message: string): void {
  const { line, col } = posOf(ctx, at);
  ctx.problems.push({ file: ctx.file, path: path || '(top)', line, col, severity, message });
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

function resolveNode(ctx: Ctx, node: unknown): unknown {
  return isAlias(node) ? node.resolve(ctx.doc) : node;
}

/** The keys of `known` within two edits of `key`, closest first. */
function closest(key: string, known: string[]): string | undefined {
  let best: { k: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(key, k);
    if (d <= 2 && (!best || d < best.d)) best = { k, d };
  }
  return best?.k;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Checks `node` against `s`; returns false when it added an error. */
function check(s: Schema, raw: unknown, path: string, ctx: Ctx, at: unknown): boolean {
  const node = resolveNode(ctx, raw);
  const where = node ?? at;
  const value = isScalar(node) ? node.value : node;
  if (s.inactive !== undefined) {
    // At the key, which is what the reader looks for.
    add(ctx, at ?? where, path, 'warning', `accepted but not active yet: ${s.inactive}`);
    return true;
  }
  // A hint is a whole instruction (`name a model such as opus`); other kinds read as `use ...`.
  const expected = s.kind === 'str' && s.hint ? s.hint : `use ${describe(s)}`;
  if (value === null || value === undefined) {
    if (s.nullable || s.kind === 'any') return true;
    add(ctx, where, path, 'error', `${expected}; got nothing`);
    return false;
  }
  const fail = (message?: string): false => {
    add(ctx, where, path, 'error', message ?? `${expected}; got ${got(node)}`);
    return false;
  };
  switch (s.kind) {
    case 'any':
      return true;
    case 'str':
      if (typeof value !== 'string') return fail();
      if (s.maxLength !== undefined && value.length > s.maxLength) {
        return fail(`at most ${s.maxLength} characters`);
      }
      if (s.pattern && !s.pattern.test(value)) {
        return fail(`${s.hint ?? 'bad value'}; got '${value}'`);
      }
      return true;
    case 'int':
    case 'num': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail();
      if (s.kind === 'int' && !Number.isInteger(value)) return fail();
      if (s.min !== undefined && value < s.min) return fail(`use ${describe(s)}; got ${value}`);
      if (s.max !== undefined && value > s.max) return fail(`at most ${s.max}; got ${value}`);
      return true;
    }
    case 'bool':
      return typeof value === 'boolean' ? true : fail();
    case 'enum':
      return s.values.includes(value as string)
        ? true
        : fail(`use ${describe(s)}; got ${scalarText(value)}`);
    case 'list': {
      if (!isSeq(node)) return fail();
      if (s.maxItems !== undefined && node.items.length > s.maxItems) {
        return fail(`at most ${s.maxItems} entries`);
      }
      let ok = true;
      node.items.forEach((item, i) => {
        ok = check(s.items, item, `${path}[${i}]`, ctx, node) && ok;
      });
      return ok;
    }
    case 'obj':
      return checkObj(s, node, path, ctx, fail);
    case 'oneOf': {
      // The first option that adds no error wins; otherwise one message names them all.
      for (const option of s.options) {
        const trial: Ctx = { ...ctx, problems: [] };
        if (check(option, node, path, trial, at)) {
          ctx.problems.push(...trial.problems);
          return true;
        }
      }
      return fail();
    }
    case 'ref':
      return check(s.schema(), node, path, ctx, at);
  }
}

function scalarText(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

function checkObj(
  s: Extract<Schema, { kind: 'obj' }>,
  node: unknown,
  path: string,
  ctx: Ctx,
  fail: (m?: string) => false,
): boolean {
  if (!isMap(node)) return fail();
  let ok = true;
  const seen = new Set<string>();
  const known = Object.keys(s.props);
  for (const pair of node.items) {
    const keyNode = resolveNode(ctx, pair.key);
    const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
    seen.add(key);
    const keyPath = join(path, key);
    const refused = s.refuse?.[key];
    if (refused !== undefined) {
      add(ctx, keyNode, keyPath, 'error', refused);
      ok = false;
      continue;
    }
    const prop = Object.hasOwn(s.props, key) ? s.props[key] : undefined;
    if (prop) {
      ok = check(prop, pair.value, keyPath, ctx, keyNode) && ok;
      continue;
    }
    if (s.additional) {
      if (s.keyPattern && !s.keyPattern.test(key)) {
        add(ctx, keyNode, keyPath, 'error', `${s.keyHint ?? 'bad name'}; got '${key}'`);
        ok = false;
        continue;
      }
      ok = check(s.additional, pair.value, keyPath, ctx, keyNode) && ok;
      continue;
    }
    const near = closest(key, known);
    const message = near
      ? `unknown key '${key}'; did you mean '${near}'?`
      : `unknown key '${key}'; known keys: ${known.join(', ')}`;
    add(ctx, keyNode, keyPath, ctx.strict ? 'error' : 'warning', message);
    if (ctx.strict) ok = false;
  }
  for (const key of s.required ?? []) {
    if (!seen.has(key)) {
      add(ctx, node, path, 'error', `missing key '${key}'`);
      ok = false;
    }
  }
  return ok;
}

/** Line and column of the value at a key path, such as `['roles', 'qa', 'providers']`. */
export type Locate = (keys: Array<string | number>) => { line: number; col: number };

/** Result of {@link checkYaml}: the document and the plain value, with the problems found. */
export interface Checked {
  doc: Document;
  /** Where the value at a key path starts, or the nearest parent that exists; for later checks. */
  at: Locate;
  /** The document as plain data; undefined when it does not parse. */
  value: unknown;
  problems: DefProblem[];
}

/**
 * Parses YAML text and checks it against `schema`. Syntax errors come first, each with its line
 * and column; the schema is only checked when the text parses.
 */
export function checkYaml(schema: Schema, text: string, opts: CheckOptions): Checked {
  const lc = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const ctx: Ctx = { ...opts, doc, lc, problems: [] };
  for (const e of doc.errors) {
    const offset = e.pos?.[0];
    const p = offset !== undefined ? lc.linePos(offset) : { line: 1, col: 1 };
    ctx.problems.push({
      file: opts.file,
      path: '(top)',
      line: p.line + (opts.lineOffset ?? 0),
      col: p.col,
      severity: 'error',
      message: (e.message.split('\n')[0] ?? 'does not parse').replace(
        / at line \d+, column \d+:?$/,
        '',
      ),
    });
  }
  // The key of the deepest pair on the path that exists, or the document's start.
  const at: Locate = (keys) => {
    for (let n = keys.length; n > 0; n--) {
      const parent = resolveNode(
        ctx,
        n === 1 ? doc.contents : doc.getIn(keys.slice(0, n - 1), true),
      );
      if (!isMap(parent)) continue;
      const pair = parent.items.find((it) => {
        const k = resolveNode(ctx, it.key);
        return String(isScalar(k) ? k.value : k) === String(keys[n - 1]);
      });
      if (pair) return posOf(ctx, pair.key);
    }
    return posOf(ctx, doc.contents);
  };
  if (doc.errors.length > 0) return { doc, at, value: undefined, problems: ctx.problems };
  const contents = doc.contents;
  // An empty document is an empty set of fields.
  const root = contents === null ? new YAML.YAMLMap() : contents;
  check(schema, root, '', ctx, root);
  return { doc, at, value: doc.toJS() ?? {}, problems: ctx.problems };
}

/** Checks a plain value, such as parsed JSON; problems carry line 1, column 1. */
export function checkValue(schema: Schema, value: unknown, opts: CheckOptions): DefProblem[] {
  const doc = new YAML.Document(value);
  const ctx: Ctx = { ...opts, doc, problems: [] };
  check(schema, doc.contents, '', ctx, doc.contents);
  return ctx.problems;
}

/** `file:line:col: severity: path: message`, the way compilers print problems. */
export function formatProblem(p: DefProblem): string {
  return `${p.file}:${p.line}:${p.col}: ${p.severity}: ${p.path}: ${p.message}`;
}

// ---- JSON Schema ---------------------------------------------------------------------------------

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

type Json = Record<string, unknown>;

/** The JSON Schema (2020-12) of `s`, with named schemas under `$defs`. */
export function toJsonSchema(
  s: Schema,
  meta: { id: string; title: string; description?: string },
): Json {
  const defs: Record<string, Json> = {};
  const body = emit(s, defs);
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: meta.id,
    title: meta.title,
    ...(meta.description ? { description: meta.description } : {}),
    ...body,
    ...(Object.keys(defs).length > 0 ? { $defs: sortKeys(defs) } : {}),
  };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function emit(s: Schema, defs: Record<string, Json>): Json {
  const description = s.inactive !== undefined ? notActive(s) : s.doc;
  const out: Json = description ? { description } : {};
  if (s.inactive !== undefined) return out;
  let core: Json;
  switch (s.kind) {
    case 'any':
      return out;
    case 'str':
      core = {
        type: 'string',
        ...(s.pattern ? { pattern: s.pattern.source } : {}),
        ...(s.maxLength !== undefined ? { maxLength: s.maxLength } : {}),
      };
      break;
    case 'int':
    case 'num':
      core = {
        type: s.kind === 'int' ? 'integer' : 'number',
        ...(s.min !== undefined ? { minimum: s.min } : {}),
        ...(s.max !== undefined ? { maximum: s.max } : {}),
      };
      break;
    case 'bool':
      core = { type: 'boolean' };
      break;
    case 'enum':
      core = { enum: [...s.values] };
      break;
    case 'list':
      core = {
        type: 'array',
        items: emit(s.items, defs),
        ...(s.maxItems !== undefined ? { maxItems: s.maxItems } : {}),
      };
      break;
    case 'obj': {
      const props = Object.fromEntries(Object.entries(s.props).map(([k, v]) => [k, emit(v, defs)]));
      core = {
        type: 'object',
        ...(Object.keys(props).length > 0 ? { properties: props } : {}),
        ...(s.required && s.required.length > 0 ? { required: [...s.required] } : {}),
        ...(s.keyPattern ? { propertyNames: { pattern: s.keyPattern.source } } : {}),
        additionalProperties: s.additional ? emit(s.additional, defs) : false,
      };
      break;
    }
    case 'oneOf':
      core = { oneOf: s.options.map((o) => emit(o, defs)) };
      break;
    case 'ref':
      if (!defs[s.name]) {
        // A placeholder first, so a schema that refers to itself ends.
        defs[s.name] = {};
        defs[s.name] = emit(s.schema(), defs);
      }
      core = { $ref: `#/$defs/${s.name}` };
      break;
  }
  if (s.nullable) core = nullable(core);
  return { ...out, ...core };
}

function notActive(s: Schema): string {
  return `${s.doc ? `${s.doc} ` : ''}Accepted but not active yet: ${s.inactive}.`;
}

function nullable(core: Json): Json {
  if (typeof core.type === 'string') return { ...core, type: [core.type, 'null'] };
  if (Array.isArray(core.enum)) return { ...core, enum: [...(core.enum as unknown[]), null] };
  return { anyOf: [core, { type: 'null' }] };
}
