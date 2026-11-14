import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, BookmarkPlus, ChevronDown, ChevronUp, ExternalLink, Loader2, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Play, RotateCcw, Send, ServerOff } from 'lucide-react';
import { api } from '../../api/client';
import { useMeta, useSolutions, useTestCases } from '../../api/queries';
import type { Item, SubmissionSummary } from '../../api/types';
import { useShellLayout } from '../../app/shellLayout';
import { clearCode, initialCode, pickLanguage, rememberLanguage, saveCode } from '../../lib/codeStore';
import { errorLine } from '../../lib/errors';
import { VERDICT_LABEL, formatBytes, formatMemoryKb, formatMs, plural, verdictTone } from '../../lib/format';
import { MOD, useHotkeys } from '../../lib/hotkeys';
import { LANGUAGES, languageName, sortLanguages } from '../../lib/languages';
import { isLargeText, textFilename } from '../../lib/largeText';
import { readJson, writeJson } from '../../lib/storage';
import { useUrlChoice } from '../../lib/urlState';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { Button, IconButton, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { useConfirm } from '../../ui/Dialog';
import { LargeText } from '../../ui/LargeText';
import { Markdown } from '../../ui/Markdown';
import { SplitPane } from '../../ui/SplitPane';
import { Callout, ErrorCallout, PageLoading, Tabs, tabPanelProps } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { TagChips } from '../item/controls';
import { ItemBar } from '../item/ItemBar';
import { Notes } from '../item/Notes';
import { Variants } from '../item/Related';
import { SaveSolutionDialog } from '../solutions/SaveSolutionDialog';
import { savedWithCode } from '../solutions/solutionWrites';
import { CaseList } from './CaseList';
import { HistoryList } from './HistoryList';
import { ResultPanel } from './ResultPanel';
import { useReveal } from './useReveal';
import { useSubmissionRunner } from './useSubmissionRunner';

// The open tabs are part of the address (`?tab=notes&panel=result&pane=code`), so a link or a reload lands on the same view.
const LEFT_TABS = ['description', 'notes', 'submissions', 'variants'] as const;
const DRAWER_TABS = ['tests', 'result', 'custom'] as const;
const NARROW_PANES = ['problem', 'code'] as const;
type DrawerTab = (typeof DRAWER_TABS)[number];

/** What is remembered about the workspace's panes, per browser. Their sizes are kept by the split panes themselves. */
interface PaneState {
  /** The statement pane is minimised to a bar. */
  statement: boolean;
  /** The tests and results drawer is open. */
  drawer: boolean;
}

function readPanes(): PaneState {
  const stored = readJson<Partial<PaneState> | null>('layout:solve', null);
  // The editor is the primary surface: the statement starts open beside it, the drawer starts as a slim bar.
  return { statement: stored?.statement === true, drawer: stored?.drawer === true };
}

/** Ids of the controls that take the focus when a pane is minimised or restored from inside it. */
const FOCUS = {
  statementBar: 'solve-statement-bar',
  statementPane: 'solve-statement-minimise',
  drawerBar: 'solve-drawer-bar',
  drawerPane: 'solve-drawer-minimise',
} as const;

/**
 * The solving workspace. The editor is the primary surface and fills the
 * right-hand column; the statement (with notes and history) sits beside it,
 * and test cases, results and custom input live in a drawer underneath that
 * stays a slim bar until it is needed. Each pane can be minimised.
 */
export function SolveView({ item }: { item: Item }) {
  const meta = useMeta().data;
  const judge = meta?.judge;
  const judgeOn = judge?.enabled ?? false;
  const problem = item.problem;
  const starter = useMemo(() => problem?.starterCode ?? {}, [problem]);
  const toast = useToast();
  const confirm = useConfirm();
  const narrow = useMediaQuery('(max-width: 900px)');
  const cases = useTestCases(item.id);
  const sampleCount = cases.data?.filter((c) => c.isSample).length ?? 0;

  // A "Solution only" problem is run through a runner, which exists per language.
  const solutionOnly = problem?.interface === 'function';
  const runners = useMemo(() => (solutionOnly ? (problem?.harness ?? {}) : {}), [solutionOnly, problem]);

  // With a judge, offer what it can run: for a "Solution only" problem, the
  // languages that have a runner. Without a judge, or without any runner, the
  // editor is only a scratchpad, so offer the languages that have starter
  // code (or all).
  const runnable = useMemo(() => {
    const offered = (judge?.languages ?? []).map((l) => l.id);
    return solutionOnly ? offered.filter((l) => l in runners) : offered;
  }, [judge, solutionOnly, runners]);
  const hasRunner = Object.keys(runners).length > 0;
  /** Saved as "Solution only", yet nothing here can run it. */
  const cannotRun = solutionOnly && judgeOn && runnable.length === 0;
  const canRun = judgeOn && !cannotRun;
  const languages = useMemo(() => {
    if (canRun) return runnable;
    if (solutionOnly && hasRunner) return sortLanguages(Object.keys(runners));
    const withStarter = sortLanguages(Object.keys(starter));
    return withStarter.length > 0 ? withStarter : LANGUAGES.map((l) => l.id);
  }, [canRun, runnable, solutionOnly, hasRunner, runners, starter]);
  const versionOf = (id: string) => judge?.languages.find((l) => l.id === id)?.version;

  const [language, setLanguageState] = useState<string | null>(() => pickLanguage(item.id, languages, starter));
  const [code, setCode] = useState(() => (language ? initialCode(item.id, language, starter) : ''));
  const [leftTab, setLeftTab] = useUrlChoice('tab', LEFT_TABS, 'description');
  const [drawerTab, setDrawerTab] = useUrlChoice('panel', DRAWER_TABS, 'tests');
  const [panes, setPanes] = useState(readPanes);
  // Running opens the drawer for the visit without changing what is remembered.
  // A link that names a drawer tab opens the drawer on it.
  const [drawerOpen, setDrawerOpen] = useState(panes.drawer || drawerTab !== 'tests');
  const statementMin = panes.statement && !narrow;
  const reveal = useReveal();
  const shell = useShellLayout();
  const [saving, setSaving] = useState<{ language: string; source: string; name?: string; submissionId?: string; accepted?: boolean } | null>(null);
  const [savedFrom, setSavedFrom] = useState<ReadonlySet<string>>(() => new Set());
  const [customInput, setCustomInput] = useState('');
  const [historic, setHistoric] = useState(false);
  const [narrowPane, setNarrowPane] = useUrlChoice('pane', NARROW_PANES, 'problem');
  const runner = useSubmissionRunner(item.id);

  // The judge's language list can arrive or change after the first render.
  useEffect(() => {
    if (language && languages.includes(language)) return;
    const next = pickLanguage(item.id, languages, starter);
    setLanguageState(next);
    setCode(next ? initialCode(item.id, next, starter) : '');
  }, [languages, language, item.id, starter]);

  // Keep work in progress per item and language.
  const latest = useRef({ language, code });
  useEffect(() => {
    latest.current = { language, code };
    if (!language) return;
    const t = window.setTimeout(() => saveCode(item.id, language, code), 300);
    return () => window.clearTimeout(t);
  }, [item.id, language, code]);
  useEffect(
    () => () => {
      const { language: l, code: c } = latest.current;
      if (l) saveCode(item.id, l, c);
    },
    [item.id],
  );

  // ---- Panes ----

  const statementRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    // A control that was focused when its pane went away hands the focus to the control that brings the pane back.
    if (!pendingFocus.current) return;
    document.getElementById(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [statementMin, drawerOpen]);

  const remember = (change: Partial<PaneState>) =>
    setPanes((prev) => {
      const next = { ...prev, ...change };
      writeJson('layout:solve', next);
      return next;
    });

  const setStatementMinimised = (minimised: boolean) => {
    const active = document.activeElement;
    if (minimised && statementRef.current?.contains(active)) pendingFocus.current = FOCUS.statementBar;
    if (!minimised && active?.id === FOCUS.statementBar) pendingFocus.current = FOCUS.statementPane;
    remember({ statement: minimised });
  };
  const toggleStatement = () => {
    if (narrow) setNarrowPane((p) => (p === 'problem' ? 'code' : 'problem'));
    else setStatementMinimised(!panes.statement);
  };

  /** Open or minimise the drawer on the user's request, which is also what is remembered. */
  const setDrawer = (open: boolean, tab?: DrawerTab) => {
    const active = document.activeElement;
    if (!open && drawerRef.current?.contains(active)) pendingFocus.current = FOCUS.drawerBar;
    if (open && active instanceof HTMLElement && active.closest('.drawer-bar')) pendingFocus.current = tab ? `drawer-tab-${tab}` : FOCUS.drawerPane;
    if (tab) setDrawerTab(tab);
    setDrawerOpen(open);
    remember({ drawer: open });
  };
  const toggleDrawer = () => setDrawer(!drawerOpen);
  /** Bring a tab of the drawer into view because something happened there. */
  const showInDrawer = useCallback((tab: DrawerTab) => {
    setDrawerTab(tab);
    setDrawerOpen(true);
  }, [setDrawerTab]);

  // Maximising gives the editor everything: the statement and the drawer are
  // minimised together, and come back the way they were.
  const maximised = statementMin && !drawerOpen;
  const beforeMaximise = useRef<PaneState | null>(null);
  const toggleMaximise = () => {
    if (narrow) return;
    if (!maximised) {
      beforeMaximise.current = { statement: panes.statement, drawer: drawerOpen };
      setDrawerOpen(false);
      remember({ statement: true, drawer: false });
      return;
    }
    const back = beforeMaximise.current;
    beforeMaximise.current = null;
    // Without a remembered arrangement, bringing the statement back is what "restore" means.
    const drawer = back?.drawer ?? false;
    setDrawerOpen(drawer);
    remember({ statement: false, drawer });
  };

  const setLanguage = (next: string) => {
    if (language) saveCode(item.id, language, code);
    rememberLanguage(item.id, next);
    setLanguageState(next);
    setCode(initialCode(item.id, next, starter));
  };

  const resetCode = async () => {
    if (!language) return;
    const target = starter[language] ?? '';
    if (code === target) return;
    const ok = await confirm({
      title: 'Reset to the starter code?',
      body: `Your ${languageName(language)} code for this problem is replaced${target ? ' by the starter code' : ' by an empty file'}.`,
      confirmLabel: 'Reset code',
      danger: true,
    });
    if (!ok) return;
    clearCode(item.id, language);
    setCode(target);
  };

  const checkSource = (): boolean => {
    if (!language) return false;
    if (code.trim() === '') {
      toast.error('There is no code to run yet.');
      return false;
    }
    const max = meta?.limits.maxSourceBytes ?? Infinity;
    const size = new Blob([code]).size;
    if (size > max) {
      toast.error(`The source is ${formatBytes(size)}; the limit is ${formatBytes(max)}.`);
      return false;
    }
    return true;
  };

  const begin = (mode: 'run' | 'submit', stdin: string | null) => {
    if (!canRun || runner.judging || !language || !checkSource()) return;
    const maxInput = meta?.limits.maxTestDataBytes ?? Infinity;
    if (stdin !== null && new Blob([stdin]).size > maxInput) {
      toast.error(`The input is ${formatBytes(new Blob([stdin]).size)}; the limit is ${formatBytes(maxInput)}.`);
      return;
    }
    setHistoric(false);
    showInDrawer('result');
    if (narrow) setNarrowPane('code');
    void runner.start(language, code, mode, stdin);
  };
  const noRunner = hasRunner ? 'No runner for a language the judge offers.' : 'No runner yet.';
  const runSamples = () => {
    if (cannotRun) {
      toast.info(`Cannot be run. ${noRunner}`);
      return;
    }
    if (sampleCount === 0 && cases.isSuccess) {
      toast.info('There are no sample cases to run. Use a custom input, or add samples under Test cases.');
      showInDrawer('custom');
      return;
    }
    begin('run', null);
  };
  const submit = () => {
    if (cannotRun) {
      toast.info(`Cannot be run. ${noRunner}`);
      return;
    }
    if (item.testCaseCount === 0) {
      toast.info('This problem has no test cases yet, so there is nothing to submit against.');
      return;
    }
    begin('submit', null);
  };

  useHotkeys({
    'mod+enter': (e) => {
      e.preventDefault();
      runSamples();
    },
    'mod+shift+enter': (e) => {
      e.preventDefault();
      submit();
    },
    'mod+j': (e) => {
      e.preventDefault();
      toggleDrawer();
    },
    'mod+e': (e) => {
      e.preventDefault();
      toggleStatement();
    },
    'mod+shift+m': (e) => {
      e.preventDefault();
      toggleMaximise();
    },
  });

  // ---- Saved solutions ----

  const saveEditorCode = () => {
    if (!language) return;
    if (code.trim() === '') {
      toast.error('There is no code to save yet.');
      return;
    }
    setSaving({ language, source: code });
  };
  const saveSubmission = (summary: SubmissionSummary) => {
    const name = `${summary.verdict === 'accepted' ? 'Accepted' : languageName(summary.language)} ${summary.mode === 'submit' ? 'submission' : 'run'}, ${new Date(summary.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    const shown = runner.submission;
    if (shown && shown.id === summary.id) {
      setSaving({ language: shown.language, source: shown.source, name, submissionId: shown.id });
      return;
    }
    // The history lists submissions without their code; fetch the one that was picked.
    api.submissions.get(summary.id).then(
      (full) => setSaving({ language: full.language, source: full.source, name, submissionId: full.id }),
      (error: unknown) => toast.error(errorLine(error)),
    );
  };

  // An accepted submission made here is offered for keeping, once, unless
  // the same code is already among the saved solutions.
  const solutions = useSolutions(item.id).data;
  const offered = useRef<Set<string>>(new Set());
  const justJudged = runner.submission;
  useEffect(() => {
    const s = justJudged;
    if (!s || historic || s.status !== 'completed' || s.mode !== 'submit' || s.verdict !== 'accepted') return;
    if (solutions === undefined || offered.current.has(s.id)) return;
    offered.current.add(s.id);
    if (savedWithCode(solutions, s)) return;
    setSaving((open) => open ?? { language: s.language, source: s.source, submissionId: s.id, accepted: true });
  }, [justJudged, historic, solutions]);

  const loadSubmissionCode = () => {
    const s = runner.submission;
    if (!s) return;
    const previous = { language, code };
    if (languages.includes(s.language)) {
      if (language) saveCode(item.id, language, code);
      rememberLanguage(item.id, s.language);
      setLanguageState(s.language);
    }
    setCode(s.source);
    toast.success('Loaded the code from that submission', {
      label: 'Undo',
      onClick: () => {
        if (previous.language) setLanguageState(previous.language);
        setCode(previous.code);
      },
    });
  };

  if (!problem) return <PageLoading />;

  // Shown around the solver's code, collapsed, for the curious; it is changed by editing the problem.
  const activeRunner = language ? runners[language] : undefined;

  const description = (
    <div className="statement">
      <div className="statement-meta">
        <TagChips tags={item.tags} />
        <span className="muted">
          Time {formatMs(problem.timeLimitMs)} · Memory {formatMemoryKb(problem.memoryLimitKb)} · {problem.compare === 'tokens' ? 'whitespace-insensitive check' : 'exact output check'}
        </span>
        {item.source.url && (
          <a href={item.source.url} target="_blank" rel="noopener noreferrer" className="statement-source">
            <ExternalLink size={12} aria-hidden="true" />
            Source
          </a>
        )}
        {item.source.note && <span className="muted">· {item.source.note}</span>}
      </div>
      {item.body.trim() === '' ? (
        <Callout tone="info" title="No statement yet" actions={<Link to={`/items/${item.id}/edit`}>Write the statement</Link>}>
          This entry is still a fragment{item.summary ? `: “${item.summary}”` : ''}. Fill it in when you have a moment.
        </Callout>
      ) : (
        <Markdown source={item.body} />
      )}
    </div>
  );

  const left = (
    <div className="pane" ref={statementRef}>
      <div className="pane-tabs">
        <Tabs
          idBase="left"
          label="Problem information"
          value={leftTab}
          onChange={setLeftTab}
          tabs={[
            { value: 'description', label: 'Description' },
            { value: 'notes', label: 'Notes', count: item.notes.trim() ? 1 : null },
            { value: 'submissions', label: 'Submissions' },
            { value: 'variants', label: 'Variants', count: item.variantCount || null },
          ]}
        />
        <span className="spacer" />
        {!narrow && (
          <IconButton
            id={FOCUS.statementPane}
            size="sm"
            label={`Minimise the statement (${MOD}+E)`}
            icon={<PanelLeftClose size={16} />}
            onClick={() => setStatementMinimised(true)}
          />
        )}
      </div>
      <div className="pane-body" {...tabPanelProps('left', leftTab)} tabIndex={0}>
        {leftTab === 'description' && description}
        {leftTab === 'notes' && <Notes item={item} />}
        {leftTab === 'variants' && <Variants item={item} />}
        {leftTab === 'submissions' && (
          <HistoryList
            itemId={item.id}
            activeId={runner.submission?.id ?? null}
            timeLimitMs={problem.timeLimitMs}
            onOpen={(id) => {
              setHistoric(true);
              showInDrawer('result');
              runner.view(id);
              if (narrow) setNarrowPane('code');
            }}
            onSaveSolution={saveSubmission}
          />
        )}
      </div>
    </div>
  );

  const editor = (
    <div className="pane">
      <div className="editor-toolbar">
        <label htmlFor="solve-language" className="sr-only">
          Language
        </label>
        <select id="solve-language" name="language" className="input input-sm select solve-language" value={language ?? ''} onChange={(e) => setLanguage(e.target.value)} disabled={languages.length === 0}>
          {languages.map((l) => (
            <option key={l} value={l}>
              {languageName(l)}
              {versionOf(l) ? ` ${versionOf(l)}` : ''}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => void resetCode()} title="Replace your code with the starter code">
          Reset
        </Button>
        <span className="muted editor-saved">Kept in this browser</span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={<BookmarkPlus size={14} />} onClick={saveEditorCode} aria-label="Save as solution" title="Keep this code as one of the problem's saved solutions" className="editor-save">
          Save as solution
        </Button>
        {!narrow && (
          <IconButton
            size="sm"
            label={maximised ? `Restore the panes (${MOD}+Shift+M)` : `Maximise the editor (${MOD}+Shift+M)`}
            icon={maximised ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            aria-pressed={maximised}
            onClick={toggleMaximise}
          />
        )}
        {canRun && (
          <>
            <Button size="sm" icon={<Play size={14} />} onClick={runSamples} busy={runner.starting === 'run'} disabled={runner.judging} title={`Run against the sample cases (${MOD}+Enter)`}>
              Run
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Send size={14} />}
              onClick={submit}
              busy={runner.starting === 'submit'}
              disabled={runner.judging}
              title={`Submit against all ${plural(item.testCaseCount, 'test case')} (${MOD}+Shift+Enter)`}
            >
              Submit
            </Button>
          </>
        )}
      </div>
      {cannotRun && (
        <div className="editor-notice" role="note">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>Cannot be run. {noRunner}</span>
          <Link to={`/items/${item.id}/edit`}>Edit the problem</Link>
        </div>
      )}
      <div className="editor-host">
        <CodeEditor
          key={language ?? 'none'}
          value={code}
          onChange={setCode}
          language={language}
          // Keyed by language, so the runner rows start collapsed and the regions folded for each language.
          runner={activeRunner}
          foldRegions
          ariaLabel={`Solution code${language ? ` (${languageName(language)})` : ''}. Press Escape then Tab to leave the editor.`}
          shortcuts={[
            { key: 'Mod-Enter', run: runSamples },
            { key: 'Shift-Mod-Enter', run: submit },
            { key: 'Mod-j', run: toggleDrawer },
            { key: 'Mod-e', run: toggleStatement },
            { key: 'Mod-b', run: shell.toggleNav },
            { key: 'Shift-Mod-m', run: toggleMaximise },
          ]}
        />
      </div>
    </div>
  );

  // ---- Tests and results drawer ----

  const sub = runner.submission;
  // Code that is already among the saved solutions is not offered for saving again.
  const kept = sub && sub.status === 'completed' ? savedWithCode(solutions, sub) : undefined;
  const customRun = sub != null && sub.mode === 'run' && sub.results.length > 0 && sub.results.every((r) => r.testCaseId === null);
  // One line for the minimised drawer: what is happening, or how the last attempt went.
  const status: { text: string; tone: string; busy?: boolean } = !judgeOn
    ? { text: 'Running code is not available here', tone: 'neutral' }
    : cannotRun
      ? { text: 'No runner to run this with', tone: 'neutral' }
      : runner.starting
      ? { text: 'Sending…', tone: 'neutral', busy: true }
      : sub && sub.status !== 'completed'
        ? { text: sub.status === 'queued' ? 'Queued…' : `Running… ${sub.results.length} of ${sub.totalCount} done`, tone: 'neutral', busy: true }
        : sub?.verdict
          ? {
              text:
                customRun || sub.verdict === 'compile_error' || sub.verdict === 'internal_error'
                  ? VERDICT_LABEL[sub.verdict]
                  : `${VERDICT_LABEL[sub.verdict]} · ${sub.passedCount}/${sub.totalCount} passed`,
              tone: verdictTone(sub.verdict),
            }
          : runner.startError != null
            ? { text: 'The run could not be started', tone: 'danger' }
            : item.lastVerdict
              ? { text: `Last submission: ${VERDICT_LABEL[item.lastVerdict]}`, tone: verdictTone(item.lastVerdict) }
              : { text: item.testCaseCount === 0 ? 'No test cases yet' : 'Not run yet', tone: 'neutral' };

  const drawerTabs: { value: DrawerTab; label: string; count?: number }[] = [
    { value: 'tests', label: 'Tests', count: item.testCaseCount },
    { value: 'result', label: 'Result' },
    ...(canRun ? [{ value: 'custom' as const, label: 'Custom input' }] : []),
  ];

  const drawerBar = (
    <div className="drawer-bar">
      <button
        type="button"
        id={FOCUS.drawerBar}
        className="drawer-bar-btn drawer-bar-open"
        onClick={() => setDrawer(true)}
        aria-expanded={false}
        aria-label="Show tests and results"
        title={`Show tests and results (${MOD}+J)`}
      >
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      {drawerTabs.map((t) => (
        <button key={t.value} type="button" className="drawer-bar-btn" onClick={() => setDrawer(true, t.value)}>
          {t.label}
          {t.count != null && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
      <button type="button" className={cx('drawer-bar-btn drawer-bar-status', `tone-${status.tone}`)} onClick={() => setDrawer(true, 'result')} title="Show the result">
        {status.busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
        <span className="truncate" role="status">
          {status.text}
        </span>
      </button>
    </div>
  );

  const resultTab = !judgeOn ? (
    <div className="no-judge">
      <ServerOff size={20} aria-hidden="true" />
      <div>
        <h2>Running code is not available here</h2>
        <p>
          This server has no judge engine configured, so code cannot be run or submitted. Everything else works: read the problem, keep notes, and draft a solution — the editor keeps it in this
          browser.
        </p>
        <Link to="/settings/judge">Judge status</Link>
      </div>
    </div>
  ) : (
    <>
      {runner.startError != null && <ErrorCallout error={runner.startError} title="The run could not be started" />}
      {runner.pollError != null && <ErrorCallout error={runner.pollError} title="Lost track of this run" onRetry={runner.retryPoll} />}
      {sub ? (
        <ResultPanel
          submission={sub}
          compare={problem.compare}
          timeLimitMs={problem.timeLimitMs}
          reveal={reveal}
          historic={historic}
          onLoadCode={loadSubmissionCode}
          onClose={() => {
            setHistoric(false);
            runner.clear();
          }}
          onSaveSolution={sub.status === 'completed' && sub.source.trim() !== '' ? () => saveSubmission(sub) : undefined}
          savedAsSolution={savedFrom.has(sub.id)}
          alreadySaved={kept ? { name: kept.name, to: `/items/${item.id}/solutions` } : null}
        />
      ) : runner.loading ? (
        <PageLoading />
      ) : runner.starting ? (
        <PageLoading label="Sending…" />
      ) : (
        runner.startError == null &&
        (cannotRun ? (
          <Callout tone="warn" title="This problem cannot be run yet" actions={<Link to={`/items/${item.id}/edit`}>Edit the problem</Link>}>
            {noRunner}
          </Callout>
        ) : item.testCaseCount === 0 ? (
          <Callout tone="info" title="No test cases yet" actions={<Link to={`/items/${item.id}/tests`}>Add test cases</Link>}>
            Without test cases this problem cannot be judged. You can still run your code against a custom input.
          </Callout>
        ) : (
          <p className="console-hint">
            <strong>Run</strong> executes the {plural(sampleCount, 'sample case')}. <strong>Submit</strong> judges against all {plural(item.testCaseCount, 'test case')} and records the verdict.
          </p>
        ))
      )}
    </>
  );

  const drawer = (
    <div className="pane drawer" ref={drawerRef}>
      <div className="pane-tabs">
        <Tabs idBase="drawer" label="Tests and results" value={drawerTab} onChange={setDrawerTab} tabs={drawerTabs} />
        <span className="spacer" />
        {judgeOn && !judge?.healthy && <span className="judge-warn truncate">The judge engine is not responding — runs may fail</span>}
        <IconButton
          id={FOCUS.drawerPane}
          size="sm"
          label={`Minimise tests and results (${MOD}+J)`}
          icon={<ChevronDown size={16} />}
          onClick={() => setDrawer(false)}
        />
      </div>
      <div className="pane-body" {...tabPanelProps('drawer', drawerTab)} tabIndex={0}>
        {drawerTab === 'tests' && (
          <CaseList
            item={item}
            cases={cases}
            reveal={reveal}
            aiEnabled={meta?.ai.enabled ?? false}
            onUseInput={
              canRun
                ? (stdin) => {
                    setCustomInput(stdin);
                    setDrawerTab('custom');
                  }
                : undefined
            }
          />
        )}
        {drawerTab === 'result' && resultTab}
        {drawerTab === 'custom' && (
          <div className="custom-input">
            {/* A test case's input can be far too large for a textarea; it is run as it is. */}
            {isLargeText(customInput) ? (
              <>
                <span className="field-label">Standard input for one run</span>
                <LargeText
                  text={customInput}
                  filename={textFilename(item.title, 'custom input')}
                  onClear={() => setCustomInput('')}
                  label="Standard input for one run"
                />
              </>
            ) : (
              <>
                <label htmlFor="custom-stdin" className="field-label">
                  Standard input for one run
                </label>
                <textarea
                  name="stdin"
                  id="custom-stdin"
                  translate="no"
                  className="input textarea mono"
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  placeholder={solutionOnly ? 'One JSON value per line, one per argument…' : 'Type or paste the input your program should read…'}
                />
              </>
            )}
            <div className="row">
              <Button size="sm" icon={<Play size={14} />} onClick={() => begin('run', customInput)} disabled={runner.judging}>
                Run with this input
              </Button>
              <span className="muted">The output is shown as it is; nothing is compared.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const right = (
    <SplitPane
      direction="vertical"
      storageKey="solve-drawer"
      label="Resize the editor and the tests and results drawer"
      initial={0.55}
      min={0.2}
      max={0.8}
      first={editor}
      second={drawer}
      collapsed={drawerOpen ? null : 'second'}
      bar={drawerBar}
    />
  );

  const statementBar = (
    <button
      type="button"
      id={FOCUS.statementBar}
      className="pane-rail"
      onClick={() => setStatementMinimised(false)}
      aria-expanded={false}
      aria-label="Show the statement"
      title={`Show the statement (${MOD}+E)`}
    >
      <PanelLeftOpen size={16} aria-hidden="true" />
      <span className="pane-rail-label">Statement</span>
    </button>
  );

  return (
    <div className="workspace">
      <ItemBar item={item} />
      {narrow ? (
        <>
          <div className="workspace-switch">
            <Tabs
              idBase="narrow"
              label="Workspace"
              value={narrowPane}
              onChange={setNarrowPane}
              tabs={[
                { value: 'problem', label: 'Problem' },
                { value: 'code', label: 'Code' },
              ]}
            />
          </div>
          <div className="workspace-body">{narrowPane === 'problem' ? left : right}</div>
        </>
      ) : (
        <div className="workspace-body">
          <SplitPane
            direction="horizontal"
            storageKey="solve-statement"
            label="Resize statement and editor"
            initial={0.36}
            min={0.2}
            max={0.65}
            first={left}
            second={right}
            collapsed={statementMin ? 'first' : null}
            bar={statementBar}
          />
        </div>
      )}
      <SaveSolutionDialog
        item={item}
        open={saving !== null}
        onClose={() => setSaving(null)}
        initial={saving ?? { language: language ?? '', source: '' }}
        accepted={saving?.accepted}
        onSaved={() => {
          const from = saving?.submissionId;
          if (from) setSavedFrom((prev) => new Set(prev).add(from));
        }}
      />
    </div>
  );
}
