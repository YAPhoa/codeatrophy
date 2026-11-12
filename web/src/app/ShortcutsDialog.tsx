import { Fragment } from 'react';
import { MOD } from '../lib/hotkeys';
import { Dialog } from '../ui/Dialog';
import { Kbd } from '../ui/misc';

const GROUPS: { title: string; rows: [string[], string][] }[] = [
  {
    title: 'Anywhere',
    rows: [
      [[MOD, 'K'], 'Search items and run commands'],
      [['C'], 'Capture a new item'],
      [['?'], 'Show this list'],
    ],
  },
  {
    title: 'Library',
    rows: [
      [['/'], 'Focus search'],
      [['J'], 'Next item'],
      [['K'], 'Previous item'],
      [['Enter'], 'Open the focused item'],
      [['X'], 'Select or deselect'],
      [['F'], 'Toggle favorite'],
      [['S'], 'Cycle status'],
      [['Alt', '↑ / ↓'], 'Move the item (in a collection, manual order)'],
      [['Esc'], 'Clear the selection'],
    ],
  },
  {
    title: 'Solving',
    rows: [
      [[MOD, 'Enter'], 'Run against the sample cases'],
      [[MOD, 'Shift', 'Enter'], 'Submit against all test cases'],
      [['Esc', 'Tab'], 'Leave the code editor'],
    ],
  },
  {
    title: 'Capture and editing',
    rows: [
      [[MOD, 'Enter'], 'Draft with AI (while typing the input)'],
      [[MOD, 'S'], 'Save'],
    ],
  },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map(([keys, text]) => (
                <Fragment key={text}>
                  <dt>
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dt>
                  <dd>{text}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
