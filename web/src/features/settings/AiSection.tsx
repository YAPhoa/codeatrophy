import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Pencil, PlugZap, Plus, Power, Sparkles, Star, Trash2, XCircle } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateAi, qk, useAiSettings, useLimits } from '../../api/queries';
import type { AiProvider, AiProviderKind, AiSettings, AiTestResponse, Meta } from '../../api/types';
import { aiLogPath } from '../../lib/aiLog';
import { errorLine, sentence } from '../../lib/errors';
import { absoluteTime, formatMs, plural, relativeTime } from '../../lib/format';
import { Button, IconButton, cx } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Badge, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { AiProviderDialog } from './AiProviderDialog';
import { customHost, kindName, listNeeds, modelInEffect, needsOf } from './aiProviders';

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
 * default that drafting, test cases and variants use. AI features are off
 * while none is the default.
 */
export function AiSection({ meta }: { meta: Meta }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const limits = useLimits();
  const settings = useAiSettings();
  const [editing, setEditing] = useState<Editing>(null);
  const [tests, setTests] = useState<Record<string, RowTest>>({});

  const data = settings.data;
  const list = data?.providers ?? [];
  const chosen = list.find((p) => p.isDefault) ?? null;
  const maxProviders = limits?.maxAiProviders ?? Infinity;
  const full = list.filter((p) => p.source === 'settings').length >= maxProviders;

  const choose = async (provider: AiProvider | null) => {
    try {
      qc.setQueryData(qk.aiSettings, await api.settings.putAi({ defaultProviderId: provider?.id ?? null }));
      await qc.invalidateQueries({ queryKey: qk.meta });
      toast.success(provider ? `“${provider.name}” is now the default provider` : 'AI features turned off. Your providers and keys are kept.');
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (provider: AiProvider) => {
    const ok = await confirm({
      title: `Delete the provider “${provider.name}”?`,
      body: (
        <>
          {provider.isDefault && (provider.ready ? 'It is the default provider: deleting it turns AI features off until you make another one the default. ' : 'It is the default provider. ')}
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
        ) : chosen ? (
          <Badge tone="warn" className="ai-status">
            Off · {chosen.name} is not ready
          </Badge>
        ) : (
          <Badge>Off</Badge>
        )}
        <span className="spacer" />
        {meta.ai.enabled && (
          <Button variant="ghost" icon={<Power size={14} />} onClick={() => void choose(null)}>
            Turn AI off
          </Button>
        )}
        <Button icon={<Plus size={14} />} onClick={() => setEditing({ provider: null })} disabled={full || !data}>
          Add provider
        </Button>
      </div>
      <p className="settings-lead">
        Used to draft items from rough input, generate test cases and create variants. You can keep several providers — a hosted service and a server of your own, say — and the default is the
        one that gets used. Without one everything else works, and items are written by hand. Assistants connected over MCP bring their own model and do not use this.
      </p>

      {data && full && (
        <p className="settings-note" role="status">
          You have {maxProviders} providers, which is the most an instance keeps. Delete one to add another.
        </p>
      )}
      {data && list.length > 0 && !meta.ai.enabled && (
        <p className="settings-note" role="status">
          {chosen
            ? `AI features are off: the default provider, “${chosen.name}”, needs ${listNeeds(needsOf(chosen, data.kinds)) || 'attention'}. Complete it, or make another provider the default.`
            : 'AI features are off: no provider is the default. Choose “Make default” on one that is ready.'}
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
              AI features are off. To turn them on, add a connection to an AI service: an API key for a hosted one, or the address of a server you run yourself. It takes a key, a connection test
              and a model.
            </p>
            <div className="form-actions">
              <Button onClick={() => setEditing({ provider: null, kind: 'anthropic' })}>Add Anthropic</Button>
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

      {editing && data && <AiProviderDialog settings={data} provider={editing.provider} kind={editing.kind} onClose={() => setEditing(null)} />}
    </section>
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
          <strong className="truncate">{p.name}</strong>
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
              <code translate="no">{model}</code>
              {p.model === null && ' (the default)'}
            </span>
          ) : (
            <span>no model</span>
          )}
          {host && (
            <span>
              at <code translate="no">{host}</code>
            </span>
          )}
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
                <>The connection works{test.result.models ? `, and the server offers ${plural(test.result.models.length, 'model')}` : ''}. No model is set to try.</>
              ) : (
                <>The connection failed. {test.result?.error ? sentence(test.result.error) : 'The provider did not accept the request.'}</>
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
