import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useMeta } from '../../api/queries';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { setThemePreference, useThemePreference } from '../../lib/theme';
import { Segmented } from '../../ui/Field';
import { AiSection } from './AiSection';
import { PreferencesSection } from './PreferencesSection';
import { JudgeSection, McpSection } from './ServiceSections';
import { StylesSection } from './StylesSection';

const SECTIONS = [
  { id: 'ai', label: 'AI provider' },
  { id: 'styles', label: 'Writing styles' },
  { id: 'judge', label: 'Judge' },
  { id: 'mcp', label: 'MCP' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'appearance', label: 'Appearance' },
] as const;

export default function SettingsPage() {
  useDocumentTitle('Settings');
  const meta = useMeta().data;
  const location = useLocation();
  const theme = useThemePreference();

  // Links elsewhere in the app point at a section (`/settings#ai`).
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 50);
    return () => window.clearTimeout(t);
  }, [location.hash]);

  if (!meta) return null;

  return (
    <div className="page settings">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </nav>
        <div className="settings-body">
          <AiSection meta={meta} />
          <StylesSection />
          <JudgeSection meta={meta} />
          <McpSection meta={meta} />
          <PreferencesSection />

          <section id="appearance" className="settings-section" aria-labelledby="appearance-title">
            <h2 id="appearance-title">Appearance</h2>
            <div className="card card-pad row-wrap">
              <span className="grow">
                <strong>Theme</strong>
                <div className="muted">Stored in this browser.</div>
              </span>
              <Segmented
                label="Theme"
                value={theme}
                onChange={setThemePreference}
                options={[
                  { value: 'system', label: 'Match system' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>
          </section>

          <p className="about">
            Codeatrophy {meta.version} · Licensed under AGPL-3.0-only
          </p>
        </div>
      </div>
    </div>
  );
}
