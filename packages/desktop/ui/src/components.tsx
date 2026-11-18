import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { onWarnings } from './api';
import { modelWarning, suggestModels, useModelLists } from './lib/models';
import type { Task } from './types';
import { PriorityTag, StatusTag } from './ui/identity';

export {
  Avatar,
  Who,
  AgentTag,
  PriorityTag,
  StatusTag,
  StatusIcon,
  PriorityIcon,
} from './ui/identity';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'danger' | 'plain' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  icon?: LucideIcon;
}) {
  const kind = props.kind ?? 'plain';
  const Icon = props.icon;
  return (
    <button
      type={props.type ?? 'button'}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40',
        props.size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-[34px] px-3.5 text-sm',
        kind === 'primary' &&
          'bg-signal text-ink-950 shadow-[0_0_20px_-6px_rgba(92,225,230,0.8)] hover:bg-[#7debef]',
        kind === 'danger' && 'bg-bad/15 text-bad ring-1 ring-bad/30 ring-inset hover:bg-bad/25',
        kind === 'plain' &&
          'bg-white/6 text-fg-2 ring-1 ring-white/8 ring-inset hover:bg-white/10 hover:text-fg',
        kind === 'ghost' && 'text-fg-3 hover:bg-white/6 hover:text-fg',
      )}
    >
      {Icon && <Icon size={props.size === 'sm' ? 13 : 15} strokeWidth={2.2} />}
      {props.children}
    </button>
  );
}

/** Kept for older call sites: the status pill of a task. */
export function StatusBadge({ task }: { task: Task }) {
  return <StatusTag status={task.status} stale={task.stale} unblocked={task.unblocked} />;
}

/** Kept for older call sites: the priority with its display name. */
export function Priority({ p }: { p: string }) {
  return <PriorityTag p={p} />;
}

/** A designed empty state: an icon, what the page is for, and what to do next. */
export function Empty(props: {
  children?: ReactNode;
  icon?: LucideIcon;
  /** Shown in place of the icon tile, such as a `StatusLoop`. */
  art?: ReactNode;
  title?: string;
  action?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="animate-rise mx-auto flex max-w-md flex-col items-center px-6 py-14 text-center">
      {props.art && <div className="mb-4">{props.art}</div>}
      {Icon && !props.art && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-b from-white/8 to-white/2 ring-1 ring-white/10">
          <Icon size={24} className="text-signal" strokeWidth={1.8} />
        </div>
      )}
      {props.title && (
        <div className="font-display text-lg font-semibold tracking-wide">{props.title}</div>
      )}
      {props.children && (
        <div className="mt-1.5 text-sm leading-relaxed text-fg-3">{props.children}</div>
      )}
      {props.action && <div className="mt-5">{props.action}</div>}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="animate-fade flex items-start gap-2 rounded-lg border border-bad/25 bg-bad/8 px-3 py-2 text-sm text-[#ffb3ba]">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{error}</span>
    </div>
  );
}

const FIELD =
  'rounded-lg border border-white/10 bg-ink-950/60 px-2.5 text-sm outline-none transition placeholder:text-fg-4 focus:border-signal/60 focus:shadow-[0_0_0_3px_rgba(92,225,230,0.12)]';

export function Input(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  type?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onEnter?: () => void;
  /** The id of a `<datalist>` whose options the field suggests. */
  list?: string;
}) {
  return (
    <input
      type={props.type ?? 'text'}
      value={props.value}
      list={props.list}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && props.onEnter) props.onEnter();
      }}
      className={cx(FIELD, 'h-[34px]', props.disabled && 'opacity-60', props.className)}
    />
  );
}

/**
 * A model name field: suggests the provider's known models as you type and warns on a name that
 * is not one of them. The name still saves, so a model newer than the list works.
 */
export function ModelInput(props: {
  /** The provider, such as `claude` or `codex`. */
  runtime: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  onEnter?: () => void;
  /** Show the warning as an icon with a tooltip, for a field inside a row. */
  compact?: boolean;
}) {
  const id = useId();
  useModelLists();
  const options = suggestModels(props.runtime, props.value);
  const warning = modelWarning(props.runtime, props.value);
  return (
    <>
      <Input
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
        className={cx('font-mono', props.className)}
        onEnter={props.onEnter}
        list={id}
      />
      <datalist id={id}>
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {warning &&
        (props.compact ? (
          <span role="status" title={warning} aria-label={warning} className="text-warn">
            <AlertTriangle size={14} />
          </span>
        ) : (
          <span role="status" className="text-xs text-warn">
            {warning}
          </span>
        ))}
    </>
  );
}

export function TextArea(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      value={props.value}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      className={cx(FIELD, 'w-full resize-y py-2 leading-relaxed', props.className)}
    />
  );
}

export function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      className={cx(FIELD, 'h-[34px] pr-7', props.disabled && 'opacity-60', props.className)}
    >
      {props.options.map(([v, label]) => (
        <option key={v} value={v} className="bg-ink-850">
          {label}
        </option>
      ))}
    </select>
  );
}

/** A labeled field: the caps label above, the control below, and a hint under it. */
export function Field(props: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('flex flex-col gap-1.5', props.className)}>
      <span className="label-caps">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-xs text-fg-4">{props.hint}</span>}
    </label>
  );
}

export function Toggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      className="inline-flex items-center gap-2 text-sm text-fg-2"
    >
      <span
        className={cx(
          'relative h-5 w-9 rounded-full transition',
          props.checked ? 'bg-signal shadow-[0_0_12px_-3px_rgba(92,225,230,0.9)]' : 'bg-ink-600',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
            props.checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </span>
      {props.label}
    </button>
  );
}

/** Runs an async action, tracking busy and error state for a form. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<unknown>, after?: () => void) => void;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    clear: () => setError(null),
    run: (fn, after) => {
      setBusy(true);
      setError(null);
      fn().then(
        () => {
          setBusy(false);
          after?.();
        },
        (e: Error) => {
          setBusy(false);
          setError(e.message);
        },
      );
    },
  };
}

/**
 * A dialog. Escape, a click outside it and its close button close it. With `dirty` set (the
 * dialog holds typed input), they ask first, so a stray Escape never loses what was typed.
 * `stacked` shows it above other dialogs, such as Add agent opened from a picker in one; Escape
 * closes only the dialog on top.
 *
 * It renders in a portal on `document.body`, so no stacking context of the page draws over it
 * or catches its clicks: a Settings section's `animate-rise` keeps a filled `transform`, which
 * otherwise makes the section the dialog's layer (AO-0338). Focus moves into the dialog when it
 * opens, Tab and Shift+Tab stay inside the dialog on top, and focus goes back on close.
 */
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  icon?: LucideIcon;
  dirty?: boolean;
  stacked?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const self = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(self, box);
  const close = useRef<() => void>(() => {});
  close.current = (): void => {
    if (props.dirty) setAsking(true);
    else props.onClose();
  };
  useEffect(() => {
    if (!props.dirty) setAsking(false);
  }, [props.dirty]);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !onTop(self.current)) return;
      // A second Escape while asking keeps editing.
      if (asking) setAsking(false);
      else close.current();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [asking]);
  const Icon = props.icon;
  return createPortal(
    <div
      ref={self}
      data-modal
      data-stacked={props.stacked ? '' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      className={cx(
        'animate-fade fixed inset-0 flex items-center justify-center bg-black/65 backdrop-blur-[2px]',
        props.stacked ? 'z-[45]' : 'z-40',
      )}
      onMouseDown={() => close.current()}
    >
      <div
        ref={box}
        tabIndex={-1}
        className="animate-rise max-h-[90vh] outline-none max-w-[94vw] overflow-auto rounded-2xl border border-white/10 bg-ink-850 p-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
        style={{ width: props.width ?? 560 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2.5">
          {Icon && <Icon size={18} className="text-signal" />}
          <h2 className="font-display text-lg font-semibold tracking-wide">{props.title}</h2>
          <button
            className="ml-auto rounded-md p-1 text-fg-3 hover:bg-white/8 hover:text-fg"
            onClick={() => close.current()}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {asking && (
          <div
            role="alertdialog"
            aria-label="Discard what you typed?"
            className="mb-4 flex items-center gap-3 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn ring-1 ring-warn/30 ring-inset"
          >
            <span className="flex-1">Discard what you typed?</span>
            <Button size="sm" kind="ghost" onClick={() => setAsking(false)}>
              Keep editing
            </Button>
            <Button size="sm" kind="danger" onClick={props.onClose}>
              Discard
            </Button>
          </div>
        )}
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus in the dialog `modal` while it is the one on top. On open, focus moves to
 * `box` unless something inside already took it (an `autoFocus` field); on close, it goes back to
 * what had it. A list a picker opens from inside the dialog lives in its own portal
 * (`data-popover`), so focus there is left alone.
 */
function useFocusTrap(
  modal: RefObject<HTMLDivElement | null>,
  box: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (!modal.current?.contains(document.activeElement)) box.current?.focus();
    const key = (e: KeyboardEvent): void => {
      const el = modal.current;
      if (e.key !== 'Tab' || !el || !onTop(el)) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[data-popover]')) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (i) => !i.closest('[inert]'),
      );
      if (items.length === 0) {
        e.preventDefault();
        box.current?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = active instanceof Node && el.contains(active);
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === box.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (before?.isConnected) before.focus();
    };
  }, [modal, box]);
}

/** Whether `el` is the dialog on top: the last stacked one, else the last one in the page. */
function onTop(el: HTMLElement | null): boolean {
  const all = [...document.querySelectorAll('[data-modal]')];
  const stacked = all.filter((m) => m.hasAttribute('data-stacked'));
  const order = stacked.length > 0 ? stacked : all;
  return el !== null && order[order.length - 1] === el;
}

/** A view: icon and title in the display face, a line on what it is, actions on the right. */
export function Section(props: {
  title: string;
  icon?: LucideIcon;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-white/6 px-6 py-4">
        {Icon && (
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 ring-1 ring-white/10">
            <Icon size={18} className="text-signal" strokeWidth={2} />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="font-display text-xl leading-tight font-semibold tracking-wide">
            {props.title}
          </h1>
          {props.subtitle && <div className="truncate text-xs text-fg-3">{props.subtitle}</div>}
        </div>
        <div className="ml-auto flex items-center gap-2">{props.actions}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </section>
  );
}

/** A small number with a caps label, for view headers and stat rows. */
export function Stat(props: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="panel min-w-32 px-3.5 py-2.5" title={props.hint}>
      <div className="label-caps">{props.label}</div>
      <div className="mt-0.5 font-display text-2xl font-semibold" style={{ color: props.tone }}>
        {props.value}
      </div>
    </div>
  );
}

export interface ToastMsg {
  id: number;
  text: string;
  tone?: 'ok' | 'bad';
  action?: { label: string; run: () => void };
}

const toastListeners = new Set<(t: ToastMsg) => void>();
let toastSeq = 0;

/** Shows a short confirmation at the bottom of the window, with an optional action. */
export function toast(text: string, opts: Omit<ToastMsg, 'id' | 'text'> = {}): void {
  const t: ToastMsg = { id: ++toastSeq, text, ...opts };
  for (const fn of toastListeners) fn(t);
}

export function Toaster() {
  const [list, setList] = useState<ToastMsg[]>([]);
  useEffect(() => {
    const fn = (t: ToastMsg): void => {
      setList((l) => [...l.slice(-2), t]);
      // A warning needs reading and acting on, so it stays twice as long as a confirmation.
      const ms = t.tone === 'bad' ? 12000 : 6000;
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), ms);
    };
    toastListeners.add(fn);
    // Writes that swarmupd accepted with warnings (an owner, addressee or mention no agent answers
    // to) tell the poster at once, whichever view sent them.
    const offWarnings = onWarnings((warnings) => {
      for (const w of warnings) toast(w, { tone: 'bad' });
    });
    return () => {
      toastListeners.delete(fn);
      offWarnings();
    };
  }, []);
  if (list.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-[264px] z-50 flex flex-col items-start gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className="animate-rise pointer-events-auto flex items-center gap-3 rounded-xl border border-white/12 bg-ink-800 px-4 py-2.5 text-sm text-fg shadow-[0_20px_50px_-15px_rgba(0,0,0,0.9)]"
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: t.tone === 'bad' ? '#ff5d6c' : '#3ddc97' }}
          />
          {t.text}
          {t.action && (
            <button
              type="button"
              className="font-medium text-signal hover:underline"
              onClick={() => {
                t.action!.run();
                setList((l) => l.filter((x) => x.id !== t.id));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
