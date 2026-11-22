import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { SIGNED_OUT_EVENT, api, isApiError, type ApiError } from '../api/client';
import type { AuthSession } from '../api/types';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Logo } from '../ui/Logo';
import { Callout } from '../ui/misc';
import { useDocumentTitle } from './useDocumentTitle';

const SESSION_KEY = ['auth', 'session'] as const;

interface AuthValue {
  /** The session as the server reported it; null when it could not be read. */
  session: AuthSession | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({
  session: null,
  signOut: async () => {},
});

/** Who is signed in, and a way to sign out. */
export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

/** Drops every cached answer but the session, so nothing of one sign-in shows in the next. */
function forgetLibrary(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
}

/**
 * Shows the sign-in page in place of the app while sign-in is on and nobody
 * is signed in. With sign-in off (`CODEATROPHY_AUTH=off`) it shows the app
 * at once. A request refused because the session ended brings the sign-in
 * page back; signing in returns to the same address.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => api.auth.session(signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const onSignedOut = () => {
      qc.setQueryData<AuthSession>(SESSION_KEY, (s) => (s && s.enabled ? { ...s, user: null } : s));
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [qc]);

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      qc.setQueryData<AuthSession>(SESSION_KEY, (s) => (s ? { ...s, user: null } : s));
      forgetLibrary(qc);
    }
  }, [qc]);

  const session = query.data ?? null;
  const value = useMemo(() => ({ session, signOut }), [session, signOut]);

  if (query.isPending) return null;
  if (session?.enabled && !session.user) {
    return (
      <SignInPage
        setup={session.setupRequired}
        onSignedIn={(next) => {
          forgetLibrary(qc);
          qc.setQueryData(SESSION_KEY, next);
        }}
      />
    );
  }
  // When the session cannot be read (the server is down), the app shows that itself.
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

type FieldErrors = Partial<Record<'email' | 'password' | 'confirm', string>>;

/** The server's per-field messages, worded for the form ("is required" → "Required."). */
function fieldErrors(err: ApiError): FieldErrors {
  const out: FieldErrors = {};
  for (const [field, msg] of Object.entries(err.fields)) {
    const text = String(msg);
    const sentence = text.charAt(0).toUpperCase() + text.slice(1) + '.';
    if (field === 'email' || field === 'password') out[field] = sentence;
  }
  return out;
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s;
}

/**
 * The sign-in page: the mark, the name and one small card, centred. While no
 * account exists it creates the first one instead.
 */
export function SignInPage({ setup, onSignedIn }: { setup: boolean; onSignedIn: (s: AuthSession) => void }) {
  useDocumentTitle(setup ? 'Create your account' : 'Sign in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFields({});
    if (setup && password !== confirm) {
      setFields({ confirm: 'The passwords differ.' });
      return;
    }
    setBusy(true);
    try {
      const next = setup ? await api.auth.setup({ email, password }) : await api.auth.login({ email, password });
      onSignedIn(next);
    } catch (err) {
      setBusy(false);
      if (!isApiError(err)) {
        setError('Something went wrong. Try again.');
        return;
      }
      if (err.code === 'validation_failed') {
        const fe = fieldErrors(err);
        setFields(fe);
        if (Object.keys(fe).length === 0) setError(capitalise(err.message));
        return;
      }
      if (err.code === 'conflict') {
        // Someone created the first account meanwhile: sign in instead.
        setError(capitalise(err.message));
        return;
      }
      setError(capitalise(err.message));
      if (err.code === 'unauthorized') setPassword('');
    }
  };

  return (
    <main className="signin">
      <div className="signin-inner">
        <div className="signin-brand">
          <Logo size={64} className="brand-mark" />
          <span className="signin-name" translate="no">
            Codeatrophy
          </span>
        </div>
        <form className="card signin-card" onSubmit={submit} noValidate>
          <h1 className="signin-title">{setup ? 'Create your account' : 'Sign in'}</h1>
          {setup && <p className="signin-lead">No account exists yet. Choose the email and password you will sign in with.</p>}
          {error && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}
          <Field label="Email" error={fields.email}>
            {(p) => (
              <input {...p} className="input" type="email" autoComplete={setup ? 'email' : 'username'} spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            )}
          </Field>
          <Field label="Password" error={fields.password} hint={setup ? 'At least 8 characters.' : undefined}>
            {(p) => (
              <input {...p} className="input" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
            )}
          </Field>
          {setup && (
            <Field label="Repeat the password" error={fields.confirm}>
              {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
            </Field>
          )}
          <Button type="submit" variant="primary" className="signin-submit" icon={<LogIn size={16} />} busy={busy}>
            {setup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
        {!setup && (
          <p className="signin-foot">
            Forgot your password? Reset it on the server with <code translate="no">codeatrophy user password &lt;email&gt;</code>.
          </p>
        )}
      </div>
    </main>
  );
}
