// Saving a problem's working copies to the server, one language at a time.
// Framework-free; `features/solve/workingCopies.ts` binds it to the API.

import type { WorkingCopy } from '../api/types';

/** The requests a saver makes, for one problem. */
export interface WorkspaceTransport {
  /** `PUT …/workspace/{language}`; `keepalive` for a last save as the page goes away. */
  put(language: string, source: string, keepalive: boolean): Promise<WorkingCopy>;
  /** `DELETE …/workspace/{language}`. */
  remove(language: string): Promise<void>;
}

/**
 * Where edits wait, in this browser, until the server has confirmed them,
 * each with `base`: the `updatedAt` of the server copy it was based on,
 * `null` for none, `undefined` when not known; and `sending`: the code of a
 * save under way as the edit was made, which may land after the page is
 * gone, `undefined` for none.
 */
export interface UnsavedStore {
  write(language: string, source: string, base: string | null | undefined, sending?: string): void;
  clear(language: string): void;
}

export interface SaverEvents {
  /** A write went through. */
  saved?(copy: WorkingCopy): void;
  /** A delete went through. */
  removed?(language: string): void;
}

interface Lane {
  /** What the server holds, as far as this tab knows: the source, `null` for no copy, `undefined` for not known. */
  confirmed: string | null | undefined;
  /** The `updatedAt` of that copy: `null` for no copy, `undefined` for not known. */
  base: string | null | undefined;
  /** What the server should hold and has not confirmed: a source, `null` for no copy (a reset), `undefined` for nothing to send. */
  wanted: string | null | undefined;
  /** For a reset: the code the editor went back to, written instead if the delete fails. */
  fallback: string;
  /** The code of the write under way, if one is. */
  sending: string | undefined;
  /** The requests under way, at most one. */
  running: Promise<void> | null;
  /** Asked to send again while a request was under way. */
  again: boolean;
  /** Why the last attempt failed, while what it carried is still not on the server. */
  error: unknown;
}

/** An item that is gone: there is nothing left to save to, so nothing is kept for it. */
function isGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'not_found';
}

/**
 * Saves the code of one problem, per language.
 *
 * - An edit is kept in the `UnsavedStore` at once, with the time of the
 *   server copy it is based on, and stays there until a save of it (or of a
 *   later edit) succeeds; a failed save leaves it there for the next
 *   attempt, or the next opening of the problem. A save of an earlier
 *   version that succeeds meanwhile moves the time it is based on.
 * - Each language has at most one request in flight. What is edited
 *   meanwhile waits, and only its latest version is sent next, so an older
 *   save can never land after a newer one from this tab. An edit made
 *   meanwhile is kept with the code under way, so that it still wins at the
 *   next opening if that save lands after the page is gone (a tab closed
 *   with it in flight).
 * - Code already on the server as it is is not sent again; a reset's delete
 *   always is, in case what this tab knows is out of date.
 */
export class WorkspaceSaver {
  private readonly lanes = new Map<string, Lane>();
  private readonly listeners = new Set<() => void>();
  private readonly transport: WorkspaceTransport;
  private readonly store: UnsavedStore;
  private readonly events: SaverEvents;
  /** Whether the server's copies have been read: a language with no lane yet then has none. */
  private seeded = false;

  constructor(transport: WorkspaceTransport, store: UnsavedStore, events: SaverEvents = {}) {
    this.transport = transport;
    this.store = store;
    this.events = events;
  }

  /** Whether saving is failing: some language has an edit that its last attempt could not save. */
  get failing(): boolean {
    return this.error !== null;
  }

  /** Why, while saving is failing; else `null`. */
  get error(): unknown {
    for (const lane of this.lanes.values()) if (lane.error !== null && lane.wanted !== undefined) return lane.error;
    return null;
  }

  /** Be told when `failing` may have changed (after every request). Returns the unsubscribe. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /**
   * Record what the server holds, as just read: languages that are not
   * listed have no copy. A language with a save under way or waiting keeps
   * what it knows.
   */
  seed(copies: readonly WorkingCopy[]): void {
    this.seeded = true;
    const held = new Map(copies.map((c) => [c.language, c]));
    for (const language of new Set([...this.lanes.keys(), ...held.keys()])) {
      const lane = this.lane(language);
      if (lane.running !== null || lane.wanted !== undefined) continue;
      lane.confirmed = held.get(language)?.source ?? null;
      lane.base = held.get(language)?.updatedAt ?? null;
    }
  }

  /** The code of `language` has changed: keep it here, and send it on the next `send`. */
  edit(language: string, source: string): void {
    const lane = this.lane(language);
    lane.wanted = source;
    this.store.write(language, source, lane.base, lane.sending);
  }

  /**
   * The code of `language` went back to `fallback`, its starter code: its
   * copy is deleted on the next `send`. Until that has gone through,
   * `fallback` is what is kept here, and it is what is written if the delete
   * fails, so that the reset holds whichever way.
   */
  reset(language: string, fallback: string): void {
    const lane = this.lane(language);
    lane.wanted = null;
    lane.fallback = fallback;
    this.store.write(language, fallback, lane.base, lane.sending);
  }

  /** Whether `language` has something the server has not confirmed. */
  unsent(language: string): boolean {
    return this.lanes.get(language)?.wanted !== undefined;
  }

  /**
   * Send what `language` has waiting. With a request already under way, the
   * latest version goes once it is done. Resolves when nothing more is
   * being sent for it, however that went; a failure shows in `failing`.
   */
  send(language: string, options: { keepalive?: boolean } = {}): Promise<void> {
    const lane = this.lane(language);
    if (lane.running) {
      lane.again = true;
      return lane.running;
    }
    if (lane.wanted === undefined) return Promise.resolve();
    if (lane.wanted !== null && lane.wanted === lane.confirmed) {
      this.settle(language, lane);
      return Promise.resolve();
    }
    lane.running = this.drain(language, lane, options.keepalive ?? false);
    return lane.running;
  }

  /** Send what every language has waiting, one language after the other, in `order` first. */
  async sendAll(order: readonly string[] = []): Promise<void> {
    const languages = [...new Set([...order, ...this.lanes.keys()])];
    for (const language of languages) if (this.unsent(language)) await this.send(language);
  }

  private lane(language: string): Lane {
    let lane = this.lanes.get(language);
    if (!lane) {
      const none = this.seeded ? null : undefined;
      lane = { confirmed: none, base: none, wanted: undefined, fallback: '', sending: undefined, running: null, again: false, error: null };
      this.lanes.set(language, lane);
    }
    return lane;
  }

  /** Nothing is left to send: what was wanted is what the server holds. */
  private settle(language: string, lane: Lane): void {
    lane.wanted = undefined;
    this.store.clear(language);
    if (lane.error !== null) {
      lane.error = null;
      this.notify();
    }
  }

  /** Called with `wanted` different from `confirmed`, so the first pass makes a request. */
  private async drain(language: string, lane: Lane, keepalive: boolean): Promise<void> {
    try {
      for (;;) {
        lane.again = false;
        const want = lane.wanted;
        if (want === undefined) return;
        if (want !== null && want === lane.confirmed) {
          this.settle(language, lane);
          return;
        }
        try {
          if (want === null) {
            await this.transport.remove(language);
            lane.confirmed = null;
            lane.base = null;
            this.events.removed?.(language);
          } else {
            lane.sending = want;
            const copy = await this.transport.put(language, want, keepalive).finally(() => {
              lane.sending = undefined;
            });
            lane.confirmed = want;
            lane.base = copy.updatedAt;
            this.events.saved?.(copy);
          }
        } catch (error) {
          if (isGone(error)) {
            lane.error = null;
            lane.wanted = undefined;
            this.store.clear(language);
            return;
          }
          lane.error = error;
          // A reset that did not go through is written as its starter code next time.
          if (want === null && lane.wanted === null) lane.wanted = lane.fallback;
          return;
        }
        keepalive = false;
        lane.error = null;
        if (lane.wanted === want) this.settle(language, lane);
        // A later edit waiting here is now based on the copy just written.
        else if (lane.wanted !== undefined) this.store.write(language, lane.wanted ?? lane.fallback, lane.base);
        if (!lane.again) return;
      }
    } finally {
      // Before the promise settles, so a `send` from here on starts afresh.
      lane.running = null;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
