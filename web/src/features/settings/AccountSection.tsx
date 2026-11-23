import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import { api, isApiError, validationFields } from '../../api/client';
import { useLimits } from '../../api/queries';
import type { BrowserSession } from '../../api/types';
import { useAuth, useSignOut } from '../../app/AuthGate';
import { absoluteTime, relativeTime } from '../../lib/format';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Badge, Callout, ErrorCallout } from '../../ui/misc';
import { useToast } from '../../ui/Toast';

const SESSIONS_KEY = ['auth', 'sessions'] as const;

/** Settings › Account: who is signed in, changing the password, the account's sessions. */
export function AccountSection() {
  const { session } = useAuth();
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
          <div className="card card-pad prefs-group account-who" role="group" aria-label="Signed in">
            <p>
              Signed in as <strong>{session.user.email}</strong>.
            </p>
            <p className="field-hint">
              Everyone on this server shares the library. Your progress, notes, collections, code, submissions, drafts, AI history and preferences are yours alone.
            </p>
          </div>
          <PasswordForm />
          <Sessions />
          <SignOut />
        </>
      )}
    </section>
  );
}

/** Signs this browser out, after asking (`useSignOut`). */
function SignOut() {
  const signOut = useSignOut();
  return (
    <div className="card card-pad prefs-group" role="group" aria-labelledby="account-signout-title">
      <div className="prefs-row account-signout">
        <div className="prefs-row-text">
          <div id="account-signout-title" className="prefs-row-label">
            Sign out
          </div>
          <div className="field-hint">Sign out from this browser.</div>
        </div>
        <Button variant="danger-soft" icon={<LogOut size={16} />} onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function SessionIcon({ browser }: { browser: string }) {
  const Icon = / on (iPhone|iPod|Android)$/.test(browser) ? Smartphone : / on iPad$/.test(browser) ? Tablet : Monitor;
  return <Icon size={16} aria-hidden="true" className="mcp-token-icon" />;
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

/** The browsers signed in to the account; the others can be revoked from here. */
function Sessions() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: ({ signal }) => api.auth.sessions.list(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: SESSIONS_KEY });

  const end = useMutation({
    mutationFn: (s: BrowserSession) => api.auth.sessions.end(s.id),
    onSuccess: (_, s) => {
      toast.success(`Signed out ${s.browser}`);
      refresh();
    },
    onError: (err) => {
      toast.error(err);
      refresh();
    },
  });
  const endOthers = useMutation({
    mutationFn: () => api.auth.sessions.endOthers(),
    onSuccess: () => {
      toast.success('Other browsers signed out');
      refresh();
    },
    onError: (err) => toast.error(err),
  });

  const items = sessions.data?.items ?? [];
  return (
    <div className="card card-pad prefs-group" role="group" aria-labelledby="account-sessions-title">
      <div className="account-sessions-head">
        <h2 id="account-sessions-title" className="prefs-group-title">
          Sessions
        </h2>
        {items.length > 1 && (
          <Button
            size="sm"
            busy={endOthers.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: 'Sign out other browsers?',
                body: 'They will need the password to sign in again.',
                confirmLabel: 'Sign out',
                danger: true,
              });
              if (ok) endOthers.mutate();
            }}
          >
            Sign out other browsers
          </Button>
        )}
      </div>
      {sessions.isError ? (
        <ErrorCallout error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : items.length > 0 ? (
        <ul className="mcp-token-list" aria-label="Sessions">
          {items.map((s) => (
            <li key={s.id} className="mcp-token">
              <SessionIcon browser={s.browser} />
              <div className="mcp-token-main">
                <div className="mcp-token-name account-session-name">
                  {s.browser}
                  {s.current && <Badge tone="accent">This browser</Badge>}
                </div>
                <div className="mcp-token-meta">
                  signed in <When iso={s.createdAt} /> · active <When iso={s.lastUsedAt} />
                </div>
              </div>
              {/* This browser is signed out with the Sign out button below, never revoked from the list. */}
              {!s.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  busy={end.isPending && end.variables?.id === s.id}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Revoke ${s.browser}?`,
                      body: 'That browser will need the password to sign in again.',
                      confirmLabel: 'Revoke',
                      danger: true,
                    });
                    if (ok) end.mutate(s);
                  }}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PasswordForm() {
  const qc = useQueryClient();
  const limits = useLimits();
  const toast = useToast();
  const email = useAuth().session?.user?.email ?? '';
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ next?: string; confirm?: string; form?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (next !== confirm) {
      setErrors({ confirm: 'The passwords differ.' });
      return;
    }
    setBusy(true);
    try {
      await api.auth.changePassword({ newPassword: next });
      setNext('');
      setConfirm('');
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      toast.success('Password changed. Other browsers signed in to this account were signed out.');
    } catch (err) {
      const newPassword = validationFields(err).newPassword;
      if (newPassword !== undefined) {
        const problem = String(newPassword);
        setErrors({ next: problem.charAt(0).toUpperCase() + problem.slice(1) + '.' });
      } else {
        setErrors({ form: isApiError(err) ? err.message : 'The password could not be changed.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card card-pad prefs-group" onSubmit={submit} noValidate aria-labelledby="account-password-title">
      <h2 id="account-password-title" className="prefs-group-title">
        Change password
      </h2>
      {/* Lets a password manager tie the new password to the account. */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      {errors.form && (
        <Callout tone="danger" role="alert">
          {errors.form}
        </Callout>
      )}
      <div className="account-fields">
        <Field label="New password" error={errors.next} hint={limits && `At least ${limits.minPasswordChars} characters.`}>
          {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Field label="Repeat the new password" error={errors.confirm}>
          {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" busy={busy} disabled={!next || !confirm}>
          Change password
        </Button>
      </div>
    </form>
  );
}
