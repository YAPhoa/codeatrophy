import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Check, ChevronsUpDown, RefreshCw } from 'lucide-react';
import { IconButton, cx } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Popover } from '../../ui/Popover';
import { matchModels } from './aiProviders';

interface ModelFieldProps {
  value: string;
  onChange: (model: string) => void;
  /** The model ids the service offers, loaded now or remembered from earlier; `null` when none are known. */
  models: readonly string[] | null;
  /** The list is being loaded. */
  loading: boolean;
  /** Load the list: from the refresh button, or from the field when it is opened with no models known. */
  onLoad: (from: 'button' | 'field') => void;
  /** Whether focusing the field with no models known loads them too. Opening the list from the toggle or the keyboard always does. */
  loadOnFocus: boolean;
  /** No load can start now; the refresh button is disabled. */
  refreshDisabled?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null;
  maxLength?: number;
  inputRef?: Ref<HTMLInputElement>;
  refreshRef?: Ref<HTMLButtonElement>;
}

/**
 * The model of a provider: a text field with the service's models to pick
 * from, and a button that loads them again. A name typed by hand always
 * stands, because some servers do not list their models.
 */
export function ModelField({ value, onChange, models, loading, onLoad, loadOnFocus, refreshDisabled, placeholder, hint, error, maxLength, inputRef, refreshRef }: ModelFieldProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const known = models !== null && models.length > 0;
  const matches = useMemo(() => (models ? matchModels(models, value) : []), [models, value]);
  // With nothing to offer yet, a load in progress says so in the list.
  const waiting = !known && loading;
  const showList = open && (matches.length > 0 || waiting);

  useEffect(() => {
    if (showList && navigated) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [showList, navigated, active, listId]);

  const show = () => {
    setOpen(true);
    setActive(0);
    setNavigated(false);
  };

  /** Open the list; with no models known, fetch them when asked for, or on focus when that is wanted. */
  const showOrLoad = (asked: boolean) => {
    show();
    if (!known && !loading && !refreshDisabled && (asked || loadOnFocus)) onLoad('field');
  };

  const pick = (model: string) => {
    onChange(model);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (showList && navigated ? Math.min(matches.length - 1, i + 1) : 0));
      setNavigated(true);
    } else if (e.key === 'ArrowDown' && !known) {
      e.preventDefault();
      showOrLoad(true);
    } else if (e.key === 'ArrowUp' && showList) {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      setNavigated(true);
    } else if (e.key === 'Enter' && showList) {
      // A model is taken only when the user moved to it with the arrow keys;
      // otherwise what they typed stands. Either way this Enter closes the
      // list rather than submitting the form.
      e.preventDefault();
      const picked = navigated ? matches[active] : undefined;
      if (picked) pick(picked);
      else setOpen(false);
    } else if (e.key === 'Escape' && showList) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <Field label="Model" hint={hint} error={error} inlineError reserve>
      {(a) => (
        <div className="row row-tight">
          <div ref={wrapRef} className="combo grow">
            <input
              {...a}
              ref={inputRef}
              className="input"
              value={value}
              placeholder={placeholder}
              maxLength={maxLength}
              role="combobox"
              aria-expanded={showList}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={showList && navigated && !waiting ? `${listId}-${active}` : undefined}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => {
                onChange(e.target.value);
                show();
              }}
              onFocus={() => showOrLoad(false)}
              onMouseDown={() => showOrLoad(false)}
              onBlur={() => setOpen(false)}
              onKeyDown={onKeyDown}
            />
            {/* Out of the tab order: the input itself opens the list from the keyboard. */}
            <button
              type="button"
              className="combo-toggle"
              tabIndex={-1}
              aria-label="Show models"
              aria-expanded={showList}
              aria-controls={listId}
              onMouseDown={(e) => {
                e.preventDefault();
                wrapRef.current?.querySelector('input')?.focus();
                if (showList) setOpen(false);
                else showOrLoad(true);
              }}
            >
              <ChevronsUpDown size={14} aria-hidden="true" />
            </button>
            <Popover anchorRef={wrapRef} open={showList} onClose={() => setOpen(false)} matchWidth noAutoFocus className="menu combo-menu">
              <ul id={listId} role="listbox" aria-label="Models" aria-busy={waiting || undefined}>
                {waiting ? (
                  <li role="option" aria-selected={false} aria-disabled="true" className="menu-item" onMouseDown={(e) => e.preventDefault()}>
                    <span className="grow">Loading models…</span>
                    <span className="menu-item-icon" aria-hidden="true">
                      <span className="spinner" />
                    </span>
                  </li>
                ) : (
                  matches.map((m, i) => (
                    <li
                      key={m}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={m === value.trim()}
                      className={cx('menu-item', navigated && i === active && 'is-active')}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(m);
                      }}
                    >
                      {/* The name starts where the text of the field does; the mark of the chosen one goes after it. */}
                      <span className="grow mono">{m}</span>
                      <span className="menu-item-icon" aria-hidden="true">
                        {m === value.trim() && <Check size={14} />}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </Popover>
          </div>
          <IconButton ref={refreshRef} label="Refresh models" icon={<RefreshCw size={14} />} busy={loading} disabled={refreshDisabled} onClick={() => onLoad('button')} />
        </div>
      )}
    </Field>
  );
}
