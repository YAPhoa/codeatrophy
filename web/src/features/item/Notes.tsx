import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Pencil } from 'lucide-react';
import { api } from '../../api/client';
import { qk } from '../../api/queries';
import type { Item } from '../../api/types';
import { errorLine } from '../../lib/errors';
import { StatusSwap } from '../../ui/Animated';
import { Button } from '../../ui/Button';
import { Markdown } from '../../ui/Markdown';
import { Spinner } from '../../ui/misc';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** Browsers refuse a request that outlives the page when its body is over 64 KiB; this leaves room for the JSON around the text. */
const KEEPALIVE_BYTES = 60_000;

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

/**
 * Private notes on an item, saved automatically (see SAVE_AFTER_PAUSE_MS)
 * and when the notes close.
 * Empty notes open ready to write; notes with text show it rendered, with
 * Edit to change it. Notes are personal state: they do not change the
 * item's revision and are never exported.
 */
export function Notes({ item }: { item: Item }) {
  const qc = useQueryClient();
  const [text, setText] = useState(() => unsaved.get(item.id) ?? item.notes);
  const [state, setState] = useState<SaveState>(() => (unsaved.has(item.id) ? 'dirty' : 'saved'));
  const [error, setError] = useState<string | null>(null);
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
    // One request at a time; what changes meanwhile goes in the next. A last
    // chance goes anyway, since there may be no next.
    if (inFlight.current && !lastChance) return;
    inFlight.current = true;
    setState('saving');
    try {
      const updated = await api.items.update(latest.current.id, { notes: value }, { keepalive: lastChance && new Blob([value]).size <= KEEPALIVE_BYTES });
      latest.current.saved = value;
      if (unsaved.get(updated.id) === value) unsaved.delete(updated.id);
      qc.setQueryData(qk.item(updated.id), updated);
      setState(latest.current.text === value ? 'saved' : 'dirty');
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
    const flush = () => saveNow(true);
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      const { id, text: left, saved } = current;
      if (left !== saved) unsaved.set(id, left);
      // Closing the notes is a last chance too: there may be no later save.
      saveNow(true);
    };
  }, []);

  // How the last save went, while it matters: notes left empty, or only being
  // read, say nothing once saved.
  const status = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved' : text === '' || !writing ? '' : 'Saved';

  return (
    <div className="notes">
      <div className="row notes-bar">
        <span className="notes-private" title="Notes are private: never exported or shared">
          <Lock size={12} aria-hidden="true" />
          Private notes
        </span>
        <span className="spacer" />
        <span className="notes-state">
          {/* An error may be long, so it wraps as plain text; the states that swap fit on one line. */}
          {state === 'error' ? (
            <span className="field-error" role="status">
              Not saved: {error}
            </span>
          ) : (
            <StatusSwap icon={state === 'saving' ? <Spinner size={12} /> : status === 'Saved' && <Check size={12} />} text={status} />
          )}
        </span>
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
      </div>
      {writing ? (
        <textarea
          ref={textRef}
          name="notes"
          className="input textarea notes-text"
          aria-label="Private notes (Markdown)"
          autoComplete="off"
          placeholder="Approach, gotchas, or things to revisit… (Markdown supported)"
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
    </div>
  );
}
