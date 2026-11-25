// Files a run kept (W4): a gallery of its images and a list of its other files, read through
// swarmupd (`GET /api/runs/:id/artifacts/:name?view=1`). The Runs view's run detail and the task
// panel's **Work** section show them. Nothing here runs a file: images show from a data URL,
// text shows as text, and every file has **Download**, which saves it where the person picks.
import { ChevronDown, ChevronRight, Download, File, FileText, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, bridge, q } from '../api';
import { cx, ErrorLine, toast } from '../components';
import type { RunArtifactView } from '../types';

/** What a list of kept files needs of each: the run record's brief, or a review artifact's. */
export interface KeptFile {
  name: string;
  label?: string;
  bytes: number;
  type: string;
}

/** A size for people: bytes, KB or MB. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isImage = (type: string): boolean => type.startsWith('image/');
const isText = (type: string): boolean =>
  type.startsWith('text/') || type === 'application/json' || type === 'application/xml';

/** One kept file as swarmupd sends it for display, fetched while `on`. */
function useView(run: string, name: string, on: boolean) {
  const [data, setData] = useState<RunArtifactView>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api<RunArtifactView>('GET', `/api/runs/${q(run)}/artifacts/${q(name)}?view=1`).then(
      (d) => live && setData(d),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [run, name, on]);
  return { data, error };
}

/**
 * **Download**: saves the kept file where the person picks, through the main process, which
 * reads its bytes from swarmupd. Closing the save dialog does nothing.
 */
export function DownloadButton({
  run,
  name,
  label = false,
}: {
  run: string;
  name: string;
  /** Shows the word next to the icon. */
  label?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await bridge().saveArtifact(run, name);
      if (res.ok) toast(`Saved ${name} to ${res.data?.file ?? 'the folder you picked'}`);
      else if (res.error !== 'cancelled') {
        toast(`Cannot save ${name}: ${res.error ?? 'unknown error'}`, { tone: 'bad' });
      }
    } catch (err) {
      toast(`Cannot save ${name}: ${err instanceof Error ? err.message : String(err)}`, {
        tone: 'bad',
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      data-run-artifact-download={name}
      disabled={busy}
      onClick={() => void save()}
      title={`Download ${name}`}
      aria-label={label ? undefined : `Download ${name}`}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-md text-fg-3 hover:bg-white/6 hover:text-fg disabled:opacity-40',
        label ? 'h-7 px-2.5 text-xs ring-1 ring-white/8 ring-inset' : 'p-1',
      )}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
      {label && 'Download'}
    </button>
  );
}

function Reading() {
  return (
    <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-fg-3">
      <Loader2 size={12} className="animate-spin text-signal" /> reading…
    </div>
  );
}

/** One image of the gallery; a click shows it at full width. */
function KeptImage({ run, file }: { run: string; file: KeptFile }) {
  const { data, error } = useView(run, file.name, true);
  const [big, setBig] = useState(false);
  return (
    <figure
      data-run-artifact={file.name}
      className={cx(
        'overflow-hidden rounded-lg border border-white/8 bg-black/20',
        big && 'col-span-full',
      )}
    >
      {error ? (
        <div className="p-2">
          <ErrorLine error={error} />
        </div>
      ) : data?.data ? (
        <button
          type="button"
          onClick={() => setBig(!big)}
          className="block w-full"
          title={big ? 'Show smaller' : 'Show at full width'}
        >
          <img
            data-run-artifact-image={file.name}
            src={data.data}
            alt={file.label ?? file.name}
            className={cx('w-full object-contain', big ? 'max-h-none' : 'max-h-48')}
          />
        </button>
      ) : data ? (
        <div className="flex flex-col items-start gap-1.5 p-2 text-xs text-fg-3">
          Too large to show here.
          <DownloadButton run={run} name={file.name} label />
        </div>
      ) : (
        <Reading />
      )}
      <figcaption className="flex items-center gap-2 px-2 py-1 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono text-fg-2" title={file.name}>
          {file.label ?? file.name}
        </span>
        <span className="shrink-0 text-fg-4">{sizeText(file.bytes)}</span>
        <DownloadButton run={run} name={file.name} />
      </figcaption>
    </figure>
  );
}

/** One other file: a row that opens to its text, or to Download for a file it cannot show. */
function KeptRow({ run, file }: { run: string; file: KeptFile }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useView(run, file.name, open);
  const Icon = isText(file.type) ? FileText : File;
  return (
    <li
      data-run-artifact={file.name}
      className="rounded-lg border border-white/7 bg-white/[0.02] text-sm"
    >
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left hover:bg-white/[0.03]"
        >
          {open ? (
            <ChevronDown size={13} className="text-fg-4" />
          ) : (
            <ChevronRight size={13} className="text-fg-4" />
          )}
          <Icon size={13} className="shrink-0 text-fg-4" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">
            {file.name}
          </span>
          {file.label && <span className="truncate text-xs text-fg-4">{file.label}</span>}
          <span className="shrink-0 font-mono text-[11px] text-fg-4">
            {file.type} · {sizeText(file.bytes)}
          </span>
        </button>
        <DownloadButton run={run} name={file.name} />
      </div>
      {open && (
        <div className="px-3 pb-2">
          {error ? (
            <ErrorLine error={error} />
          ) : !data ? (
            <Reading />
          ) : data.kind === 'text' ? (
            <>
              <pre
                data-run-artifact-text
                className="max-h-[24rem] overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[12px] whitespace-pre-wrap text-fg-2"
              >
                {data.text}
              </pre>
              {data.cut && (
                <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-4">
                  Cut at 256 KB; download it for the whole file.
                  <DownloadButton run={run} name={file.name} label />
                </div>
              )}
            </>
          ) : (
            <div
              data-run-artifact-file
              className="flex flex-wrap items-center gap-2 text-xs text-fg-3"
              title={`Kept at ${data.file}`}
            >
              <span>The app does not show this kind of file. Download it to open it.</span>
              <DownloadButton run={run} name={file.name} label />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** A run's kept files: its images as a gallery, then its other files as a list. */
export function RunArtifacts({ run, items }: { run: string; items: readonly KeptFile[] }) {
  const images = items.filter((a) => isImage(a.type) && a.type !== 'image/svg+xml');
  const files = items.filter((a) => !images.includes(a));
  return (
    <div data-run-artifacts={run} className="flex flex-col gap-2">
      {images.length > 0 && (
        <div data-run-gallery className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {images.map((a) => (
            <KeptImage key={a.name} run={run} file={a} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul data-run-files className="flex flex-col gap-1.5">
          {files.map((a) => (
            <KeptRow key={a.name} run={run} file={a} />
          ))}
        </ul>
      )}
    </div>
  );
}
