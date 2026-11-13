import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Lock } from 'lucide-react';
import { api } from '../../api/client';
import { qk } from '../../api/queries';
import type { Item } from '../../api/types';
import { errorLine } from '../../lib/errors';
import { Segmented } from '../../ui/Field';
import { Markdown } from '../../ui/Markdown';
import { Spinner } from '../../ui/misc';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** Browsers refuse a request that outlives the page when its body is over 64 KiB; this leaves room for the JSON around the text. */
const KEEPALIVE_BYTES = 60_000;

/**
 * Private notes on an item, saved automatically a moment after typing stops.
 * Notes are personal state: they do not change the item's revision and are
 * never exported.
 */
export function Notes({ item }: { item: Item }) {
  const qc = useQueryClient();
  const [text, setText] = useState(item.notes);
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'write' | 'preview'>('write');
  const latest = useRef({ text: item.notes, saved: item.notes, id: item.id });

  // `lastChance` is for a save made as the page goes away: the request is
  // one that outlives the page. Such a request cannot carry a large body, so
  // long notes are sent the ordinary way and may not make it.
  const save = async (value: string, lastChance = false) => {
    if (value === latest.current.saved) return;
    setState('saving');
    try {
      const updated = await api.items.update(latest.current.id, { notes: value }, { keepalive: lastChance && new Blob([value]).size <= KEEPALIVE_BYTES });
      latest.current.saved = value;
      qc.setQueryData(qk.item(updated.id), updated);
      setState(latest.current.text === value ? 'saved' : 'dirty');
      setError(null);
    } catch (e) {
      setState('error');
      setError(errorLine(e));
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    if (state !== 'dirty') return;
    const t = window.setTimeout(() => void saveRef.current(latest.current.text), 800);
    return () => window.clearTimeout(t);
  }, [text, state]);

  // Save pending changes when leaving the item, and when the tab is closed,
  // reloaded or put in the background before the delay above has passed.
  useEffect(() => {
    const saveNow = (lastChance: boolean) => void saveRef.current(latest.current.text, lastChance);
    const flush = () => saveNow(true);
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      saveNow(false);
    };
  }, []);

  return (
    <div className="notes">
      <div className="row notes-bar">
        <span className="notes-private" title="Notes are private: never exported or shared">
          <Lock size={12} aria-hidden="true" />
          Private notes
        </span>
        <span className="spacer" />
        <span className="notes-state" role="status">
          {state === 'saving' && (
            <>
              <Spinner size={12} /> Saving…
            </>
          )}
          {state === 'saved' && text !== '' && (
            <>
              <Check size={12} aria-hidden="true" /> Saved
            </>
          )}
          {state === 'dirty' && 'Unsaved'}
          {state === 'error' && <span className="field-error">Not saved — {error}</span>}
        </span>
        <Segmented
          size="sm"
          label="Notes view"
          value={view}
          onChange={setView}
          options={[
            { value: 'write', label: 'Write' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      </div>
      {view === 'write' ? (
        <textarea
          name="notes"
          className="input textarea notes-text"
          aria-label="Private notes (Markdown)"
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
          <Markdown source={text} emptyText="No notes yet." />
        </div>
      )}
    </div>
  );
}
