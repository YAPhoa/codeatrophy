import { NavLink } from 'react-router';
import { cx } from '../../ui/Button';

export function ShareTabs({ active }: { active: 'import' | 'export' }) {
  return (
    <nav className="tabs share-tabs" aria-label="Import and export">
      <NavLink to="/import" className={cx('tab', active === 'import' && 'is-selected')}>
        Import
      </NavLink>
      <NavLink to="/export" className={cx('tab', active === 'export' && 'is-selected')}>
        Export
      </NavLink>
    </nav>
  );
}
