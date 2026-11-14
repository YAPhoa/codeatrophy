import { NavLink } from 'react-router';
import { cx } from '../../ui/Button';
import { TAB_INDICATOR, TAB_SELECTED } from '../../ui/misc';
import { useSlidingIndicator } from '../../lib/motion';

export function ShareTabs({ active }: { active: 'import' | 'export' }) {
  const ref = useSlidingIndicator<HTMLElement>(TAB_SELECTED, TAB_INDICATOR);
  return (
    <nav ref={ref} className="tabs share-tabs" aria-label="Import and export">
      <NavLink to="/import" className={cx('tab', active === 'import' && 'is-selected')}>
        Import
      </NavLink>
      <NavLink to="/export" className={cx('tab', active === 'export' && 'is-selected')}>
        Export
      </NavLink>
    </nav>
  );
}
