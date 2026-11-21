// The working copies of a problem, bound to the API and the query cache:
// one saver per problem for the whole visit to the app, so that leaving the
// page and coming back never starts a second line of requests beside one
// still under way.

import type { QueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { setWorkingCopy } from '../../api/queries';
import { clearUnsaved, writeUnsaved } from '../../lib/codeStore';
import { byteLength } from '../../lib/itemForm';
import { WorkspaceSaver } from '../../lib/workspaceSaver';

/** Browsers refuse a request that outlives the page when its body is over 64 KiB; this leaves room for the JSON around the code. */
const KEEPALIVE_BYTES = 60_000;

const savers = new Map<string, WorkspaceSaver>();

/** The saver of a problem's working copies. */
export function workspaceSaver(qc: QueryClient, itemId: string): WorkspaceSaver {
  let saver = savers.get(itemId);
  if (!saver) {
    saver = new WorkspaceSaver(
      {
        // Code too large for a request that outlives the page goes the ordinary way, and may not make it; it is kept here meanwhile.
        put: (language, source, keepalive) => api.workspace.put(itemId, language, source, { keepalive: keepalive && byteLength(source) <= KEEPALIVE_BYTES }),
        remove: (language) => api.workspace.remove(itemId, language),
      },
      {
        write: (language, source, base) => writeUnsaved(itemId, language, source, base),
        clear: (language) => clearUnsaved(itemId, language),
      },
      {
        saved: (copy) => setWorkingCopy(qc, itemId, { copy }),
        removed: (language) => setWorkingCopy(qc, itemId, { removed: language }),
      },
    );
    savers.set(itemId, saver);
  }
  return saver;
}
