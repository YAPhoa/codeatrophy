import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cx } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Popover } from '../../ui/Popover';
import { matchModels } from './aiProviders';

interface ModelFieldProps {
  value: string;
  onChange: (model: string) => void;
  /** The model ids the service offers, once a connection test has fetched them; `null` until then, and when it lists none. */
  models: readonly string[] | null;
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null;
  maxLength?: number;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * The model of a provider: a text field that, once the service's models are
 * known, also offers them to pick from. A name typed by hand always stands,
 * because some servers do not list their models.
 */
export function ModelField({ value, onChange, models, placeholder, hint, error, maxLength, inputRef }: ModelFieldProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const matches = useMemo(() => (models ? matchModels(models, value) : []), [models, value]);
  const showList = open && matches.length > 0;

  useEffect(() => {
    if (showList && navigated) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [showList, navigated, active, listId]);

  const show = () => {
    setOpen(true);
    setActive(0);
    setNavigated(false);
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
    <Field label="Model" hint={hint} error={error}>
      {(a) => (
        <div ref={wrapRef} className="combo">
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
            aria-activedescendant={showList && navigated ? `${listId}-${active}` : undefined}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => {
              onChange(e.target.value);
              show();
            }}
            onFocus={show}
            onMouseDown={show}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          {models !== null && models.length > 0 && (
            // A pointer affordance only: the input itself opens the list from the keyboard.
            <span
              className="combo-toggle"
              aria-hidden="true"
              onMouseDown={(e) => {
                e.preventDefault();
                wrapRef.current?.querySelector('input')?.focus();
                if (showList) setOpen(false);
                else show();
              }}
            >
              <ChevronsUpDown size={14} />
            </span>
          )}
          <Popover anchorRef={wrapRef} open={showList} onClose={() => setOpen(false)} matchWidth noAutoFocus className="menu combo-menu">
            <ul id={listId} role="listbox" aria-label="Models">
              {matches.map((m, i) => (
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
                  <span className="menu-item-icon" aria-hidden="true">
                    {m === value.trim() && <Check size={14} />}
                  </span>
                  <span className="grow mono">{m}</span>
                </li>
              ))}
            </ul>
          </Popover>
        </div>
      )}
    </Field>
  );
}
