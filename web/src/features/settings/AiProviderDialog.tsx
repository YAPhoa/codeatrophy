import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, PlugZap, Server } from 'lucide-react';
import { api, isAbort, isApiError, validationFields } from '../../api/client';
import { invalidateAi, useLimits } from '../../api/queries';
import type { AiEffort, AiProvider, AiProviderKind, AiSettings, AiTestResponse } from '../../api/types';
import { errorLine, sentence } from '../../lib/errors';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { formatMs, plural, relativeTime } from '../../lib/format';
import { TextSwap } from '../../ui/Animated';
import { Button, cx } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, Field, SelectField, TextField } from '../../ui/Field';
import { Callout, ErrorCallout } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { hostOf } from './aiKeyBinding';
import {
  EFFORTS,
  KINDS,
  baseUrlProblem,
  baseUrlRequired,
  charLength,
  createBody,
  effortTested,
  formOf,
  kindName,
  listNeeds,
  modelPlaceholder,
  modelProblem,
  modelsBody,
  nameProblem,
  needsOf,
  needsTest,
  outlookOf,
  passedTestOf,
  patchBody,
  suggestName,
  testBody,
  testPassedFor,
  type PassedTest,
  type ProviderForm,
} from './aiProviders';
import { rememberModels, rememberedModels, type RememberedModels } from './modelCache';
import { ModelField } from './ModelField';

const MASKED_TEXT = typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc');

const DEFAULT_EFFORT = '';
const EFFORT_OPTIONS: { value: AiEffort | typeof DEFAULT_EFFORT; label: string }[] = [
  { value: DEFAULT_EFFORT, label: 'Default' },
  ...EFFORTS.map((e) => ({ value: e, label: e[0]!.toUpperCase() + e.slice(1) })),
];

interface AiProviderDialogProps {
  settings: AiSettings;
  /** The saved provider to edit, or `null` to add one. */
  provider: AiProvider | null;
  /** The kind a new provider starts as. */
  kind?: AiProviderKind;
  onClose: () => void;
}

/** The models the service listed in this dialog, through a load or a test, or why it could not. */
interface Listing {
  models: string[] | null;
  error: string | null;
  at: string;
}

/** What moves the focus once a load is done: the field and the Enter key keep it, the refresh button hands it on. */
type LoadFrom = 'open' | 'field' | 'enter' | 'button';

/**
 * Add or edit one provider. The form follows the order of setting one up:
 * the key (and, rarely, another server), loading the models on offer,
 * picking one, a connection test of it, then save. A test covers the
 * endpoint (kind and base URL) and the key, and the effort level where the
 * test sends it: a new provider is added once a test of them has passed,
 * and a saved one given another endpoint, a new key or such a level is
 * saved once a test of those has; the model can change freely.
 * Loaded models are remembered per endpoint in this browser and offered
 * whenever the form is on that endpoint, until a newer list replaces them.
 */
export function AiProviderDialog({ settings, provider, kind: initialKind = 'anthropic', onClose }: AiProviderDialogProps) {
  const qc = useQueryClient();
  const limits = useLimits();
  const toast = useToast();
  const kinds = settings.kinds;
  const adding = provider === null;

  const [form, setForm] = useState<ProviderForm>(() =>
    provider ? formOf(provider, kinds) : { name: suggestName(initialKind, '', settings.providers, kinds), kind: initialKind, model: '', baseUrl: '', apiKey: '', removeKey: false, effort: null },
  );
  // A new provider is named after where it connects until the user names it.
  const [named, setNamed] = useState(!adding);
  const [urlOpen, setUrlOpen] = useState(form.baseUrl !== '');
  const [urlChecked, setUrlChecked] = useState(false);
  const [asDefault, setAsDefault] = useState(adding && settings.defaultProviderId === null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  // A load and a test both fetch the list, so only one runs: a test cancels a load, and no load starts during a test.
  const [busy, setBusy] = useState<'load' | 'test' | null>(null);
  const testing = busy === 'test';
  const [test, setTest] = useState<AiTestResponse | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  // What the last test that passed, with a generation, covered.
  const [lastPass, setLastPass] = useState<PassedTest | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  // The user tried to test or add without a model in effect.
  const [modelAsked, setModelAsked] = useState(false);

  const running = useRef<{ what: 'load' | 'test'; controller: AbortController } | null>(null);
  const focusAfter = useRef<'model' | 'save' | 'test' | 'refresh' | null>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () => () => {
      running.current?.controller.abort();
      running.current = null;
    },
    [],
  );

  // The Test and Refresh buttons are disabled while they run, which drops
  // the focus. Once they are back, put the focus on the next step.
  useEffect(() => {
    if (busy !== null || focusAfter.current === null) return;
    ({ model: modelRef, save: saveRef, test: testRef, refresh: refreshRef })[focusAfter.current].current?.focus();
    focusAfter.current = null;
  }, [busy]);

  const kind = kinds[form.kind];
  const urlRequired = baseUrlRequired(form.kind);
  // No server is named yet: there is no endpoint to list or remember models for.
  const urlMissing = urlRequired && form.baseUrl.trim() === '';
  const outlook = outlookOf(form, provider, kinds);
  const host = hostOf(outlook.nextBaseUrl);
  const modelInUse = form.model.trim() || kind.defaultModel;
  // The list of the endpoint in the form. A loaded one is remembered too, so this is read again with each new listing.
  const known = useMemo<RememberedModels | null>(
    () => (listing?.models && listing.models.length > 0 ? { models: listing.models, at: listing.at } : urlMissing ? null : rememberedModels(form.kind, outlook.nextBaseUrl)),
    [listing, urlMissing, form.kind, outlook.nextBaseUrl],
  );
  const models = known?.models ?? null;
  const keyMissing = outlook.keyRequired && !outlook.keyWillBeSet;
  // A failure the test's own callout does not already report.
  const listFailed = listing?.error != null && listing.error !== test?.error ? listing.error : null;
  const passed = testPassedFor(form, kinds, lastPass);
  const testNeeded = needsTest(form, provider, kinds, lastPass);
  // The flow is not complete: a new provider needs a model and a passed test, a saved one only a test of a new connection.
  const blocked = (adding && modelInUse === null) || testNeeded;

  /** Cancel a running load or test. */
  const stop = () => {
    running.current?.controller.abort();
    running.current = null;
    setBusy(null);
  };

  /**
   * A change to the kind, server or key. A test result and the models loaded
   * belong to the old ones; what passed a test is kept, for when the form
   * comes back to it.
   */
  const reconnect = (change: Partial<ProviderForm>) => {
    stop();
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

  /** Where the test sends the level, a result of another level no longer stands; the models loaded still do. */
  const setEffort = (effort: AiEffort | null) => {
    if (effortTested(form.kind)) {
      if (running.current?.what === 'test') stop();
      setTest(null);
      setTestError(null);
    }
    setForm((f) => ({ ...f, effort }));
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
  const urlError = baseUrlProblem(form.baseUrl, form.kind);
  const patch = provider ? patchBody(form, provider, kinds) : null;
  const dirty = patch === null || Object.keys(patch).length > 0;
  const canSave = nameLen > 0 && !nameError && !modelError && dirty;

  const saveFields = validationFields(saveError);
  const testFields = validationFields(testError);
  const serverError = (field: 'name' | 'model' | 'baseUrl' | 'apiKey' | 'effort'): string | null => {
    const problem = saveFields[field] ?? testFields[field];
    return problem != null ? sentence(String(problem)) : null;
  };
  const onField = (fields: Record<string, unknown>) => ['name', 'model', 'baseUrl', 'apiKey', 'effort'].some((f) => fields[f] != null);
  const baseUrlError = (urlChecked ? urlError : null) ?? serverError('baseUrl');

  const begin = (what: 'load' | 'test') => {
    running.current?.controller.abort();
    const controller = new AbortController();
    running.current = { what, controller };
    setBusy(what);
    return controller;
  };

  const end = (controller: AbortController) => {
    if (running.current?.controller !== controller) return;
    running.current = null;
    setBusy(null);
  };

  /** Show and remember a list the service gave, or why it gave none. */
  const list = (listed: string[] | null, error: string | null) => {
    setListing({ models: listed, error, at: new Date().toISOString() });
    if (listed) rememberModels(form.kind, outlook.nextBaseUrl, listed);
  };

  const loadModels = async (from: LoadFrom) => {
    if (running.current !== null) return;
    if (urlError) {
      if (from !== 'open') setUrlChecked(true);
      return;
    }
    const controller = begin('load');
    try {
      const result = await api.settings.listModels(modelsBody(form, provider, kinds), controller.signal);
      if (controller.signal.aborted) return;
      list(result.models, result.error);
      // Models to pick from and none picked: picking one is the next step.
      if (from !== 'open') focusAfter.current = result.models?.length && form.model.trim() === '' ? 'model' : from === 'button' ? 'refresh' : null;
    } catch (e) {
      if (!isAbort(e) && !controller.signal.aborted) list(null, errorLine(e));
    } finally {
      end(controller);
    }
  };

  // A saved provider opens with its models offered: loaded once, unless they are remembered or a required key is missing.
  useEffect(() => {
    if (provider !== null && known === null && !keyMissing) void loadModels('open');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only as the dialog opens
  }, []);

  /** Without a model there is nothing to test: point at the field instead. */
  const askForModel = () => {
    setModelAsked(true);
    modelRef.current?.focus();
  };

  const runTest = async () => {
    if (urlError) {
      setUrlChecked(true);
      return;
    }
    if (modelInUse === null) {
      askForModel();
      return;
    }
    const sentFor = passedTestOf(form, kinds);
    const controller = begin('test');
    setTest(null);
    setTestError(null);
    try {
      const result = await api.settings.testAi(testBody(form, provider, kinds), controller.signal);
      if (controller.signal.aborted) return;
      setTest(result);
      // A failure since the last pass leaves the connection untested again.
      setLastPass(result.ok && result.model !== null ? sentFor : null);
      list(result.models, result.modelsError);
      focusAfter.current = result.ok && canSave ? 'save' : 'test';
    } catch (e) {
      if (!isAbort(e) && !controller.signal.aborted) setTestError(e);
    } finally {
      end(controller);
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
    // The button is disabled then; Enter in a field still gets here, and is led to the missing step.
    if (blocked) {
      if (modelInUse === null) askForModel();
      else testRef.current?.focus();
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

  /** Enter in a field of the connection loads the models, as the next step of the form, rather than saving. */
  const loadOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!saving) void loadModels('enter');
  };

  const keyHint = (provider?.apiKeyHint ?? '').replace(/^…/, '');
  /** The default stays selected when it is no longer ready, and AI features are then off. */
  const breaksDefault = provider?.isDefault === true && provider.ready && outlook.missing.length > 0;

  // The footer's word on saving: the next step of the flow, or what saving leads to.
  const note: { text: string; tone?: 'is-ok' | 'is-warn' } | null =
    !adding && !dirty
      ? { text: 'No unsaved changes.' }
      : (adding || testNeeded) && modelInUse === null
        ? { text: 'Pick a model, then test the connection.' }
        : testNeeded
          ? { text: adding ? 'Test the connection to add it.' : 'Test the connection to save it.' }
          : breaksDefault
            ? { text: `This is the default provider. Saving it without ${listNeeds(outlook.missing)} turns AI features off.`, tone: 'is-warn' }
            : !adding && outlook.missing.length > 0
              ? { text: `Can be saved now; it still needs ${listNeeds(outlook.missing)}.` }
              : passed
                ? { text: adding ? 'Tested. Ready to add.' : 'Tested. Save to keep it.', tone: 'is-ok' }
                : null;

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
          <span className={cx('dialog-note', note?.tone)} role="status">
            {/* A note may wrap, so it changes whole, its check mark with it. */}
            <TextSwap swapKey={note?.text ?? ''}>
              {note?.tone === 'is-ok' && <CheckCircle2 size={14} aria-hidden="true" />}
              {note?.text}
            </TextSwap>
          </span>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button ref={saveRef} variant="primary" type="submit" form="provider-form" busy={saving} disabled={blocked}>
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

        <Field label="Name" inlineError error={nameError ?? serverError('name')} hint={nameLen > bounds.nameMax * 0.75 ? `${nameLen} / ${bounds.nameMax}` : undefined}>
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
            // A text field drawn masked: with a password field in the form, browsers take it for a login and
            // offer their password manager on the Name field. Where the masking is not supported, a password field.
            type={MASKED_TEXT ? 'text' : 'password'}
            className="input-secret"
            value={form.apiKey}
            onChange={(v) => reconnect({ apiKey: v, removeKey: false })}
            onKeyDown={loadOnEnter}
            placeholder={outlook.savedKeyDropped ? 'Paste the key for this server…' : provider?.apiKeySet ? 'Enter a new key to replace the current one…' : 'Paste the key…'}
            name="api-key"
            // Password managers are told to pass over it; "new-password" for when it is a password field,
            // where browsers ignore "off".
            autoComplete={MASKED_TEXT ? 'off' : 'new-password'}
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
              The saved key belongs to <code translate="no">{hostOf(outlook.currentBaseUrl)}</code> and is never sent to a different server. Saving this base URL deletes it, and the model list and connection test run
              without it.{' '}
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
          <p className="field-hint">Keys are write only. Only the last four characters are shown.</p>
        </div>

        {urlRequired || urlOpen || baseUrlError ? (
          <TextField
            label={urlRequired ? 'Base URL' : 'Base URL (optional)'}
            inlineError
            type="url"
            value={form.baseUrl}
            onChange={(v) => reconnect({ baseUrl: v, name: named ? form.name : suggestName(form.kind, v, settings.providers, kinds) })}
            onBlur={() => setUrlChecked(true)}
            onKeyDown={loadOnEnter}
            placeholder={urlRequired ? `e.g. ${kind.defaultBaseUrl}…` : kind.defaultBaseUrl}
            hint={urlRequired ? undefined : `Leave empty to use ${kind.defaultBaseUrl}. Only needed for a proxy or gateway.`}
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
              Use a proxy or gateway
            </button>
          </div>
        )}

        <ModelField
          value={form.model}
          onChange={setModel}
          models={models}
          loading={busy === 'load'}
          onLoad={(from) => void loadModels(from)}
          loadOnFocus={listing === null && !keyMissing && !urlError}
          refreshDisabled={saving || testing}
          inputRef={modelRef}
          refreshRef={refreshRef}
          placeholder={modelPlaceholder(form.kind, kinds, models !== null)}
          maxLength={limits?.maxModelIdChars}
          error={modelError ?? serverError('model') ?? (modelAsked && modelInUse === null ? 'Pick a model to test the connection.' : null)}
          hint={
            busy === 'load'
              ? 'Loading models…'
              : listFailed !== null
                ? `The models could not be loaded: ${sentence(listFailed)}`
                : known
                  ? `${plural(known.models.length, 'model')} from ${host}, loaded ${relativeTime(known.at)}.`
                  : listing?.models?.length === 0
                    ? `${host} lists no models.`
                    : kind.defaultModel
                      ? `Leave empty to use ${kind.defaultModel}.`
                      : undefined
          }
        />

        <SelectField label="Effort level" look="combo" className="effort-select" value={form.effort ?? DEFAULT_EFFORT} onChange={(v) => setEffort(v || null)} options={EFFORT_OPTIONS} error={serverError('effort')} />

        <div className="form-actions">
          <Button ref={testRef} icon={<PlugZap size={14} />} onClick={() => void runTest()} busy={testing} disabled={saving}>
            Test connection
          </Button>
        </div>
        {test?.ok && (
          <Callout tone="ok" role="status" title="The connection works" className="reveal">
            {test.model !== null ? (
              <>
                <code translate="no">{test.model}</code> answered{test.latencyMs != null ? ` in ${formatMs(test.latencyMs)}` : ''}.
              </>
            ) : (
              <>The service answered.</>
            )}
          </Callout>
        )}
        {test && !test.ok && (
          <Callout tone="danger" role="alert" title="Connection failed" className="reveal">
            {test.error ? sentence(test.error) : 'The provider did not accept the request.'}
          </Callout>
        )}
        {testError != null && !onField(testFields) && <ErrorCallout error={testError} title="The test could not be run" />}

        {adding && <Checkbox checked={asDefault} onChange={setAsDefault} label="Use as the default" hint="Drafting, test cases and variants use the default provider." />}
        {saveError != null && !onField(saveFields) && (
          <ErrorCallout error={saveError} title={adding && isApiError(saveError) && saveError.code === 'conflict' ? 'Provider limit reached' : 'Could not save the provider'} />
        )}
      </form>
    </Dialog>
  );
}
