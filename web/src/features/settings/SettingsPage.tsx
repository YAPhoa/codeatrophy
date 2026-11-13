import { NavLink, Navigate, useLocation, useParams } from 'react-router';
import { useMeta } from '../../api/queries';
import { NotFoundPage } from '../../app/NotFoundPage';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { cx } from '../../ui/Button';
import { AiActivitySection } from './AiActivitySection';
import { AiSection } from './AiSection';
import { SETTINGS_PAGES, findSettingsPage, movedSettingsPage, settingsLanding, settingsPath, type SettingsSlug } from './pages';
import { PreferencesSection } from './PreferencesSection';
import { JudgeSection, McpSection } from './ServiceSections';
import { StylesSection } from './StylesSection';

/**
 * Settings: one page per category under `/settings/<slug>`, with the list of
 * categories beside it. Only the category shown is rendered, so each loads
 * its own data and nothing else's.
 */
export default function SettingsPage() {
  const { section } = useParams();
  const location = useLocation();
  const page = findSettingsPage(section);
  if (section === undefined) return <Navigate to={settingsLanding(location.hash)} replace />;
  const moved = movedSettingsPage(section);
  if (!page && moved) return <Navigate to={settingsPath(moved)} replace />;
  if (!page) return <NotFoundPage />;
  return <SettingsCategory slug={page.slug} label={page.label} />;
}

function SettingsCategory({ slug, label }: { slug: SettingsSlug; label: string }) {
  const meta = useMeta().data;
  useDocumentTitle(`${label} · Settings`);
  if (!meta) return null;

  return (
    <div className="page settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-labelledby="settings-nav-title">
          <div id="settings-nav-title" className="settings-nav-title">
            Settings
          </div>
          {SETTINGS_PAGES.map((p) => (
            <NavLink key={p.slug} to={settingsPath(p.slug)} className={({ isActive }) => cx(isActive && 'is-active')}>
              {p.label}
            </NavLink>
          ))}
          <p className="about">
            Codeatrophy {meta.version}
            <br />
            AGPL-3.0-only
          </p>
        </nav>
        <div className="settings-body">
          {slug === 'ai' && <AiSection meta={meta} />}
          {slug === 'ai-activity' && <AiActivitySection />}
          {slug === 'styles' && <StylesSection />}
          {slug === 'preferences' && <PreferencesSection />}
          {slug === 'judge' && <JudgeSection meta={meta} />}
          {slug === 'mcp' && <McpSection meta={meta} />}
        </div>
      </div>
    </div>
  );
}
