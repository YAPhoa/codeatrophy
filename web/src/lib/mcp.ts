// Connection details for the MCP endpoint, as shown in Settings.

export interface McpConnection {
  url: string;
  /** Command for Claude Code. */
  claudeCommand: string;
  /** Bridge command for clients that only speak stdio. */
  stdioCommand: string;
}

const TOKEN_PLACEHOLDER = '<your-token>';

/**
 * The public URL of the MCP endpoint: the one the operator configured, or
 * failing that the page's own origin plus the endpoint path.
 */
export function mcpUrl(mcp: { path: string; url?: string | null }, origin: string): string {
  if (mcp.url) return mcp.url;
  return origin.replace(/\/+$/, '') + (mcp.path.startsWith('/') ? mcp.path : `/${mcp.path}`);
}

export function mcpConnection(url: string, authRequired: boolean): McpConnection {
  const header = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`;
  return {
    url,
    claudeCommand: authRequired
      ? `claude mcp add --transport http codeathropy ${url} --header "${header}"`
      : `claude mcp add --transport http codeathropy ${url}`,
    stdioCommand: authRequired ? `npx mcp-remote ${url} --header "${header}"` : `npx mcp-remote ${url}`,
  };
}
