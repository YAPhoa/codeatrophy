import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Pencil, X } from 'lucide-react';
import { api } from '../../api/client';
import { qk, useLimits } from '../../api/queries';
import type { Item } from '../../api/types';
import { errorLine } from '../../lib/errors';
import { charCount } from '../../lib/text';
import { onPageHide } from '../../lib/pageHide';
import { StatusSwap } from '../../ui/Animated';
import { Button, cx, IconButton } from '../../ui/Button';
import { Markdown } from '../../ui/Markdown';
import { Spinner } from '../../ui/misc';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/**
 * Text left by notes that closed before their save came back, by item. Notes
 * opened again before then start from it, not from the item's older notes.
 */
const unsaved = new Map<string, string>();

/**
 * How often notes reach the server: once typing has paused this long, and
 * at most this often while it goes on (ms). Leaving the notes, the item or
 * the page saves at once. Between those, nothing is sent.
 */
const SAVE_AFTER_PAUSE_MS = 3000;
const SAVE_AT_MOST_EVERY_MS = 15000;

/** The count turns to a warning past this share of the limit. */
const NEAR_LIMIT = 0.9;

/**
 * Private notes on an item, saved automatically (see SAVE_AFTER_PAUSE_MS)
 * and when the notes close.
 * Empty notes open ready to write; notes with text show it rendered, with
 * Edit to change it. Notes are personal state: they do not change the
 * item's revision and are never exported. Notes over the server's
 * `maxNotesChars` are not sent; ones saved under a higher limit still show.
 *
 * With `onClose` (the reader's panel) the notes carry their own title row;
 * without it (the solve page's tab, which already says "Notes") they do not.
 */
export function Notes({ item, onClose }: { item: Item; onClose?: () => void }) {
  const qc = useQueryClient();
  const maxChars = useLimits()?.maxNotesChars;
  const [text, setText] = useState(() => unsaved.get(item.id) ?? item.notes);
  const [state, setState] = useState<SaveState>(() => (unsaved.has(item.id) ? 'dirty' : 'saved'));
  const [error, setError] = useState<string | null>(null);
  // Whether a save has gone through since these notes opened: only then do
  // notes being read say "Saved".
  const [savedHere, setSavedHere] = useState(false);
  // Notes that open empty stay in the editing space once typing starts.
  const [editing, setEditing] = useState(() => text.trim() === '');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const focusOnEdit = useRef(false);
  const latest = useRef({ text, saved: item.notes, id: item.id });

  // `lastChance` is for a save made as the page goes away: the request is
  // one that outlives the page. Such a request cannot carry a large body, so
  // long notes are sent the ordinary way and may not make it.
  const inFlight = useRef(false);
  const save = async (value: string, lastChance = false) => {
    if (value === latest.current.saved) return;
    // Over the limit the server would refuse it; the count says so.
    if (maxChars !== undefined && charCount(value) > maxChars) return;
    // One request at a time; what changes meanwhile goes in the next. A last
    // chance goes anyway, since there may be no next.
    if (inFlight.current && !lastChance) return;
    inFlight.current = true;
    setState('saving');
    try {
      const updated = await api.items.update(latest.current.id, { notes: value }, { keepalive: lastChance });
      latest.current.saved = value;
      if (unsaved.get(updated.id) === value) unsaved.delete(updated.id);
      qc.setQueryData(qk.item(updated.id), updated);
      setState(latest.current.text === value ? 'saved' : 'dirty');
      setSavedHere(true);
      setError(null);
    } catch (e) {
      setState('error');
      setError(errorLine(e));
    } finally {
      inFlight.current = false;
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    if (state !== 'dirty') return;
    const t = window.setTimeout(() => void saveRef.current(latest.current.text), SAVE_AFTER_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [text, state]);

  // Typing that never pauses still saves now and then.
  const dirty = state === 'dirty';
  useEffect(() => {
    if (!dirty) return;
    const t = window.setInterval(() => void saveRef.current(latest.current.text), SAVE_AT_MOST_EVERY_MS);
    return () => window.clearInterval(t);
  }, [dirty]);

  // Empty notes are always the editing space; Edit opens it for notes with text.
  const writing = editing || text.trim() === '';
  useEffect(() => {
    if (writing && focusOnEdit.current) {
      focusOnEdit.current = false;
      textRef.current?.focus();
    }
  }, [writing]);

  // Save pending changes when leaving the item, and when the tab is closed,
  // reloaded or put in the background before the delay above has passed.
  useEffect(() => {
    const current = latest.current;
    const saveNow = (lastChance: boolean) => void saveRef.current(current.text, lastChance);
    const stopFlushing = onPageHide(() => saveNow(true));
    return () => {
      stopFlushing();
      const { id, text: left, saved } = current;
      if (left !== saved) unsaved.set(id, left);
      // Closing the notes is a last chance too: there may be no later save.
      saveNow(true);
    };
  }, []);

  const count = charCount(text);
  const over = maxChars !== undefined && count > maxChars;
  const near = maxChars !== undefined && !over && count > maxChars * NEAR_LIMIT;

  // How the last save went, while it matters: notes left empty, or only being
  // read, say nothing once saved, unless they were just saved here.
  const status =
    state === 'saving'
      ? 'Saving…'
      : state === 'dirty'
        ? over
          ? 'Too long'
          : 'Unsaved'
        : text === '' || (!writing && !savedHere)
          ? ''
          : 'Saved';

  const privateChip = (
    <span className="notes-private" title="Notes are private: never exported or shared">
      <Lock size={11} aria-hidden="true" />
      Private
    </span>
  );

  return (
    <div className="notes">
      {onClose && (
        <div className="row notes-head">
          <h2>Notes</h2>
          {privateChip}
          <span className="spacer" />
          <IconButton size="sm" label="Close notes" icon={<X size={14} />} onClick={onClose} />
        </div>
      )}
      <div className="row notes-bar">
        {!writing && (
          <Button
            size="sm"
            icon={<Pencil size={14} />}
            onClick={() => {
              focusOnEdit.current = true;
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
        {editing && text.trim() !== '' && (
          <Button
            size="sm"
            icon={<Check size={14} />}
            onClick={() => {
              setEditing(false);
              void save(latest.current.text);
            }}
          >
            Done
          </Button>
        )}
        <span className="spacer" />
        <span className={cx('notes-state', status === 'Too long' && 'is-over')}>
          {/* An error may be long, so it wraps as plain text; the states that swap fit on one line. */}
          {state === 'error' ? (
            <span className="field-error" role="status">
              Not saved: {error}
            </span>
          ) : (
            <StatusSwap icon={state === 'saving' ? <Spinner size={12} /> : status === 'Saved' && <Check size={12} />} text={status} />
          )}
        </span>
        {!onClose && privateChip}
      </div>
      {writing ? (
        <textarea
          ref={textRef}
          name="notes"
          className="input textarea notes-text"
          aria-label="Private notes (Markdown)"
          autoComplete="off"
          placeholder="Approach, gotchas, or things to revisit…"
          aria-invalid={over || undefined}
          value={text}
          onChange={(e) => {
            latest.current.text = e.target.value;
            setText(e.target.value);
            setState('dirty');
          }}
          onBlur={() => void save(latest.current.text)}
        />
      ) : (
        <div className="notes-preview">
          <Markdown source={text} />
        </div>
      )}
      <div className="row notes-foot">
        <span>{writing ? 'Markdown supported' : 'Click Edit to modify'}</span>
        <span className="spacer" />
        <span className={cx('notes-count', near && 'is-near', over && 'is-over')}>
          {maxChars === undefined ? `${count.toLocaleString()} chars` : `${count.toLocaleString()} / ${maxChars.toLocaleString()}`}
        </span>
      </div>
    </div>
  );
}
