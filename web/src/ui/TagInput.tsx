import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Popover } from './Popover';
import { cx } from './Button';

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Existing tags offered as completions. */
  suggestions?: readonly string[];
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  autoFocus?: boolean;
}

const clean = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, '-');

/**
 * Free-form tag entry with completion. Enter, comma or Tab adds the typed
 * tag; Backspace in an empty input removes the last one.
 */
export function TagInput({ value, onChange, suggestions = [], placeholder = 'Add tag…', autoFocus, ...aria }: TagInputProps) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const q = clean(text);
    return suggestions.filter((s) => !value.includes(s) && (q === '' || s.includes(q))).slice(0, 8);
  }, [suggestions, value, text]);

  const showList = open && matches.length > 0 && text !== '';

  const add = (raw: string) => {
    const parts = raw.split(',').map(clean).filter(Boolean);
    if (parts.length === 0) return;
    onChange(Array.from(new Set([...value, ...parts])));
    setText('');
    setActive(0);
    setNavigated(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && text.trim() !== '')) {
      // A suggestion is taken only when the user moved to it with the arrow keys;
      // otherwise what they typed wins.
      const picked = navigated && showList ? matches[active] : undefined;
      if (picked) {
        e.preventDefault();
        add(picked);
      } else if (text.trim()) {
        e.preventDefault();
        add(text);
      } else if (e.key === ',') {
        e.preventDefault();
      }
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (navigated ? Math.min(matches.length - 1, i + 1) : 0));
      setNavigated(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      setNavigated(true);
    } else if (e.key === 'Escape' && open && showList) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="taginput" onClick={() => inputRef.current?.focus()}>
      {value.map((tag) => (
        <span key={tag} className="chip chip-tag">
          {tag}
          <button
            type="button"
            className="chip-remove"
            aria-label={`Remove tag ${tag}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((t) => t !== tag));
            }}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        name="tag"
        {...aria}
        ref={inputRef}
        className="taginput-input"
        value={text}
        placeholder={value.length === 0 ? placeholder : ''}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && navigated ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          setNavigated(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          if (text.trim()) add(text);
        }}
        onKeyDown={onKeyDown}
      />
      <Popover anchorRef={wrapRef} open={showList} onClose={() => setOpen(false)} matchWidth noAutoFocus className="menu">
        <ul id={listId} role="listbox" aria-label="Tag suggestions">
          {matches.map((m, i) => (
            <li
              key={m}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={navigated && i === active}
              className={cx('menu-item', navigated && i === active && 'is-active')}
              onMouseDown={(e) => {
                e.preventDefault();
                add(m);
              }}
            >
              {m}
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}
