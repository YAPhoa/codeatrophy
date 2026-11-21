import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Pencil, PlugZap, Plus, Power, Sparkles, Star, Trash2, XCircle } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateAi, qk, useAiSettings, useLimits } from '../../api/queries';
import type { AiProvider, AiProviderKind, AiSettings, AiTestResponse, Meta } from '../../api/types';
import { aiLogPath } from '../../lib/aiLog';
import { errorLine, sentence } from '../../lib/errors';
import { absoluteTime, formatMs, plural, relativeTime } from '../../lib/format';
import { titleIfCut } from '../../lib/titleIfCut';
import { Button, IconButton, cx } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Badge, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { AiProviderDialog } from './AiProviderDialog';
import { customHost, kindName, listNeeds, modelInEffect, needsOf } from './aiProviders';
import { readTimeout } from './aiTimeout';
import { SaveStatus, type SaveState } from './PreferencesSection';

/** The outcome of a connection test started from the list, for the provider as it was at `stamp`. */
interface RowTest {
  stamp: string | null;
  busy: boolean;
  result?: AiTestResponse;
  error?: unknown;
}

type Editing = { provider: AiProvider | null; kind?: AiProviderKind } | null;

/**
 * AI providers: the saved connections to AI services, one of which is the
 * default that drafting, test cases and variants use. AI features are on
 * while they are turned on and the default is ready; turning them off keeps
 * the default, and turning them on with none makes the first ready provider
 * the default.
 */
export function AiSection({ meta }: { meta: Meta }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const limits = useLimits();
  const settings = useAiSettings();
  const [editing, setEditing] = useState<Editing>(null);
  const [tests, setTests] = useState<Record<string, RowTest>>({});
  const [switching, setSwitching] = useState(false);

  const data = settings.data;
  const list = data?.providers ?? [];
  const chosen = list.find((p) => p.isDefault) ?? null;
  const maxProviders = limits?.maxAiProviders ?? Infinity;
  const full = list.filter((p) => p.source === 'settings').length >= maxProviders;
  // Turning on uses the default, or picks a ready provider when there is none.
  const canTurnOn = chosen ? chosen.ready : list.some((p) => p.ready);

  const choose = async (provider: AiProvider) => {
    try {
      qc.setQueryData(qk.aiSettings, await api.settings.putAi({ defaultProviderId: provider.id }));
      await qc.invalidateQueries({ queryKey: qk.meta });
      toast.success(`“${provider.name}” is now the default provider`);
    } catch (e) {
      toast.error(e);
    }
  };

  const toggle = async (on: boolean) => {
    setSwitching(true);
    try {
      qc.setQueryData(qk.aiSettings, await api.settings.putAi({ enabled: on }));
      await qc.invalidateQueries({ queryKey: qk.meta });
      toast.success(on ? 'AI features turned on' : 'AI features turned off. Your providers and keys are kept.');
    } catch (e) {
      toast.error(e);
    } finally {
      setSwitching(false);
    }
  };

  const remove = async (provider: AiProvider) => {
    const ok = await confirm({
      title: `Delete the provider “${provider.name}”?`,
      body: (
        <>
          {provider.isDefault && (meta.ai.enabled ? 'It is the default provider: deleting it turns AI features off until another provider is the default. ' : 'It is the default provider. ')}
          {provider.apiKeySet ? 'Its saved API key is deleted with it.' : 'Items already drafted with it are not affected.'}
        </>
      ),
      confirmLabel: 'Delete provider',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.settings.removeProvider(provider.id);
      await invalidateAi(qc);
      toast.success(`Deleted “${provider.name}”`);
    } catch (e) {
      toast.error(e);
    }
  };

  const runTest = async (provider: AiProvider) => {
    const stamp = provider.updatedAt;
    setTests((t) => ({ ...t, [provider.id]: { stamp, busy: true } }));
    try {
      const result = await api.settings.testAi({ providerId: provider.id });
      setTests((t) => ({ ...t, [provider.id]: { stamp, busy: false, result } }));
    } catch (error) {
      setTests((t) => ({ ...t, [provider.id]: { stamp, busy: false, error } }));
    }
  };

  return (
    <section className="settings-section" aria-labelledby="ai-title">
      <div className="row">
        <h1 id="ai-title" className="page-title">
          AI providers
        </h1>
        {meta.ai.enabled ? (
          <Badge tone="ok" className="ai-status" title={`${meta.ai.providerName} · ${meta.ai.model}`}>
            On · {meta.ai.providerName} · {meta.ai.model}
          </Badge>
        ) : chosen && !chosen.ready ? (
          <Badge tone="warn" className="ai-status">
            Off · {chosen.name} is not ready
          </Badge>
        ) : (
          <Badge tone="warn" className="ai-status">
            Off
          </Badge>
        )}
        <span className="spacer" />
        {meta.ai.enabled ? (
          <Button variant="ghost" icon={<Power size={14} />} busy={switching} onClick={() => void toggle(false)}>
            Turn AI off
          </Button>
        ) : (
          data &&
          canTurnOn && (
            <Button variant="ghost" icon={<Power size={14} />} busy={switching} onClick={() => void toggle(true)}>
              Turn AI on
            </Button>
          )
        )}
        <Button icon={<Plus size={14} />} onClick={() => setEditing({ provider: null })} disabled={full || !data}>
          Add provider
        </Button>
      </div>
      <p className="settings-lead">
        Connect AI providers to draft items from rough notes, generate test cases and create variants. Providers are optional: you can still write items yourself, or edit your
        library with an assistant over MCP.
      </p>

      {data && full && (
        <p className="settings-note" role="status">
          You have reached the limit of {maxProviders} providers. Delete one to add another.
        </p>
      )}
      {data && chosen && !chosen.ready && (
        <p className="settings-note" role="status">
          The default provider, “{chosen.name}”, needs {listNeeds(needsOf(chosen, data.kinds)) || 'attention'}. Complete it, or make another provider the default.
        </p>
      )}

      {settings.isPending ? (
        <PageLoading />
      ) : settings.isError ? (
        <ErrorState compact error={settings.error} onRetry={() => void settings.refetch()} />
      ) : list.length === 0 ? (
        <div className="card card-pad styles-empty">
          <Sparkles size={18} aria-hidden="true" />
          <div className="grow">
            <strong>No providers yet</strong>
            <p className="muted">
              To use AI features, add a provider: an API key for a hosted service, or the address of a server you run yourself. You enter the connection details, test the connection
              and choose a model.
            </p>
            <div className="form-actions">
              <Button onClick={() => setEditing({ provider: null, kind: 'anthropic' })}>Add Anthropic</Button>
              <Button onClick={() => setEditing({ provider: null, kind: 'gemini' })}>Add Google Gemini</Button>
              <Button onClick={() => setEditing({ provider: null, kind: 'openai_compatible' })}>Add OpenAI-compatible</Button>
            </div>
          </div>
        </div>
      ) : (
        <ul className="provider-list">
          {list.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              settings={settings.data}
              test={tests[p.id]?.stamp === p.updatedAt ? tests[p.id] : undefined}
              onDefault={() => void choose(p)}
              onTest={() => void runTest(p)}
              onEdit={() => setEditing({ provider: p })}
              onDelete={() => void remove(p)}
            />
          ))}
        </ul>
      )}

      {/* A server from before the setting existed sends no timeout. */}
      {data?.timeoutSeconds != null && limits && <TimeoutRow saved={data.timeoutSeconds} min={limits.minAiTimeoutSeconds} max={limits.maxAiTimeoutSeconds} />}

      {editing && data && <AiProviderDialog settings={data} provider={editing.provider} kind={editing.kind} onClose={() => setEditing(null)} />}
    </section>
  );
}

/**
 * How long a request to a provider may take; it applies to all of them. A
 * typed value is saved when the field is left or Enter is pressed, and only
 * when it is inside the limits.
 */
function TimeoutRow({ saved, min, max }: { saved: number; min: number; max: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const unitId = useId();
  // What is being typed, until it is committed; then the value on its way to the server.
  const [draft, setDraft] = useState<string | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Said beside the field as the preferences say it; a failure is a toast instead.
  const [state, setState] = useState<SaveState>({ status: 'idle' });
  // Only the answer to the latest save goes into the cache.
  const latest = useRef(0);

  const commit = async () => {
    if (draft == null) return;
    const entry = readTimeout(draft, min, max);
    if (entry.error != null) {
      setError(entry.error);
      return;
    }
    setError(null);
    setDraft(null);
    if (entry.seconds === (sending ?? saved)) return;
    const call = ++latest.current;
    setSending(entry.seconds);
    setState({ status: 'saving' });
    try {
      const next = await api.settings.putAi({ timeoutSeconds: entry.seconds });
      if (call === latest.current) {
        qc.setQueryData(qk.aiSettings, next);
        setState({ status: 'saved' });
      }
    } catch (e) {
      toast.error(e);
      if (call === latest.current) setState({ status: 'idle' });
    } finally {
      // On failure the field shows the saved value again.
      if (call === latest.current) setSending(null);
    }
  };

  return (
    <div className="card ai-timeout-card">
      <Field label="Request timeout" error={error} className="ai-timeout">
        {(a) => (
          <span className="ai-timeout-control">
            <input
              {...a}
              aria-describedby={[a['aria-describedby'], unitId].filter(Boolean).join(' ')}
              className="input ai-timeout-input"
              type="number"
              inputMode="numeric"
              autoComplete="off"
              min={min}
              max={max}
              step={1}
              value={draft ?? String(sending ?? saved)}
              onChange={(e) => {
                setDraft(e.target.value);
                // Once a value has been turned down, say as it is corrected whether it would now do.
                if (error != null) setError(readTimeout(e.target.value, min, max).error ?? null);
              }}
              onBlur={() => void commit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit();
              }}
            />
            <span id={unitId} className="ai-timeout-unit">
              seconds
            </span>
          </span>
        )}
      </Field>
      <SaveStatus state={state} />
    </div>
  );
}

interface ProviderRowProps {
  provider: AiProvider;
  settings: AiSettings;
  test: RowTest | undefined;
  onDefault: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** When a provider was last used, and the way to its requests. */
function ProviderUsage({ provider }: { provider: AiProvider }) {
  const usage = provider.usage;
  // A server from before the counts existed sends none.
  if (!usage) return null;
  if (usage.allTime.requests === 0) return <p className="provider-usage">Not used yet</p>;
  return (
    <p className="provider-usage row">
      {usage.lastUsedAt && (
        <span>
          Last used{' '}
          <time dateTime={usage.lastUsedAt} title={absoluteTime(usage.lastUsedAt)}>
            {relativeTime(usage.lastUsedAt)}
          </time>
        </span>
      )}
      <Link to={aiLogPath({ providerId: provider.id })} aria-label={`Requests through ${provider.name}`}>
        Requests
      </Link>
    </p>
  );
}

function ProviderRow({ provider: p, settings, test, onDefault, onTest, onEdit, onDelete }: ProviderRowProps) {
  const fromEnvironment = p.source === 'environment';
  const model = modelInEffect(p, settings.kinds);
  const host = customHost(p, settings.kinds);
  const needs = needsOf(p, settings.kinds);
  return (
    <li className={cx('card provider-item', p.isDefault && 'is-default')}>
      <div className="grow">
        <div className="row provider-title">
          <strong className="truncate" onMouseEnter={titleIfCut}>
            {p.name}
          </strong>
          {p.isDefault && (
            <Badge tone="accent" title="Used for drafting, test cases and variants">
              default
            </Badge>
          )}
          {!p.ready ? <Badge tone="warn">needs {listNeeds(needs) || 'attention'}</Badge> : !p.isDefault && <Badge>ready</Badge>}
          {fromEnvironment && <Badge title="Supplied by the server’s environment variables">environment</Badge>}
        </div>
        <div className="provider-meta">
          <span>{kindName(p.kind)}</span>
          {model ? (
            <span>
              <code translate="no" title={model}>
                {model}
              </code>
              {p.model === null && ' (the default)'}
            </span>
          ) : (
            <span>no model</span>
          )}
          {host && (
            <span>
              at{' '}
              <code translate="no" title={host}>
                {host}
              </code>
            </span>
          )}
          {p.effort !== null && <span>{p.effort} effort</span>}
          {p.apiKeySet ? (
            <span className="provider-key">
              <KeyRound size={12} aria-hidden="true" /> key ending in <code translate="no">{(p.apiKeyHint ?? '').replace(/^…/, '')}</code>
            </span>
          ) : (
            <span>no key</span>
          )}
        </div>
        <ProviderUsage provider={p} />
        {fromEnvironment && (
          <p className="provider-note">
            Set by the server’s environment variables (see <code translate="no">.env.example</code>). It can be tested and used as the default; to change or remove it, edit those variables and restart the
            server.
          </p>
        )}
        {test && !test.busy && (
          <p className={cx('provider-test', test.result?.ok ? 'is-ok' : 'is-failed')} role="status">
            {test.result?.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
            <span>
              {test.error != null ? (
                errorLine(test.error)
              ) : test.result?.ok && test.result.model !== null ? (
                <>
                  The connection works: <code translate="no">{test.result.model}</code> answered{test.result.latencyMs != null ? ` in ${formatMs(test.result.latencyMs)}` : ''}.
                </>
              ) : test.result?.ok ? (
                <>Connection succeeded{test.result.models ? ` (${plural(test.result.models.length, 'model')} available)` : ''}, but no model is selected yet.</>
              ) : (
                <>Connection failed. {test.result?.error ? sentence(test.result.error) : 'The provider did not accept the request.'}</>
              )}
            </span>
          </p>
        )}
      </div>
      <div className="style-actions">
        {p.ready && !p.isDefault && (
          <Button size="sm" variant="ghost" icon={<Star size={14} />} onClick={onDefault}>
            Make default
          </Button>
        )}
        <IconButton size="sm" label={`Test the connection of ${p.name}`} icon={<PlugZap size={14} />} busy={test?.busy} onClick={onTest} />
        {!fromEnvironment && (
          <>
            <IconButton size="sm" label={`Edit ${p.name}`} icon={<Pencil size={14} />} onClick={onEdit} />
            <IconButton size="sm" label={`Delete ${p.name}`} icon={<Trash2 size={14} />} onClick={onDelete} />
          </>
        )}
      </div>
    </li>
  );
}
