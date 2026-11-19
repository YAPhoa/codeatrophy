// Turn any thrown value into something that can be shown to a person. One
// place decides the wording for every error code in the API contract.

import { ApiError } from '../api/client';

export interface ErrorView {
  title: string;
  message: string;
  /** A suggested way forward, rendered as a link or button by the caller. */
  action?: 'ai-settings' | 'judge-settings' | 'retry' | 'reload';
  /** Per-field validation messages, when the server sent any. */
  fields?: Record<string, string>;
}

/**
 * Server messages are terse fragments ("not a zip archive"). Present them as
 * sentences, leaving ones that start with a field path ("problem.timeLimitMs
 * must be …") as they are.
 */
export function sentence(message: string): string {
  const text = message.trim();
  if (text === '') return text;
  const first = /^[a-z]+(?=[\s,:;]|$)/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}

/** True when a 403 is about the host name the request was addressed to, rather than the page it came from. */
function isHostRefusal(serverMessage: string): boolean {
  if (/ALLOWED_HOSTS/.test(serverMessage)) return true;
  return /\bhost\b/i.test(serverMessage) && !/\borigin\b/i.test(serverMessage);
}

/**
 * A 403 has two causes, and both are a matter of server configuration rather
 * than of anything the user did:
 *
 * - The server answers only requests addressed to a host name it knows
 *   (loopback, its public URL, an allowed host). This applies to every
 *   request, so the page may fail to load at all.
 * - The server accepts changes only from pages on its own origin. Reaching
 *   that from the app itself means the server sees a different address than
 *   the browser does, which a reverse proxy rewriting the Host header causes.
 *
 * The server's message names the setting to change, so it is shown first;
 * the explanation of what to do follows.
 */
function describeForbidden(serverMessage: string): ErrorView {
  const said = sentence(serverMessage);
  const lead = said ? `${said} ` : '';
  const namesSetting = /CODEATROPHY_[A-Z_]+/.test(serverMessage);
  const here = typeof window === 'undefined' ? null : window.location;
  if (isHostRefusal(serverMessage)) {
    const fix = namesSetting
      ? 'Whoever runs the server needs to change that setting and restart it.'
      : 'Whoever runs the server needs to set CODEATROPHY_PUBLIC_URL to this address, or add the host name to CODEATROPHY_ALLOWED_HOSTS, and restart it.';
    return {
      title: 'The server does not answer at this address',
      message: `${lead}It only answers requests addressed to a host name it has been told about, and ${here ? here.host : 'this one'} is not among them. ${fix}`,
      action: 'retry',
    };
  }
  const fix = namesSetting
    ? 'Whoever runs the server needs to change that setting and restart it.'
    : 'Whoever runs the server needs to set CODEATROPHY_PUBLIC_URL to this address, or add it to CODEATROPHY_ALLOWED_ORIGINS, and restart it.';
  return {
    title: 'The server refused this change',
    message: `${lead}It does not recognise ${here ? here.origin : 'this address'} as its own address, which usually means a reverse proxy sits in front of it. ${fix} Nothing was changed.`,
  };
}

export function describeError(err: unknown): ErrorView {
  if (!(err instanceof ApiError)) {
    return {
      title: 'Something went wrong',
      message: err instanceof Error && err.message ? err.message : 'An unexpected error occurred in the page.',
      action: 'reload',
    };
  }
  switch (err.code) {
    case 'bad_request':
      return { title: 'The request was not understood', message: sentence(err.message) };
    case 'forbidden':
      return describeForbidden(err.message);
    case 'not_found':
      return { title: 'Not found', message: 'It may have been deleted, or the link is out of date.' };
    case 'conflict':
      return err.isRevisionConflict
        ? {
            title: 'This item changed elsewhere',
            message:
              'It was edited in another tab or by an assistant connected over MCP after you opened it. Nothing was overwritten.',
            action: 'reload',
          }
        : { title: 'That change is not possible', message: sentence(err.message) };
    case 'too_large':
      return { title: 'Too large', message: sentence(err.message) || 'The upload or request exceeds the server limit.' };
    case 'validation_failed': {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(err.fields)) fields[k] = String(v);
      return { title: 'Please check the highlighted fields', message: sentence(err.message), fields };
    }
    case 'upstream_error':
      return {
        title: 'External service error',
        message: sentence(err.message) || 'The AI provider or judge engine returned an error.',
        action: 'retry',
      };
    case 'ai_unavailable':
      return {
        title: 'AI is off',
        message: 'AI features are switched off, or no default provider is ready. You can still write items by hand.',
        action: 'ai-settings',
      };
    case 'judge_unavailable':
      return {
        title: 'Code execution is unavailable',
        message: 'No judge engine is configured, or it cannot be reached right now.',
        action: 'judge-settings',
      };
    case 'internal':
      return {
        title: 'Server error',
        message: sentence(err.message) || 'The server hit an unexpected error. The server log has the details.',
        action: 'retry',
      };
    case 'network':
      return {
        title: 'Cannot reach the server',
        message: 'Check that the Codeatrophy server is running and that you can reach it.',
        action: 'retry',
      };
    case 'aborted':
      return { title: 'Cancelled', message: 'The request was cancelled.' };
    default:
      return { title: 'Unexpected response', message: err.message, action: 'retry' };
  }
}

/** One line for toasts: the specific message when the server gave one, else the generic title. */
export function errorLine(err: unknown): string {
  const view = describeError(err);
  if (err instanceof ApiError && (err.code === 'validation_failed' || err.code === 'bad_request' || err.code === 'conflict')) {
    return err.isRevisionConflict ? view.title : sentence(err.message) || view.title;
  }
  if (err instanceof ApiError && err.code === 'forbidden') {
    // The full explanation is too long for one line; the server's message names the setting.
    if (/CODEATROPHY_[A-Z_]+/.test(err.message)) return `${view.title}: ${sentence(err.message)}`;
    return isHostRefusal(err.message)
      ? `${view.title}. The server’s CODEATROPHY_PUBLIC_URL or CODEATROPHY_ALLOWED_HOSTS needs to include this host name.`
      : `${view.title}: it does not recognise this page’s address as its own. The server’s CODEATROPHY_PUBLIC_URL or CODEATROPHY_ALLOWED_ORIGINS needs to include it.`;
  }
  return view.message ? `${view.title}. ${view.message}` : view.title;
}
