import { useState, type FormEvent } from "react";
import { LogOut } from "lucide-react";
import { api, isApiError } from "../../api/client";
import { useAuth } from "../../app/AuthGate";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Callout } from "../../ui/misc";
import { useToast } from "../../ui/Toast";

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
          Anyone who can reach this server can use it without signing in (
          <code translate="no">CODEATROPHY_AUTH=off</code>). Remove that setting
          and restart the server to require a password.
        </Callout>
      ) : (
        <>
          <p className="settings-lead">
            Signed in as <strong>{session.user.email}</strong>. A sign-in lasts
            until you have not used the app here for a while, or until you sign
            out.
          </p>
          <div className="account-row">
            <Button icon={<LogOut size={16} />} onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
          <h2 className="prefs-group-title">Change password</h2>
          <PasswordForm />
        </>
      )}
    </section>
  );
}

function PasswordForm() {
  const toast = useToast();
  const email = useAuth().session?.user?.email ?? "";
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
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
      setErrors({ confirm: "The passwords differ." });
      return;
    }
    setBusy(true);
    try {
      await api.auth.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success(
        "Password changed. Other browsers signed in to this account were signed out.",
      );
    } catch (err) {
      if (isApiError(err) && err.code === "validation_failed") {
        const f = err.fields;
        const sentence = (v: unknown) =>
          v === undefined
            ? undefined
            : String(v).charAt(0).toUpperCase() + String(v).slice(1) + ".";
        setErrors({
          current: sentence(f.currentPassword),
          next: sentence(f.newPassword),
        });
      } else {
        setErrors({
          form: isApiError(err)
            ? err.message
            : "The password could not be changed.",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card card-pad account-card" onSubmit={submit} noValidate>
      {/* Lets a password manager tie the new password to the account. */}
      <input
        type="email"
        autoComplete="username"
        value={email}
        readOnly
        hidden
      />
      {errors.form && (
        <Callout tone="danger" role="alert">
          {errors.form}
        </Callout>
      )}
      <Field label="Current password" error={errors.current}>
        {(p) => (
          <input
            {...p}
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="New password"
        error={errors.next}
        hint="At least 8 characters."
      >
        {(p) => (
          <input
            {...p}
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        )}
      </Field>
      <Field label="Repeat the new password" error={errors.confirm}>
        {(p) => (
          <input
            {...p}
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!current || !next || !confirm}
        >
          Change password
        </Button>
      </div>
    </form>
  );
}
