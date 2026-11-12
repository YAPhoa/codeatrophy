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
      // The server only accepts changes from its own origin. Reaching this
      // from the app itself means the server sees a different address than
      // the browser does, which is what a reverse proxy that rewrites the
      // Host header causes.
      return {
        title: 'The server refused this change',
        message: `It does not recognise ${typeof window === 'undefined' ? 'this address' : window.location.origin} as its own address, which usually means a reverse proxy sits in front of it. Whoever runs the server needs to set CODEATHROPY_PUBLIC_URL to this address, or add it to CODEATHROPY_ALLOWED_ORIGINS, and restart. Nothing was changed.`,
      };
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
        title: 'The external service failed',
        message: sentence(err.message) || 'The AI provider or judge engine returned an error.',
        action: 'retry',
      };
    case 'ai_unavailable':
      return {
        title: 'AI is not set up',
        message: 'No AI provider is configured on this server. You can still write items by hand.',
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
        message: 'Check that Codeathropy is running and that you are connected to it.',
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
    return `${view.title}: it does not recognise this page’s address as its own. The server’s CODEATHROPY_PUBLIC_URL or CODEATHROPY_ALLOWED_ORIGINS needs to include it.`;
  }
  return view.message ? `${view.title}. ${view.message}` : view.title;
}
