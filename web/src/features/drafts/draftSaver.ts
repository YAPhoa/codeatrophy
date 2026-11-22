// Saving a draft kept on the server as it is edited here, and taking in the
// generations that arrive. Framework-free; `useServerDraft` binds it to the
// API, the query cache and the page's state.

import { isApiError } from '../../api/client';
import type { Draft, DraftPatch } from '../../api/types';
import type { ItemFormState } from '../../lib/itemForm';
import { contentFromGeneration, hasNewGeneration, readContent, titleOf, type DraftContent } from './draftContent';

/** The requests a saver makes, for one draft. */
export interface DraftTransport {
  /** `GET /drafts/{id}`. */
  get(): Promise<Draft>;
  /** `PATCH /drafts/{id}`. */
  update(patch: DraftPatch): Promise<Draft>;
}

export interface DraftSaverEvents {
  /** A copy of the draft the server answered with: the newest there is. */
  took?(draft: Draft): void;
  /** The content shown here changed. */
  shown?(content: DraftContent): void;
  /** The draft was loaded again, dropping what was local: it changed elsewhere. */
  reloaded?(): void;
  /** A save failed, with why; or `null`, a save went through. */
  saveError?(error: unknown): void;
  /** A generation was taken in, which collects its job. */
  collected?(): void;
  /** Taking a generation in was refused, the draft having changed meanwhile: read it again. */
  refetch?(): void;
}

/**
 * The local copy of a draft's content, saved shortly after each change with
 * the revision it was based on. A save refused because the draft changed
 * elsewhere loads it again. A generation that arrives is turned into the
 * form at once and saved as the content (`basedOn`), which collects its job;
 * when that save fails, the next save of the content carries the `basedOn`,
 * and the generation is not taken in again over what was edited meanwhile.
 */
export class DraftSaver {
  /** What a first generated form starts with besides the generation (a variant's original's tags and collections). */
  inherited: Partial<ItemFormState> = {};

  private readonly transport: DraftTransport;
  private readonly events: DraftSaverEvents;
  private readonly autosaveMs: number;
  // What the server has: the revision the local copy was last in step with.
  private synced: number | null = null;
  private local: DraftContent | null = null;
  // Edits are counted, so a save that was overtaken by another edit leaves the draft unsaved.
  private edits = 0;
  private saved = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | null = null;
  private adopting: number | null = null;
  // The generation the content here was built from when the server has not taken that in:
  // a save that failed leaves it to the next one, which sends it as `basedOn`.
  private pendingBase: number | null = null;
  // How many times the draft was loaded again, for `settle` to tell.
  private reloads = 0;

  constructor(transport: DraftTransport, events: DraftSaverEvents = {}, autosaveMs = 1200) {
    this.transport = transport;
    this.events = events;
    this.autosaveMs = autosaveMs;
  }

  /** The content as it is here, `null` before the draft is first read. */
  get content(): DraftContent | null {
    return this.local;
  }

  /** The revision the local copy was last in step with, `null` before the draft is first read. */
  get revision(): number | null {
    return this.synced;
  }

  /** Whether there is an edit the server has not confirmed. */
  get dirty(): boolean {
    return this.edits !== this.saved;
  }

  /** A copy of the draft the server answered with. */
  take(draft: Draft): void {
    this.synced = Math.max(this.synced ?? 0, draft.revision);
    this.events.took?.(draft);
  }

  /** A copy of the draft as read (a load or a poll). */
  received(draft: Draft): void {
    // An older copy than the one in hand (a poll that crossed a save) says nothing new.
    if (this.synced !== null && draft.revision < this.synced) return;
    // First load, or the server moved on while nothing here is unsaved.
    if (this.synced === null || (!this.dirty && draft.revision !== this.synced)) {
      this.synced = draft.revision;
      this.pendingBase = null;
      this.show(readContent(draft));
    }
    if (hasNewGeneration(draft) && draft.state !== 'drafting') void this.adopt(draft);
  }

  /** Change the content; it is saved shortly after. Returns whether there was content to change. */
  update(change: (current: DraftContent) => DraftContent): boolean {
    const current = this.local;
    if (!current) return false;
    this.show(change(current));
    this.edits++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.autosaveMs);
    return true;
  }

  /** Save what is unsaved now, after a save under way. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    while (this.inflight) await this.inflight;
    if (!this.dirty) return;
    const p = this.send().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    await p;
  }

  /**
   * The revision a save to the library is made against, after saving what
   * is unsaved, and whether the draft was loaded again meanwhile, because it
   * changed elsewhere: what was about to be saved is then out of date.
   */
  async settle(): Promise<{ revision: number | null; reloaded: boolean }> {
    const reloads = this.reloads;
    await this.flush();
    return { revision: this.synced, reloaded: this.reloads !== reloads };
  }

  /** Load the draft again, dropping what is local: it changed elsewhere. */
  async reload(): Promise<void> {
    clearTimeout(this.timer);
    const latest = await this.transport.get();
    this.saved = this.edits;
    this.pendingBase = null;
    this.reloads++;
    this.take(latest);
    this.show(readContent(latest));
    this.events.reloaded?.();
  }

  /** Stop saving: the draft is about to go (saved to the library, or discarded). */
  forget(): void {
    clearTimeout(this.timer);
    this.saved = this.edits;
  }

  /** The save to send as the page goes away, or `null` when nothing is unsaved. */
  parting(): DraftPatch | null {
    const current = this.local;
    if (!current || this.synced === null || !this.dirty) return null;
    return this.patch(current);
  }

  private show(next: DraftContent): void {
    this.local = next;
    this.events.shown?.(next);
  }

  /** The save of the content as it is here. */
  private patch(current: DraftContent): DraftPatch {
    const basedOn = this.pendingBase !== null ? { basedOn: this.pendingBase } : {};
    return { content: { ...current }, ...basedOn, ...(current.form ? { edited: true } : {}), title: titleOf(current), expectedRevision: this.synced ?? undefined };
  }

  private async send(): Promise<void> {
    const current = this.local;
    if (!current || this.synced === null || !this.dirty) return;
    const sending = this.edits;
    const base = this.pendingBase;
    try {
      const res = await this.transport.update(this.patch(current));
      this.saved = sending;
      // The server has the generation the content was built from now.
      if (this.pendingBase === base) this.pendingBase = null;
      this.take(res);
      this.events.saveError?.(null);
      if (base !== null) this.events.collected?.();
    } catch (e) {
      if (isApiError(e) && e.isRevisionConflict) await this.reload();
      else this.events.saveError?.(e);
    }
  }

  /** Take a generation in: build the form from it and save that as the content. */
  private async adopt(draft: Draft): Promise<void> {
    if (!draft.generation || this.adopting === draft.generationSeq) return;
    // Built from it already and edited since: that edit's save takes it in.
    if (this.pendingBase === draft.generationSeq && this.dirty) return;
    this.adopting = draft.generationSeq;
    while (this.inflight) await this.inflight;
    const next = contentFromGeneration(this.local ?? readContent(draft), draft.generation, this.inherited);
    this.show(next);
    this.saved = this.edits;
    // Saves of edits made meanwhile wait for this one, so they are made against its revision.
    const p = (async () => {
      try {
        this.take(await this.transport.update({ content: { ...next }, basedOn: draft.generationSeq, edited: false, title: titleOf(next), expectedRevision: this.synced ?? draft.revision }));
        this.pendingBase = null;
        this.events.collected?.();
      } catch (e) {
        this.adopting = null;
        // Changed meanwhile: read it again, and take the generation from there.
        if (isApiError(e) && e.isRevisionConflict) this.events.refetch?.();
        else {
          // What is shown is built from it all the same: the next save says so.
          this.pendingBase = draft.generationSeq;
          this.events.saveError?.(e);
        }
      }
    })().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    await p;
  }
}
