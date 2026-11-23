import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { api, validationFields } from '../../api/client';
import { useLimits } from '../../api/queries';
import type { McpTokenCreated, Meta } from '../../api/types';
import { useAuth } from '../../app/AuthGate';
import { absoluteTime, relativeTime } from '../../lib/format';
import { mcpConnection, mcpUrl } from '../../lib/mcp';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Badge, Callout, CopyButton, ErrorCallout } from '../../ui/misc';
import { useToast } from '../../ui/Toast';

export function JudgeSection({ meta }: { meta: Meta }) {
  const { judge } = meta;
  return (
    <section className="settings-section" aria-labelledby="judge-title">
      <div className="row">
        <h1 id="judge-title" className="page-title">
          Judge
        </h1>
        {!judge.enabled ? <Badge>Not configured</Badge> : judge.healthy ? <Badge tone="ok">Healthy</Badge> : <Badge tone="danger">Not responding</Badge>}
      </div>
      <p className="settings-lead">The judge engine runs code in a sandbox: your solutions when you run or submit, and reference solutions when test cases are verified.</p>
      {!judge.enabled ? (
        <Callout tone="info" title="No judge engine is configured">
          You can still read, write and organise problems, but code cannot be run or submitted, and AI-generated test cases stay unverified. The judge engine is set in the server’s deployment
          (the Compose stack and its environment variables), not on this page.
        </Callout>
      ) : (
        <>
          {!judge.healthy && (
            <Callout tone="warn" role="status" title="The judge engine is not responding">
              The last health check failed, so runs and submissions will end in a judge error until it is back. This status can lag by a few seconds.
            </Callout>
          )}
          <div className="card">
            <table className="table">
              <caption className="table-caption">
                Engine <code translate="no">{judge.engine}</code> · {judge.languages.length} languages available
              </caption>
              <thead>
                <tr>
                  <th scope="col">Language</th>
                  <th scope="col">Version</th>
                  <th scope="col">Id</th>
                </tr>
              </thead>
              <tbody>
                {judge.languages.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="mono">{l.version}</td>
                    <td className="mono muted">{l.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="copy-row">
      <div className="copy-label">{label}</div>
      <code translate="no" className="copy-value">{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

export function McpSection({ meta }: { meta: Meta }) {
  const { mcp } = meta;
  const { session } = useAuth();
  // Account tokens exist only while sign-in is on.
  const tokens = mcp.enabled && !!session?.enabled && !!session.user;
  const conn = mcpConnection(mcpUrl(mcp, window.location.origin), mcp.authRequired);
  return (
    <section className="settings-section" aria-labelledby="mcp-title">
      <div className="row">
        <h1 id="mcp-title" className="page-title">
          MCP server
        </h1>
        {mcp.enabled ? <Badge tone="ok">Enabled</Badge> : <Badge>Disabled</Badge>}
        {mcp.enabled && (mcp.authRequired ? <Badge tone="accent">Token required</Badge> : <Badge>No token</Badge>)}
      </div>
      <p className="settings-lead">
        The Model Context Protocol (MCP) endpoint lets an AI assistant browse, write and edit your library on your behalf, for example “add this problem to my DP collection and write tests for it”. Connected assistants use
        their own model and do not use the <Link to="/settings/ai">AI providers</Link> set up here.
      </p>
      {!mcp.enabled ? (
        <Callout tone="info" title="The MCP endpoint is turned off">
          It is disabled in the server’s configuration (<code translate="no">CODEATROPHY_MCP_ENABLED=false</code>). Remove that setting and restart the server to enable it.
        </Callout>
      ) : (
        <>
          <div className="card card-pad stack">
            <CopyRow label="Endpoint (Streamable HTTP)" value={conn.url} />
            <CopyRow label="Connect Claude Code" value={conn.claudeCommand} />
            <CopyRow label="Clients that only speak stdio" value={conn.stdioCommand} />
            {!mcp.url && (
              <p className="field-hint">
                The address above is taken from this page. If assistants reach the server under a different address (through a reverse proxy, for example), set <code translate="no">CODEATROPHY_PUBLIC_URL</code> on the
                server and it will be shown here instead.
              </p>
            )}
            {mcp.authRequired && tokens ? (
              <p className="field-hint">
                This server requires a bearer token: make one under Tokens below, or replace <code translate="no">&lt;your-token&gt;</code> with the value of{' '}
                <code translate="no">CODEATROPHY_MCP_TOKEN</code> from the server’s configuration.
              </p>
            ) : mcp.authRequired ? (
              <p className="field-hint">
                This server requires a bearer token: replace <code translate="no">&lt;your-token&gt;</code> with the value of <code translate="no">CODEATROPHY_MCP_TOKEN</code> from the server’s configuration.
              </p>
            ) : (
              <p className="field-hint">
                No token is required, which is fine while the server is only reachable from this machine. Set <code translate="no">CODEATROPHY_MCP_TOKEN</code> before exposing it on a network.
              </p>
            )}
          </div>
          {tokens && <McpTokens url={conn.url} />}
        </>
      )}
    </section>
  );
}

const TOKENS_KEY = ['auth', 'mcp-tokens'] as const;

/**
 * The signed-in account's tokens for MCP clients: make one per client, see
 * when each was last used, revoke one. A new token is shown once, with the
 * command that connects Claude Code using it.
 */
function McpTokens({ url }: { url: string }) {
  const qc = useQueryClient();
  const limits = useLimits();
  const confirm = useConfirm();
  const toast = useToast();
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
      const problem = validationFields(err).name;
      if (problem !== undefined) {
        setNameError(`Name ${String(problem)}.`);
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

  const command = made ? mcpConnection(url, true).claudeCommand.replace('<your-token>', made.token) : '';

  return (
    <div className="card card-pad prefs-group" role="group" aria-labelledby="mcp-tokens-title">
      <h2 id="mcp-tokens-title" className="prefs-group-title">
        Tokens
      </h2>
      <p className="field-hint mcp-tokens-lead">
        An assistant signs in with a token instead of a password. Make one for each machine or assistant, so that you can revoke it alone. A token can do anything you can.
      </p>
      {made && (
        <Callout tone="ok" title={`Token “${made.name}” created`} role="status">
          <p>Copy it now: it is not shown again.</p>
          <div className="stack mcp-token-copy">
            <CopyRow label="Token" value={made.token} />
            <CopyRow label="Connect Claude Code" value={command} />
          </div>
        </Callout>
      )}
      <form className="mcp-token-form" onSubmit={submit} noValidate>
        <Field label="New token name" error={nameError} hideLabel>
          {(p) => (
            <input
              {...p}
              className="input"
              placeholder="Name, e.g. Laptop – Claude Code"
              maxLength={limits?.maxMcpTokenNameChars}
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
        <ul className="mcp-token-list" aria-label="Tokens">
          {tokens.data.items.map((t) => (
            <li key={t.id} className="mcp-token">
              <KeyRound size={16} aria-hidden="true" className="mcp-token-icon" />
              <div className="mcp-token-main">
                <div className="mcp-token-name">{t.name}</div>
                <div className="mcp-token-meta">
                  <code translate="no">cat_…{t.hint}</code> · made{' '}
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
