import { Link } from 'react-router';
import type { Meta } from '../../api/types';
import { mcpConnection, mcpUrl } from '../../lib/mcp';
import { Badge, Callout, CopyButton } from '../../ui/misc';

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
          Problems can be read, organised and written, but code cannot be run or submitted, and AI-generated test cases stay unverified. The engine is part of the server’s deployment (the Compose
          stack and its environment variables), not something set from this page.
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

function CopyRow({ label, value }: { label: string; value: string }) {
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
        The Model Context Protocol endpoint lets an AI assistant browse, write and edit this library on your behalf, for example “add this problem to my DP collection and write tests for it”. The assistant you
        connect is the model; it does not use the <Link to="/settings/ai">AI providers</Link> set up here.
      </p>
      {!mcp.enabled ? (
        <Callout tone="info" title="The MCP endpoint is turned off">
          It is disabled in the server’s configuration (<code translate="no">CODEATROPHY_MCP_ENABLED=false</code>). Remove that setting and restart the server to enable it.
        </Callout>
      ) : (
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
          {mcp.authRequired ? (
            <p className="field-hint">
              This server requires a bearer token. Replace <code translate="no">&lt;your-token&gt;</code> with the value of <code translate="no">CODEATROPHY_MCP_TOKEN</code> from the server’s configuration; the token is not shown
              here.
            </p>
          ) : (
            <p className="field-hint">
              No token is required, which is fine while the server is only reachable from this machine. Set <code translate="no">CODEATROPHY_MCP_TOKEN</code> before exposing it on a network.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
