import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, PlugZap, Save } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { qk, useAiSettings, useLimits } from '../../api/queries';
import type { AiProviderId, AiProviderUpdate, AiSettings, AiTestResponse, Meta, SettingSource } from '../../api/types';
import { sentence } from '../../lib/errors';
import { formatMs } from '../../lib/format';
import { Button, cx } from '../../ui/Button';
import { TextField } from '../../ui/Field';
import { Badge, Callout, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';

type Choice = AiProviderId | 'off';

const PROVIDERS: { id: AiProviderId; name: string; text: string; keyOptional: boolean }[] = [
  { id: 'anthropic', name: 'Anthropic', text: 'The Anthropic API (Claude models). Needs an API key.', keyOptional: false },
  {
    id: 'openai_compatible',
    name: 'OpenAI-compatible',
    text: 'Any endpoint that speaks the OpenAI chat-completions API: OpenAI, OpenRouter, Ollama, LM Studio, vLLM… A key is optional for local servers.',
    keyOptional: true,
  },
];

interface ProviderForm {
  model: string;
  baseUrl: string;
  /** A new key typed by the user. Never pre-filled: stored keys cannot be read back. */
  apiKey: string;
  removeKey: boolean;
}

/** The value saved in these settings, as opposed to one supplied by the server's environment. */
const saved = (value: string | null, source: SettingSource): string => (source === 'settings' ? (value ?? '') : '');
/** A value the server's environment supplies, which applies while nothing is saved here. */
const fromEnv = (value: string | null, source: SettingSource): string | null => (source === 'environment' ? value : null);

// Only saved values are editable. Pre-filling one that comes from the
// environment would copy it into the settings on the next save and silently
// stop following the environment.
const formOf = (s: AiSettings, id: AiProviderId): ProviderForm => {
  const p = s.providers[id];
  return { model: saved(p.model, p.modelSource), baseUrl: saved(p.baseUrl, p.baseUrlSource), apiKey: '', removeKey: false };
};

/** Says where the value in use comes from, in the same way as for the API key. */
function sourceHint(what: string, value: string | null, source: SettingSource, fallback: string | null, extra = ''): string {
  if (source === 'environment' && value) return `Using ${value}, supplied by the server’s environment. A ${what} saved here takes precedence.${extra}`;
  if (source === 'settings') return `Saved in these settings.${fallback ? ` Clear it to go back to ${fallback}.` : ''}${extra}`;
  return fallback ? `Leave empty to use the default, ${fallback}.${extra}` : extra.trim();
}

export function AiSection({ meta }: { meta: Meta }) {
  const settings = useAiSettings();
  return (
    <section id="ai" className="settings-section" aria-labelledby="ai-title">
      <div className="row">
        <h2 id="ai-title">AI provider</h2>
        {meta.ai.enabled ? <Badge tone="ok">On · {meta.ai.model}</Badge> : <Badge>Off</Badge>}
      </div>
      <p className="settings-lead">
        Used to draft items from rough input, generate test cases and create variants. Without a provider everything else works, and items are written by hand. Assistants connected over MCP bring
        their own model and do not use this.
      </p>
      {settings.isPending ? <PageLoading /> : settings.isError ? <ErrorState compact error={settings.error} onRetry={() => void settings.refetch()} /> : <AiForm settings={settings.data} />}
    </section>
  );
}

function AiForm({ settings }: { settings: AiSettings }) {
  const qc = useQueryClient();
  const limits = useLimits();
  const toast = useToast();
  const [choice, setChoice] = useState<Choice>(settings.activeProvider ?? 'off');
  const [forms, setForms] = useState<Record<AiProviderId, ProviderForm>>(() => ({
    anthropic: formOf(settings, 'anthropic'),
    openai_compatible: formOf(settings, 'openai_compatible'),
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResponse | null>(null);
  const [testError, setTestError] = useState<unknown>(null);

  // A test result only describes the values it was run with.
  useEffect(() => {
    setTest(null);
    setTestError(null);
  }, [choice, forms]);

  const provider = choice === 'off' ? null : choice;
  const info = PROVIDERS.find((p) => p.id === provider);
  const state = provider ? settings.providers[provider] : null;
  const defaults = provider ? settings.defaults[provider] : null;
  const form = provider ? forms[provider] : null;
  const setForm = (change: Partial<ProviderForm>) => {
    if (provider) setForms((f) => ({ ...f, [provider]: { ...f[provider], ...change } }));
  };

  /** Only what differs from the stored settings is sent, so untouched values (and keys) stay as they are. */
  const updateFor = (id: AiProviderId): AiProviderUpdate => {
    const f = forms[id];
    const s = settings.providers[id];
    const update: AiProviderUpdate = {};
    if (f.model.trim() !== saved(s.model, s.modelSource)) update.model = f.model.trim() || null;
    if (f.baseUrl.trim() !== saved(s.baseUrl, s.baseUrlSource)) update.baseUrl = f.baseUrl.trim() || null;
    if (f.apiKey.trim()) update.apiKey = f.apiKey.trim();
    else if (f.removeKey) update.apiKey = null;
    return update;
  };

  const pending = provider ? updateFor(provider) : {};
  const dirty = choice !== (settings.activeProvider ?? 'off') || Object.keys(pending).length > 0;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.settings.putAi({
        activeProvider: provider,
        ...(provider && Object.keys(pending).length > 0 ? { providers: { [provider]: pending } } : {}),
      });
      qc.setQueryData(qk.aiSettings, next);
      setForms({ anthropic: formOf(next, 'anthropic'), openai_compatible: formOf(next, 'openai_compatible') });
      setChoice(next.activeProvider ?? 'off');
      await qc.invalidateQueries({ queryKey: qk.meta });
      toast.success(next.activeProvider ? 'AI settings saved' : 'AI features turned off');
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!provider || !form) return;
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      // Unsaved values are passed along so a key can be tried before it is stored.
      setTest(
        await api.settings.testAi({
          provider,
          model: form.model.trim() || null,
          baseUrl: form.baseUrl.trim() || null,
          apiKey: form.apiKey.trim() || null,
        }),
      );
    } catch (e) {
      setTestError(e);
    } finally {
      setTesting(false);
    }
  };

  const keyWillBeSet = form ? form.apiKey.trim() !== '' || (state?.apiKeySet === true && !(form.removeKey && state.apiKeySource === 'settings')) : false;
  const envModel = state ? fromEnv(state.model, state.modelSource) : null;
  const envBaseUrl = state ? fromEnv(state.baseUrl, state.baseUrlSource) : null;
  const missing: string[] = [];
  if (provider && form && info) {
    if (!form.model.trim() && !envModel && !defaults?.model) missing.push('a model');
    if (!info.keyOptional && !keyWillBeSet) missing.push('an API key');
  }
  const fieldErrors = isApiError(saveError) && saveError.code === 'validation_failed' ? saveError.fields : {};

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="choice-cards">
        <legend className="sr-only">Provider</legend>
        <label className={cx('choice-card', choice === 'off' && 'is-selected')}>
          <input type="radio" name="ai-provider" checked={choice === 'off'} onChange={() => setChoice('off')} />
          <span>
            <strong>Off</strong>
            <span className="choice-text">No AI features. Saved provider settings and keys are kept for later.</span>
          </span>
        </label>
        {PROVIDERS.map((p) => (
          <label key={p.id} className={cx('choice-card', choice === p.id && 'is-selected')}>
            <input type="radio" name="ai-provider" checked={choice === p.id} onChange={() => setChoice(p.id)} />
            <span>
              <strong>
                {p.name} {settings.activeProvider === p.id && <Badge tone="ok">in use</Badge>}
                {settings.activeProvider !== p.id && settings.providers[p.id].ready && <Badge>configured</Badge>}
              </strong>
              <span className="choice-text">{p.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {provider && form && state && info && (
        <div className="card card-pad stack provider-form">
          <div className="form-grid">
            <TextField
              label="Model"
              value={form.model}
              onChange={(v) => setForm({ model: v })}
              placeholder={envModel ?? defaults?.model ?? 'e.g. gpt-4.1, llama3.1:70b'}
              hint={sourceHint('model', state.model, state.modelSource, envModel ?? defaults?.model ?? null) || 'The model name exactly as the endpoint expects it.'}
              error={fieldErrors.model != null ? String(fieldErrors.model) : null}
              maxLength={limits?.maxModelIdChars}
              autoComplete="off"
              spellCheck={false}
            />
            <TextField
              label="Base URL"
              type="url"
              value={form.baseUrl}
              onChange={(v) => setForm({ baseUrl: v })}
              placeholder={envBaseUrl ?? defaults?.baseUrl ?? 'https://…'}
              hint={sourceHint(
                'base URL',
                state.baseUrl,
                state.baseUrlSource,
                envBaseUrl ?? defaults?.baseUrl ?? null,
                provider === 'openai_compatible' ? ' For Ollama: http://localhost:11434/v1' : ' Only needed for a proxy or gateway.',
              )}
              error={fieldErrors.baseUrl != null ? String(fieldErrors.baseUrl) : null}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <TextField
              label={info.keyOptional ? 'API key (optional)' : 'API key'}
              type="password"
              value={form.apiKey}
              onChange={(v) => setForm({ apiKey: v, removeKey: false })}
              placeholder={state.apiKeySet ? 'Enter a new key to replace the current one' : 'Paste the key'}
              autoComplete="off"
              spellCheck={false}
              maxLength={limits?.maxApiKeyChars}
              error={fieldErrors.apiKey != null ? String(fieldErrors.apiKey) : null}
            />
            <div className="key-status">
              <KeyRound size={13} aria-hidden="true" />
              {form.removeKey && state.apiKeySource === 'settings' ? (
                <>
                  <span>The saved key will be deleted when you save.</span>
                  <button type="button" className="link-btn" onClick={() => setForm({ removeKey: false })}>
                    Undo
                  </button>
                </>
              ) : state.apiKeySet ? (
                <>
                  <span>
                    A key ending in <code>{(state.apiKeyHint ?? '').replace(/^…/, '')}</code> is in use
                    {state.apiKeySource === 'environment' ? ', supplied by the server’s environment — it cannot be changed here, but a key saved here takes precedence.' : ', saved in these settings.'}
                  </span>
                  {state.apiKeySource === 'settings' && (
                    <button type="button" className="link-btn" onClick={() => setForm({ removeKey: true, apiKey: '' })}>
                      Delete saved key
                    </button>
                  )}
                </>
              ) : (
                <span>No key is set.</span>
              )}
            </div>
            <p className="field-hint">Keys are write-only: stored encrypted on the server and never sent back to the browser. Only the last four characters are shown.</p>
          </div>

          <div className="form-actions">
            <Button icon={<PlugZap size={14} />} onClick={() => void runTest()} busy={testing} disabled={saving}>
              Test connection
            </Button>
            <span className="muted">Makes one small request with the values above. Nothing is saved.</span>
          </div>
          {test?.ok && (
            <Callout tone="ok" role="status" title="The connection works">
              <CheckCircle2 size={13} aria-hidden="true" /> {test.model ?? 'The model'} answered{test.latencyMs != null ? ` in ${formatMs(test.latencyMs)}` : ''}.
            </Callout>
          )}
          {test && !test.ok && (
            <Callout tone="danger" role="alert" title="The connection failed">
              {test.error ? sentence(test.error) : 'The provider did not accept the request.'}
            </Callout>
          )}
          {testError != null && <ErrorCallout error={testError} title="The test could not be run" />}
        </div>
      )}

      {saveError != null && <ErrorCallout error={saveError} title="Could not save the AI settings" />}

      <div className="form-actions">
        <Button type="submit" variant="primary" icon={<Save size={14} />} busy={saving} disabled={!dirty || missing.length > 0}>
          {choice === 'off' && settings.activeProvider ? 'Turn AI off' : 'Save'}
        </Button>
        {missing.length > 0 && <span className="muted">{info?.name} needs {missing.join(' and ')} before it can be used.</span>}
        {!dirty && missing.length === 0 && <span className="muted">No unsaved changes.</span>}
      </div>
    </form>
  );
}
