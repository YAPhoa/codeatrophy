import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, PlugZap, Server } from 'lucide-react';
import { api, isAbort, isApiError } from '../../api/client';
import { invalidateAi, useLimits } from '../../api/queries';
import type { AiProvider, AiProviderKind, AiSettings, AiTestResponse } from '../../api/types';
import { errorLine, sentence } from '../../lib/errors';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { formatMs, plural } from '../../lib/format';
import { Button, cx } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, Field, TextField } from '../../ui/Field';
import { Callout, ErrorCallout } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { hostOf } from './aiKeyBinding';
import {
  KINDS,
  baseUrlProblem,
  charLength,
  createBody,
  formOf,
  kindName,
  listNeeds,
  modelProblem,
  nameProblem,
  needsOf,
  outlookOf,
  patchBody,
  suggestName,
  testBody,
  type ProviderForm,
} from './aiProviders';
import { ModelField } from './ModelField';

interface AiProviderDialogProps {
  settings: AiSettings;
  /** The saved provider to edit, or `null` to add one. */
  provider: AiProvider | null;
  /** The kind a new provider starts as. */
  kind?: AiProviderKind;
  onClose: () => void;
}

/** The models a connection test brought back, and the server they belong to. */
interface Listing {
  models: string[] | null;
  modelsError: string | null;
  host: string;
}

/**
 * Add or edit one provider. The form follows the order of setting one up:
 * the key (and, rarely, another server), a connection test that also loads
 * the models on offer, the model, then save. Nothing depends on the test:
 * a provider can be saved untested, and before it is complete.
 */
export function AiProviderDialog({ settings, provider, kind: initialKind = 'anthropic', onClose }: AiProviderDialogProps) {
  const qc = useQueryClient();
  const limits = useLimits();
  const toast = useToast();
  const kinds = settings.kinds;
  const adding = provider === null;

  const [form, setForm] = useState<ProviderForm>(() =>
    provider ? formOf(provider) : { name: suggestName(initialKind, '', settings.providers, kinds), kind: initialKind, model: '', baseUrl: '', apiKey: '', removeKey: false },
  );
  // A new provider is named after where it connects until the user names it.
  const [named, setNamed] = useState(!adding);
  const [urlOpen, setUrlOpen] = useState(form.baseUrl !== '');
  const [urlChecked, setUrlChecked] = useState(false);
  const [asDefault, setAsDefault] = useState(adding && settings.defaultProviderId === null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResponse | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const [listing, setListing] = useState<Listing | null>(null);

  const running = useRef<AbortController | null>(null);
  const focusAfterTest = useRef<'model' | 'save' | 'test' | null>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => running.current?.abort(), []);

  // The Test button is disabled while it runs, which drops the focus. Once
  // it is back, put the focus on the next step.
  useEffect(() => {
    if (testing || focusAfterTest.current === null) return;
    ({ model: modelRef, save: saveRef, test: testRef })[focusAfterTest.current].current?.focus();
    focusAfterTest.current = null;
  }, [testing]);

  const kind = kinds[form.kind];
  const outlook = outlookOf(form, provider, kinds);
  const host = hostOf(outlook.nextBaseUrl);
  const modelInUse = form.model.trim() || kind.defaultModel;

  /** A change to the kind, server or key. A test result and the models it loaded belong to the old ones. */
  const reconnect = (change: Partial<ProviderForm>) => {
    running.current?.abort();
    setForm((f) => ({ ...f, ...change }));
    setTest(null);
    setTestError(null);
    setListing(null);
    setSaveError(null);
  };

  /** The loaded models still belong to this server and key; only a failure was about the model that was tried. */
  const setModel = (model: string) => {
    setForm((f) => ({ ...f, model }));
    setTest((t) => (t?.ok ? t : null));
    setTestError(null);
    setSaveError(null);
  };

  const bounds = {
    nameMax: limits?.maxAiProviderNameChars ?? Infinity,
    modelMax: limits?.maxModelIdChars ?? Infinity,
  };
  const nameLen = charLength(form.name);
  // A missing name is pointed out once the user has tried to save.
  const [attempted, setAttempted] = useState(false);
  const nameError = nameProblem(form.name, settings.providers, provider, bounds.nameMax) ?? (attempted && nameLen === 0 ? 'Give the provider a name.' : null);
  const modelError = modelProblem(form.model, bounds.modelMax);
  const urlError = baseUrlProblem(form.baseUrl);
  const patch = provider ? patchBody(form, provider) : null;
  const dirty = patch === null || Object.keys(patch).length > 0;
  const canSave = nameLen > 0 && !nameError && !modelError && dirty;

  const fieldsOf = (error: unknown) => (isApiError(error) && error.code === 'validation_failed' ? error.fields : {});
  const saveFields = fieldsOf(saveError);
  const testFields = fieldsOf(testError);
  const serverError = (field: 'name' | 'model' | 'baseUrl' | 'apiKey'): string | null => {
    const problem = saveFields[field] ?? testFields[field];
    return problem != null ? sentence(String(problem)) : null;
  };
  const onField = (fields: Record<string, unknown>) => ['name', 'model', 'baseUrl', 'apiKey'].some((f) => fields[f] != null);
  const baseUrlError = (urlChecked ? urlError : null) ?? serverError('baseUrl');

  const runTest = async () => {
    if (urlError) {
      setUrlChecked(true);
      return;
    }
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      const result = await api.settings.testAi(testBody(form, provider, kinds), controller.signal);
      if (controller.signal.aborted) return;
      setTest(result);
      setListing({ models: result.models, modelsError: result.modelsError, host });
      // With no model yet, a working connection leads straight to picking one.
      focusAfterTest.current = !result.ok ? 'test' : modelInUse === null ? 'model' : canSave ? 'save' : 'test';
    } catch (e) {
      if (!isAbort(e) && !controller.signal.aborted) setTestError(e);
    } finally {
      if (running.current === controller) {
        running.current = null;
        setTesting(false);
      }
    }
  };

  const save = async () => {
    if (saving) return;
    setAttempted(true);
    if (nameLen === 0 || nameError || modelError) {
      focusFirstInvalid();
      return;
    }
    if (urlError) {
      setUrlChecked(true);
      focusFirstInvalid();
      return;
    }
    // Nothing was changed: there is nothing to send.
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (provider && patch) {
        await api.settings.updateProvider(provider.id, patch);
        toast.success('Provider saved');
      } else {
        const created = await api.settings.createProvider(createBody(form));
        await chooseDefault(created);
      }
      await invalidateAi(qc);
      onClose();
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  /** A new provider is saved by now. Making it the default is a second step, and only possible when it is ready. */
  const chooseDefault = async (created: AiProvider) => {
    if (!asDefault) {
      toast.success(`Added “${created.name}”`);
    } else if (!created.ready) {
      const needs = listNeeds(needsOf(created, kinds));
      toast.info(`Added “${created.name}”. It is not the default yet: it still needs ${needs || 'to be completed'}.`);
    } else {
      try {
        await api.settings.putAi({ defaultProviderId: created.id });
        toast.success(`Added “${created.name}” as the default provider`);
      } catch (e) {
        toast.error(`“${created.name}” was added, but could not be made the default. ${errorLine(e)}`);
      }
    }
  };

  /** Enter in a field of the connection tests it, as the next step of the form, rather than saving. */
  const testOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!testing && !saving) void runTest();
  };

  const keyHint = (provider?.apiKeyHint ?? '').replace(/^…/, '');
  const tested = test?.ok === true && outlook.missing.length === 0;
  /** The default stays selected when it is no longer ready, and AI features are then off. */
  const breaksDefault = provider?.isDefault === true && provider.ready && outlook.missing.length > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      guard
      title={adding ? 'Add provider' : 'Edit provider'}
      size="md"
      locked={saving}
      footer={
        <>
          <span className={cx('dialog-note', tested && 'is-ok', breaksDefault && 'is-warn')} role="status">
            {!dirty ? (
              'No unsaved changes.'
            ) : breaksDefault ? (
              <>This is the default provider: saved without {listNeeds(outlook.missing)}, AI features are off.</>
            ) : outlook.missing.length > 0 ? (
              <>Can be saved now; it still needs {listNeeds(outlook.missing)}.</>
            ) : tested ? (
              <>
                <CheckCircle2 size={14} aria-hidden="true" /> Tested. Save to keep it.
              </>
            ) : null}
          </span>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button ref={saveRef} variant="primary" type="submit" form="provider-form" busy={saving}>
            {adding ? 'Add provider' : 'Save provider'}
          </Button>
        </>
      }
    >
      <form
        id="provider-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {adding ? (
          <fieldset className="choice-cards">
            <legend className="field-label">Kind</legend>
            <div className="kind-cards">
              {KINDS.map((k) => (
                <label key={k.id} className={cx('choice-card', form.kind === k.id && 'is-selected')}>
                  <input
                    type="radio"
                    name="ai-kind"
                    checked={form.kind === k.id}
                    // A model of the other kind would mean nothing here.
                    onChange={() => reconnect({ kind: k.id, model: '', name: named ? form.name : suggestName(k.id, form.baseUrl, settings.providers, kinds) })}
                  />
                  <span>
                    <strong>{k.name}</strong>
                    <span className="choice-text">{k.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <div className="field">
            <span className="field-label">Kind</span>
            <div>
              {kindName(form.kind)} <span className="muted">· fixed once a provider has been added</span>
            </div>
          </div>
        )}

        <Field label="Name" error={nameError ?? serverError('name')} hint={nameLen > bounds.nameMax * 0.75 ? `${nameLen} / ${bounds.nameMax}` : undefined}>
          {(a) => (
            <input
              {...a}
              className="input"
              value={form.name}
              onChange={(e) => {
                setNamed(true);
                setForm((f) => ({ ...f, name: e.target.value }));
                setSaveError(null);
              }}
              placeholder="e.g. Personal key…"
              autoComplete="off"
            />
          )}
        </Field>

        <div className="field">
          <TextField
            label={outlook.serverChanges ? `API key for ${host}${outlook.keyRequired ? '' : ' (optional)'}` : outlook.keyRequired ? 'API key' : 'API key (optional)'}
            type="password"
            value={form.apiKey}
            onChange={(v) => reconnect({ apiKey: v, removeKey: false })}
            onKeyDown={testOnEnter}
            placeholder={outlook.savedKeyDropped ? 'Paste the key for this server…' : provider?.apiKeySet ? 'Enter a new key to replace the current one…' : 'Paste the key…'}
            name="api-key"
            // Not a login: browsers ignore "off" on a password field and would offer the site's saved
            // password, so the field is declared a new secret and password managers are told to pass over it.
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            spellCheck={false}
            maxLength={limits?.maxApiKeyChars}
            error={serverError('apiKey')}
            data-autofocus={adding ? true : undefined}
          />
          {outlook.savedKeyDropped && (
            <Callout tone="warn" role="status" title="The saved key will not carry over to this server">
              The saved key belongs to <code translate="no">{hostOf(outlook.currentBaseUrl)}</code>. A key is never sent to a different server than the one it was saved for, so saving this base URL deletes it, and
              Test connection runs without it.{' '}
              {outlook.keyRequired ? (
                <>
                  Enter the key for <code translate="no">{host}</code> to continue.
                </>
              ) : (
                <>
                  Enter the key for <code translate="no">{host}</code>, or leave the field empty if that server needs none.
                </>
              )}
            </Callout>
          )}
          {provider && (
            <div className="key-status">
              <KeyRound size={14} aria-hidden="true" />
              {outlook.savedKeyDropped ? (
                <span>
                  The saved key ending in <code translate="no">{keyHint}</code> will be deleted when you save.
                </span>
              ) : form.removeKey && provider.apiKeySet ? (
                <>
                  <span>The saved key will be deleted when you save.</span>
                  <button type="button" className="link-btn" onClick={() => reconnect({ removeKey: false })}>
                    Undo
                  </button>
                </>
              ) : provider.apiKeySet ? (
                <>
                  <span>
                    A key ending in <code translate="no">{keyHint}</code> is saved.
                  </span>
                  <button type="button" className="link-btn" onClick={() => reconnect({ removeKey: true, apiKey: '' })}>
                    Delete saved key
                  </button>
                </>
              ) : (
                <span>No key is set.</span>
              )}
            </div>
          )}
          <p className="field-hint">Keys are write-only: stored encrypted on the server and never sent back to the browser. Only the last four characters are shown.</p>
        </div>

        {urlOpen || baseUrlError ? (
          <TextField
            label="Base URL (optional)"
            type="url"
            value={form.baseUrl}
            onChange={(v) => reconnect({ baseUrl: v, name: named ? form.name : suggestName(form.kind, v, settings.providers, kinds) })}
            onBlur={() => setUrlChecked(true)}
            onKeyDown={testOnEnter}
            placeholder={kind.defaultBaseUrl}
            hint={`Leave empty to use ${kind.defaultBaseUrl}.${form.kind === 'openai_compatible' ? ' For Ollama: http://localhost:11434/v1' : ' Only needed for a proxy or gateway.'}`}
            error={baseUrlError}
            autoComplete="off"
            spellCheck={false}
          />
        ) : (
          <div className="server-line">
            <Server size={14} aria-hidden="true" />
            <span>
              Connects to <code translate="no">{host}</code>.
            </span>
            <button type="button" className="link-btn" onClick={() => setUrlOpen(true)}>
              {form.kind === 'openai_compatible' ? 'Use another server' : 'Use a proxy or gateway'}
            </button>
          </div>
        )}

        <div className="form-actions">
          <Button ref={testRef} icon={<PlugZap size={14} />} onClick={() => void runTest()} busy={testing} disabled={saving}>
            Test connection
          </Button>
        </div>
        {test?.ok && (
          <Callout tone="ok" role="status" title="The connection works">
            {test.model !== null && test.model === modelInUse ? (
              <>
                <code translate="no">{test.model}</code> answered{test.latencyMs != null ? ` in ${formatMs(test.latencyMs)}` : ''}.
              </>
            ) : modelInUse === null ? (
              listing?.models && listing.models.length > 0 ? (
                <>
                  <code translate="no">{listing.host}</code> offers {plural(listing.models.length, 'model')}. Pick one below.
                </>
              ) : (
                <>Enter the model to use below.</>
              )
            ) : listing?.models?.includes(modelInUse) ? (
              <>
                <code translate="no">{modelInUse}</code> is one of the models <code translate="no">{listing.host}</code> offers.
              </>
            ) : (
              <>
                <code translate="no">{modelInUse}</code> has not been tried yet. Test again to check it, or save it as it is.
              </>
            )}
          </Callout>
        )}
        {test && !test.ok && (
          <Callout tone="danger" role="alert" title="The connection failed">
            {test.error ? sentence(test.error) : 'The provider did not accept the request.'}
            {test.models !== null && test.models.length > 0 && <> The {plural(test.models.length, 'model')} it offers are listed below.</>}
          </Callout>
        )}
        {testError != null && !onField(testFields) && <ErrorCallout error={testError} title="The test could not be run" />}

        <ModelField
          value={form.model}
          onChange={setModel}
          models={listing?.models ?? null}
          inputRef={modelRef}
          placeholder={kind.defaultModel ?? (listing?.models?.length ? 'Pick a model…' : 'e.g. gpt-4.1, llama3.1:70b…')}
          maxLength={limits?.maxModelIdChars}
          error={modelError ?? serverError('model')}
          hint={
            listing?.models && listing.models.length > 0
              ? `${plural(listing.models.length, 'model')} loaded from ${listing.host}. Pick one, or type a name.`
              : listing?.modelsError && listing.modelsError !== test?.error
                ? `The list of models could not be loaded: ${sentence(listing.modelsError)} Type the name exactly as the endpoint expects it.`
                : kind.defaultModel
                  ? `Leave empty to use ${kind.defaultModel}. Test the connection to load the models on offer.`
                  : 'Test the connection to load the models on offer, or type the name as the endpoint expects it.'
          }
        />

        {adding && (
          <Checkbox
            checked={asDefault}
            onChange={setAsDefault}
            label="Use as the default"
            hint={
              asDefault && outlook.missing.length > 0
                ? `It needs ${listNeeds(outlook.missing)} first: saved as it is, it is kept but not made the default.`
                : 'Drafting, test cases and variants use the default provider.'
            }
          />
        )}
        {saveError != null && !onField(saveFields) && (
          <ErrorCallout error={saveError} title={adding && isApiError(saveError) && saveError.code === 'conflict' ? 'The limit of providers has been reached' : 'Could not save the provider'} />
        )}
      </form>
    </Dialog>
  );
}
