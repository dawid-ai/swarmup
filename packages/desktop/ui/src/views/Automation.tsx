import {
  Power,
  PowerOff,
  RotateCw,
  ScrollText,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  Webhook,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { api, refreshSoon, useData } from '../api';
import { Button, Empty, ErrorLine, Modal, Section, Toggle, useAction, cx } from '../components';
import { ago, localTime } from '../lib/format';
import type { AutomationRoot, AutomationTrigger, AutomationView, TrustState } from '../types';

/** The status line of a root's triggers, and its tone. */
export function rootStatus(r: AutomationRoot): { text: string; tone: string } {
  switch (r.status) {
    case 'off':
      return { text: 'Off on this machine: none of its triggers fires here', tone: 'text-fg-3' };
    case 'none':
      return { text: 'On here; the store has no triggers yet', tone: 'text-fg-3' };
    case 'untrusted':
      return { text: 'On but not trusted: nothing fires until you trust it', tone: 'text-warn' };
    case 'changed':
      return {
        text: 'Changed since you trusted it: nothing fires until you review it again',
        tone: 'text-warn',
      };
    case 'trusted':
      return { text: 'Trusted: fires as listed', tone: 'text-ok' };
  }
}

const TRUST_TEXT: Record<TrustState, string> = {
  none: 'none',
  trusted: 'trusted',
  untrusted: 'not trusted',
  changed: 'changed since trusted',
};

/** Whether a root has a set to trust that this machine does not trust as it stands. */
const needsTrust = (r: AutomationRoot): boolean =>
  r.trust === 'untrusted' ||
  r.trust === 'changed' ||
  r.checks?.trust === 'untrusted' ||
  r.checks?.trust === 'changed';

/** Whether this machine keeps any trust for the root, current or stale. */
const hasTrust = (r: AutomationRoot): boolean =>
  r.trust === 'trusted' ||
  r.trust === 'changed' ||
  r.checks?.trust === 'trusted' ||
  r.checks?.trust === 'changed';

/**
 * Automation: what git may start on this machine. Each root's git triggers and merge checks with
 * the machine's consent and trust, and the inbound webhook listener. Every change is a person's.
 */
export function Automation({ nav }: { nav: Nav }) {
  const { data, error, set } = useData<AutomationView>('/api/automation');
  const act = useAction();
  const [review, setReview] = useState<AutomationRoot | null>(null);
  const [direct, setDirect] = useState<AutomationTrigger | null>(null);
  const post = (path: string, body: Record<string, unknown>, after?: () => void): void =>
    act.run(async () => {
      const v = await api<AutomationView>('POST', path, { as: nav.me, ...body });
      if (v && Array.isArray(v.roots)) set(v);
      refreshSoon();
    }, after);
  const hookTriggers = (data?.roots ?? []).flatMap((r) => r.triggers.filter((t) => t.webhook));
  return (
    <Section
      title="Automation"
      icon={Zap}
      subtitle="What git may start on this machine: triggers, merge checks and inbound webhooks"
    >
      <div className="flex flex-col gap-4 p-6">
        <ErrorLine error={error ?? act.error} />
        {data && data.roots.length === 0 && (
          <Empty icon={Zap} title="No projects">
            Add a project first. Its <code>triggers/*.yaml</code> and the merge checks in its{' '}
            <code>swarm.yaml</code> show here.
          </Empty>
        )}
        {(data?.roots ?? []).map((r) => (
          <RootCard
            key={r.root}
            r={r}
            busy={act.busy}
            onTurn={(on) => post('/api/automation/triggers', { root: r.root, on })}
            onReview={() => setReview(r)}
            onRevoke={() => post('/api/automation/revoke', { root: r.root })}
          />
        ))}
        {data && (
          <HooksCard
            view={data}
            triggers={hookTriggers}
            busy={act.busy}
            onEnable={(enabled) => post('/api/automation/hooks', { enabled })}
            onDirect={(t, on) =>
              on
                ? setDirect(t)
                : post('/api/automation/direct', { root: t.root, trigger: t.name, on: false })
            }
          />
        )}
      </div>
      {review && (
        <ReviewDialog
          r={review}
          busy={act.busy}
          error={act.error}
          onClose={() => setReview(null)}
          onTrust={() =>
            post(
              '/api/automation/trust',
              { root: review.root, triggers: review.hash, checks: review.checks?.hash ?? null },
              () => setReview(null),
            )
          }
        />
      )}
      {direct && (
        <DirectDialog
          t={direct}
          busy={act.busy}
          error={act.error}
          onClose={() => setDirect(null)}
          onApprove={() =>
            post(
              '/api/automation/direct',
              { root: direct.root, trigger: direct.name, on: true },
              () => setDirect(null),
            )
          }
        />
      )}
    </Section>
  );
}

function RootCard(props: {
  r: AutomationRoot;
  busy: boolean;
  onTurn: (on: boolean) => void;
  onReview: () => void;
  onRevoke: () => void;
}) {
  const { r } = props;
  const status = rootStatus(r);
  const something = r.hash !== null || r.checks !== null;
  return (
    <section className="panel animate-rise" data-root={r.root}>
      <header className="flex flex-wrap items-center gap-3 border-b border-white/6 px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold tracking-wide">{r.root}</h2>
          <div className={cx('text-xs', status.tone)} data-testid="root-status">
            {status.text}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {r.on ? (
            <Button
              size="sm"
              icon={PowerOff}
              disabled={props.busy}
              onClick={() => props.onTurn(false)}
            >
              Turn off
            </Button>
          ) : (
            <Button size="sm" icon={Power} disabled={props.busy} onClick={() => props.onTurn(true)}>
              Turn on here
            </Button>
          )}
          {something && (
            <Button
              size="sm"
              kind={needsTrust(r) ? 'primary' : 'plain'}
              icon={ShieldCheck}
              disabled={props.busy || Boolean(r.swarm_error)}
              onClick={props.onReview}
            >
              Review and trust
            </Button>
          )}
          {hasTrust(r) && (
            <Button
              size="sm"
              kind="ghost"
              icon={ShieldOff}
              disabled={props.busy}
              onClick={props.onRevoke}
            >
              Revoke trust
            </Button>
          )}
        </div>
      </header>
      <div className="flex flex-col gap-3 px-5 py-4 text-sm">
        {r.swarm_error && <div className="text-xs text-bad">{r.swarm_error}</div>}
        {r.broken > 0 && (
          <div className="text-xs text-warn">
            {r.broken} trigger file(s) have errors: they are never trusted and never fire
          </div>
        )}
        {r.triggers.length === 0 ? (
          <div className="text-xs text-fg-3">
            No triggers. Add <code>triggers/&lt;name&gt;.yaml</code> to the store to start runs,
            workflows or repeats on a schedule or a webhook.
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-fg-4">
              <tr>
                <th className="py-1 pr-3 font-medium">Trigger</th>
                <th className="py-1 pr-3 font-medium">When</th>
                <th className="py-1 pr-3 font-medium">Action</th>
                <th className="py-1 pr-3 font-medium">Runs on</th>
                <th className="py-1 font-medium">Here</th>
              </tr>
            </thead>
            <tbody>
              {r.triggers.map((t) => (
                <tr key={t.name} className="border-t border-white/5 align-top">
                  <td className="py-1.5 pr-3 font-mono text-fg">{t.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-fg-2">{t.when || 'has errors'}</td>
                  <td className="py-1.5 pr-3 font-mono text-fg-2">{t.target}</td>
                  <td className="py-1.5 pr-3 text-fg-3">
                    {t.runs_on ? t.runs_on.join(', ') : 'any machine'}
                  </td>
                  <td className="py-1.5">
                    <HereText t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="text-xs text-fg-3" data-testid="checks-line">
          {r.checks ? (
            <>
              {r.checks.checks.length} merge check(s) in <code>swarm.yaml</code>:{' '}
              <span className={r.checks.trust === 'trusted' ? 'text-ok' : 'text-warn'}>
                {TRUST_TEXT[r.checks.trust]}
              </span>
              {r.checks.trust !== 'trusted' && '; merges skip them until you trust them'}
            </>
          ) : (
            <>
              <code>swarm.yaml</code> names no merge checks
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function HereText({ t }: { t: AutomationTrigger }) {
  if (!t.here) return <span className="text-fg-3">{t.why}</span>;
  const hook = t.hook
    ? t.hook === 'direct'
      ? 'each delivery runs the action'
      : 'each delivery files a finding'
    : '';
  const next = t.next_fire
    ? `next ${Date.parse(t.next_fire) <= Date.now() + 60_000 ? 'tick' : ago(t.next_fire)}`
    : '';
  return (
    <span className="text-signal">
      {[next, hook].filter(Boolean).join('; ') || 'fires here'}
      {t.last_fire && <span className="text-fg-4"> · last {ago(t.last_fire)}</span>}
    </span>
  );
}

function HooksCard(props: {
  view: AutomationView;
  triggers: AutomationTrigger[];
  busy: boolean;
  onEnable: (on: boolean) => void;
  onDirect: (t: AutomationTrigger, on: boolean) => void;
}) {
  const h = props.view.hooks;
  const restart = useAction();
  const [restarted, setRestarted] = useState<string | null>(null);
  const canRestart = typeof window !== 'undefined' && Boolean(window.swarmup?.service);
  const listener =
    h.listener === 'listening'
      ? { text: `Listening on ${h.at?.host}:${h.at?.port}`, tone: 'text-ok' }
      : h.listener === 'failed'
        ? { text: `Could not listen on ${h.host}:${h.port}: ${h.error}`, tone: 'text-bad' }
        : { text: 'Off', tone: 'text-fg-3' };
  return (
    <section className="panel animate-rise" data-testid="hooks-card">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/6 px-5 py-3.5">
        <Webhook size={18} className="text-signal" />
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold tracking-wide">Inbound webhooks</h2>
          <div className={cx('text-xs', listener.tone)} data-testid="listener-status">
            {listener.text}
          </div>
        </div>
        <div className="ml-auto">
          <Toggle
            checked={h.enabled}
            onChange={(v) => !props.busy && props.onEnable(v)}
            label="Listener"
          />
        </div>
      </header>
      <div className="flex flex-col gap-4 px-5 py-4 text-sm">
        <div className="text-xs text-fg-3">
          The listener takes signed <code>POST /hooks/&lt;root&gt;/&lt;trigger&gt;</code> deliveries
          on <code>{`${h.host}:${h.port}`}</code>, apart from the API. Give senders a public URL
          through your own tunnel to it.
        </div>
        {h.restart && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
            <span>
              {h.enabled
                ? 'The listener is on in the config, but swarmupd started without it.'
                : 'The listener is off in the config, but the running swarmupd still listens.'}{' '}
              A swarmupd restart applies it.
            </span>
            {canRestart && (
              <Button
                size="sm"
                icon={RotateCw}
                disabled={restart.busy}
                onClick={() =>
                  restart.run(async () => {
                    const res = await window.swarmup!.service('restart');
                    if (!res.ok) throw new Error(res.error ?? 'restart failed');
                    setRestarted(res.data?.note ?? 'swarmupd restarted');
                    refreshSoon();
                  })
                }
              >
                Restart swarmupd
              </Button>
            )}
          </div>
        )}
        {restarted && <div className="text-xs text-ok">{restarted}</div>}
        <ErrorLine error={restart.error} />
        {props.triggers.length === 0 ? (
          <div className="text-xs text-fg-3">
            No trigger has a <code>webhook</code> section.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {props.triggers.map((t) => (
              <div
                key={`${t.root}/${t.name}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/3 px-3 py-2 text-xs"
                data-hook={`${t.root}/${t.name}`}
              >
                <span className="font-mono text-fg">
                  {t.root}/{t.name}
                </span>
                <span className="text-fg-3">
                  verify <span className="font-mono text-fg-2">{t.webhook!.verify}</span>
                </span>
                <span className="text-fg-3">
                  secret <span className="font-mono text-fg-2">{t.webhook!.secret}</span>{' '}
                  {t.webhook!.secret_ok ? (
                    <span className="text-ok">present</span>
                  ) : (
                    <span className="text-warn">{t.webhook!.secret_why ?? 'missing'}</span>
                  )}
                </span>
                <span className="ml-auto">
                  <Toggle
                    checked={t.webhook!.direct}
                    onChange={(v) => !props.busy && props.onDirect(t, v)}
                    label="Direct action"
                  />
                </span>
              </div>
            ))}
            <div className="text-xs text-fg-4">
              Without <strong>Direct action</strong>, a verified delivery files a finding for
              triage. With it, the delivery runs the trigger&apos;s action on this machine.
            </div>
          </div>
        )}
        <div>
          <div className="label-caps mb-1 flex items-center gap-1.5">
            <ScrollText size={12} /> hooks.log
          </div>
          {h.log.length === 0 ? (
            <div className="text-xs text-fg-4">No deliveries yet</div>
          ) : (
            <div className="max-h-64 overflow-auto rounded-lg bg-ink-950/60 p-2 font-mono text-[11px] leading-5">
              {h.log.map((l, i) => (
                <div key={i} className={l.status === 'refused' ? 'text-warn' : 'text-fg-2'}>
                  {localTime(l.at)} {l.code} {l.root ?? '-'}/{l.trigger ?? '-'} {l.status}
                  {l.reason ? `: ${l.reason}` : ''}
                  {l.effect ? ` → ${l.effect}` : ''}
                  {l.ref ? ` ${l.ref}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ReviewDialog(props: {
  r: AutomationRoot;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onTrust: () => void;
}) {
  const { r } = props;
  const triggers = r.triggers.filter((t) => t.fields.length > 0);
  const broken = r.triggers.filter((t) => t.fields.length === 0);
  return (
    <Modal
      title={`Review and trust ${r.root}`}
      icon={ShieldCheck}
      onClose={props.onClose}
      width={720}
    >
      <div className="flex flex-col gap-4 text-sm">
        <div className="text-xs text-fg-3">
          Trusting lets this machine run exactly what is listed here. Any change to a trigger or a
          merge check in git untrusts it until you review it again.
        </div>
        <div>
          <div className="label-caps mb-1">
            Triggers ({triggers.length}) · {TRUST_TEXT[r.trust]}
            {r.hash && <span className="ml-2 font-mono normal-case">{r.hash.slice(0, 14)}</span>}
          </div>
          {triggers.length === 0 && <div className="text-xs text-fg-4">No triggers</div>}
          <div className="flex flex-col gap-2" data-testid="review-triggers">
            {triggers.map((t) => (
              <div key={t.name} className="rounded-lg bg-ink-950/60 p-2.5">
                <div className="font-mono text-xs font-semibold text-fg">{t.name}</div>
                <pre className="mt-1 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words text-fg-2">
                  {t.fields.map(([k, v]) => `${k}: ${v}`).join('\n')}
                </pre>
              </div>
            ))}
          </div>
          {broken.length > 0 && (
            <div className="mt-2 text-xs text-warn">
              Not trusted, with errors: {broken.map((t) => t.name).join(', ')}
            </div>
          )}
        </div>
        <div>
          <div className="label-caps mb-1">
            Merge checks ({r.checks?.checks.length ?? 0})
            {r.checks && ` · ${TRUST_TEXT[r.checks.trust]}`}
            {r.checks && (
              <span className="ml-2 font-mono normal-case">{r.checks.hash.slice(0, 14)}</span>
            )}
          </div>
          {!r.checks && <div className="text-xs text-fg-4">swarm.yaml names no merge checks</div>}
          <div className="flex flex-col gap-1" data-testid="review-checks">
            {r.checks?.checks.map((c) => (
              <div
                key={c.name}
                className="rounded-lg bg-ink-950/60 px-2.5 py-1.5 font-mono text-[11px]"
              >
                <span className="text-fg-3">{c.name}: </span>
                <span className="text-fg">{c.run}</span>
                {c.paths.length > 0 && (
                  <span className="text-fg-4"> (when it changes {c.paths.join(', ')})</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <ErrorLine error={props.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button kind="primary" icon={ShieldCheck} disabled={props.busy} onClick={props.onTrust}>
            Trust these on this machine
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DirectDialog(props: {
  t: AutomationTrigger;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onApprove: () => void;
}) {
  const { t } = props;
  return (
    <Modal
      title={`Direct action for ${t.root}/${t.name}`}
      icon={TriangleAlert}
      onClose={props.onClose}
      width={560}
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
          Each verified delivery runs <code>{t.target}</code> on this machine at once, instead of
          filing a finding for you to triage. Anyone who holds the secret{' '}
          <code>{t.webhook?.secret}</code> can start it. The payload reaches the run only as fenced
          untrusted text, but its content still steers what the run reads.
        </div>
        <div className="text-xs text-fg-3">
          Approve only for a sender you control. You can turn it off here at any time.
        </div>
        <ErrorLine error={props.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button kind="danger" disabled={props.busy} onClick={props.onApprove}>
            Approve direct actions
          </Button>
        </div>
      </div>
    </Modal>
  );
}
