import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Plus } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { useAuth } from '../../app/AuthGate';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Callout, ErrorCallout } from '../../ui/misc';
import { useConfirm } from '../../ui/Dialog';
import { absoluteTime, relativeTime } from '../../lib/format';
import { mcpConnection, mcpUrl } from '../../lib/mcp';
import { useMeta } from '../../api/queries';
import type { McpTokenCreated } from '../../api/types';
import { CopyRow } from './ServiceSections';
import { useToast } from '../../ui/Toast';

/** Settings › Account: who is signed in, changing the password, signing out. */
export function AccountSection() {
  const { session, signOut } = useAuth();
  return (
    <section className="settings-section" aria-labelledby="account-title">
      <h1 id="account-title" className="page-title">
        Account
      </h1>
      {!session?.enabled || !session.user ? (
        <Callout tone="info" title="Sign-in is turned off">
          Anyone who can reach this server can use it without signing in (<code translate="no">CODEATROPHY_AUTH=off</code>). Remove that setting and restart the server to require a password.
        </Callout>
      ) : (
        <>
          <p className="settings-lead">
            Signed in as <strong>{session.user.email}</strong>. A sign-in lasts until you have not used the app here for a while, or until you sign out.
          </p>
          <p className="settings-lead">
            Other accounts on this server share the library. Your progress (status, favorites, notes), code, submissions, drafts, AI jobs and log, and preferences are yours alone.
          </p>
          <div className="account-row">
            <Button icon={<LogOut size={16} />} onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
          <h2 className="prefs-group-title">MCP tokens</h2>
          <McpTokens />
          <h2 className="prefs-group-title">Change password</h2>
          <PasswordForm />
        </>
      )}
    </section>
  );
}

function PasswordForm() {
  const toast = useToast();
  const email = useAuth().session?.user?.email ?? '';
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{
    current?: string;
    next?: string;
    confirm?: string;
    form?: string;
  }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (next !== confirm) {
      setErrors({ confirm: 'The passwords differ.' });
      return;
    }
    setBusy(true);
    try {
      await api.auth.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Password changed. Other browsers signed in to this account were signed out.');
    } catch (err) {
      if (isApiError(err) && err.code === 'validation_failed') {
        const f = err.fields;
        const sentence = (v: unknown) => (v === undefined ? undefined : String(v).charAt(0).toUpperCase() + String(v).slice(1) + '.');
        setErrors({
          current: sentence(f.currentPassword),
          next: sentence(f.newPassword),
        });
      } else {
        setErrors({
          form: isApiError(err) ? err.message : 'The password could not be changed.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card card-pad account-card" onSubmit={submit} noValidate>
      {/* Lets a password manager tie the new password to the account. */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      {errors.form && (
        <Callout tone="danger" role="alert">
          {errors.form}
        </Callout>
      )}
      <Field label="Current password" error={errors.current}>
        {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      </Field>
      <Field label="New password" error={errors.next} hint="At least 8 characters.">
        {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <Field label="Repeat the new password" error={errors.confirm}>
        {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      <div>
        <Button type="submit" variant="primary" busy={busy} disabled={!current || !next || !confirm}>
          Change password
        </Button>
      </div>
    </form>
  );
}

const TOKENS_KEY = ['auth', 'mcp-tokens'] as const;

/**
 * The account's tokens for MCP clients: make one per client, see when each
 * was last used, revoke one. A new token is shown once, with the command
 * that connects Claude Code using it.
 */
function McpTokens() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const meta = useMeta().data;
  const tokens = useQuery({ queryKey: TOKENS_KEY, queryFn: ({ signal }) => api.auth.mcpTokens.list(signal) });
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [made, setMade] = useState<McpTokenCreated | null>(null);

  const create = useMutation({
    mutationFn: (n: string) => api.auth.mcpTokens.create(n),
    onSuccess: (t) => {
      setMade(t);
      setName('');
      void qc.invalidateQueries({ queryKey: TOKENS_KEY });
    },
    onError: (err) => {
      if (isApiError(err) && err.code === 'validation_failed' && err.fields.name !== undefined) {
        setNameError(`Name ${String(err.fields.name)}.`);
      } else {
        toast.error(err);
      }
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.auth.mcpTokens.revoke(id),
    onSuccess: (_, id) => {
      if (made?.id === id) setMade(null);
      toast.success('Token revoked');
      void qc.invalidateQueries({ queryKey: TOKENS_KEY });
    },
    onError: (err) => toast.error(err),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNameError(null);
    if (!name.trim()) {
      setNameError('Give the token a name, such as the machine or assistant it is for.');
      return;
    }
    create.mutate(name);
  };

  const url = meta ? mcpUrl(meta.mcp, window.location.origin) : `${window.location.origin}/mcp`;
  const command = made ? mcpConnection(url, true).claudeCommand.replace('<your-token>', made.token) : '';

  return (
    <div className="card card-pad account-card account-tokens">
      <p className="field-hint account-tokens-lead">
        An AI assistant connected over MCP signs in with a token instead of a password. Make one for each machine or assistant, so that you can revoke it alone. A token can do anything you can.
      </p>
      {made && (
        <Callout tone="ok" title={`Token “${made.name}” created`} role="status">
          <p>Copy it now: it is not shown again.</p>
          <div className="stack account-token-copy">
            <CopyRow label="Token" value={made.token} />
            <CopyRow label="Connect Claude Code" value={command} />
          </div>
        </Callout>
      )}
      <form className="account-token-form" onSubmit={submit} noValidate>
        <Field label="New token name" error={nameError} hideLabel>
          {(p) => (
            <input
              {...p}
              className="input"
              placeholder="Name, e.g. Laptop – Claude Code"
              maxLength={60}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
            />
          )}
        </Field>
        <Button type="submit" icon={<Plus size={16} />} busy={create.isPending}>
          Create token
        </Button>
      </form>
      {tokens.isError ? (
        <ErrorCallout error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : tokens.data && tokens.data.items.length > 0 ? (
        <ul className="account-token-list">
          {tokens.data.items.map((t) => (
            <li key={t.id} className="account-token">
              <KeyRound size={16} aria-hidden="true" className="account-token-icon" />
              <div className="account-token-main">
                <div className="account-token-name">{t.name}</div>
                <div className="account-token-meta">
                  <code translate="no">cat_…{t.hint}</code> · created{' '}
                  <time dateTime={t.createdAt} title={absoluteTime(t.createdAt)}>
                    {relativeTime(t.createdAt)}
                  </time>{' '}
                  ·{' '}
                  {t.lastUsedAt ? (
                    <>
                      last used{' '}
                      <time dateTime={t.lastUsedAt} title={absoluteTime(t.lastUsedAt)}>
                        {relativeTime(t.lastUsedAt)}
                      </time>
                    </>
                  ) : (
                    'never used'
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                busy={revoke.isPending && revoke.variables === t.id}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Revoke the token “${t.name}”?`,
                    body: 'Assistants that use it lose access at once. This cannot be undone; make a new token to connect them again.',
                    confirmLabel: 'Revoke token',
                    danger: true,
                  });
                  if (ok) revoke.mutate(t.id);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : tokens.data ? (
        <p className="field-hint">No tokens yet.</p>
      ) : null}
    </div>
  );
}
