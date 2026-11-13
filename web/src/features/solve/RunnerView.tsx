import type { HarnessCode } from '../../api/types';
import { languageName } from '../../lib/languages';
import { CodeEditor } from '../../ui/CodeEditor';

/**
 * The runner of a "Solution only" problem, for the curious: the code that
 * runs before the solver's own, a marker where theirs goes, and the code
 * after it. Read-only; it is changed by editing the problem.
 */
export function RunnerView({ runner, language }: { runner: HarnessCode; language: string }) {
  const part = (label: string, source: string) =>
    source.trim() !== '' && (
      <div className="io-block">
        <div className="io-label">{label}</div>
        <div className="editor-frame runner-code">
          <CodeEditor key={language} value={source} language={language} readOnly ariaLabel={`${label}, ${languageName(language)} (read-only)`} />
        </div>
      </div>
    );
  return (
    <div className="runner-view">
      <p className="muted">The {languageName(language)} code that runs around yours.</p>
      {part('Before your solution', runner.prefix)}
      <div className="runner-marker">Your solution goes here</div>
      {part('After your solution', runner.suffix)}
    </div>
  );
}
