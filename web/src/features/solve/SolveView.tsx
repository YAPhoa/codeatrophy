import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookmarkPlus, ChevronDown, ChevronUp, CloudOff, ExternalLink, Loader2, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Play, RotateCcw, Send, ServerOff } from 'lucide-react';
import { api } from '../../api/client';
import { useMeta, useSolutions, useTestCases } from '../../api/queries';
import type { Item, Submission, SubmissionSummary, WorkingCopy } from '../../api/types';
import { useShellLayout } from '../../app/shellLayout';
import { StatusSwap } from '../../ui/Animated';
import { clearLegacy, clearUnsaved, codeFor, loadCustomInput, openingLanguage, openWorkspace, readLegacy, readUnsaved, rememberedLanguage, rememberLanguage, saveCustomInput, sendOrder } from '../../lib/codeStore';
import { errorLine } from '../../lib/errors';
import { VERDICT_LABEL, formatBytes, formatMemoryKb, formatMs, plural, verdictTone } from '../../lib/format';
import { MOD, useHotkeys } from '../../lib/hotkeys';
import { LANGUAGES, languageName, sortLanguages } from '../../lib/languages';
import { isLargeText, textFilename } from '../../lib/largeText';
import { readJson, writeJson } from '../../lib/storage';
import { replaceNeedsConfirm } from '../../lib/submissions';
import { useUrlChoice, useUrlState } from '../../lib/urlState';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { Button, IconButton, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { useConfirm } from '../../ui/Dialog';
import { LargeText } from '../../ui/LargeText';
import { Markdown } from '../../ui/Markdown';
import { Select } from '../../ui/Select';
import { SplitPane } from '../../ui/SplitPane';
import { Callout, ErrorCallout, PageLoading, Tabs, tabPanelProps } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { ChangeSourceLine, TagChips } from '../item/controls';
import { ItemBar } from '../item/ItemBar';
import { Notes } from '../item/Notes';
import { Related, Variants } from '../item/Related';
import { SaveSolutionDialog } from '../solutions/SaveSolutionDialog';
import { savedWithCode, type RunFigures } from '../solutions/solutionWrites';
import { CaseList } from './CaseList';
import { HistoryList } from './HistoryList';
import { SubmissionDetails } from './SubmissionDetails';
import { ResultPanel } from './ResultPanel';
import { useReveal } from './useReveal';
import { useSubmissionRunner } from './useSubmissionRunner';
import { workspaceSaver } from './workingCopies';

/** Edits are kept in this browser this long after typing stops (ms)… */
const KEEP_LOCALLY_AFTER_MS = 600;
/** …and sent to the server this long after (ms). Leaving the page, the problem or the language sends at once. */
const SAVE_AFTER_MS = 2000;

/** The statement's widest (`.statement`, 820px) plus its pane's padding and a scrollbar: the divider stops there. */
const STATEMENT_PANE_MAX = 880;

// The open tabs are part of the address (`?tab=notes&panel=result&pane=code`), so a link or a reload lands on the same view.
const LEFT_TABS = ['description', 'notes', 'submissions', 'variants'] as const;
const DRAWER_TABS = ['tests', 'result', 'custom'] as const;
const NARROW_PANES = ['problem', 'code'] as const;
const parseId = (raw: string | null): string | null => raw || null;
const formatId = (id: string | null): string | null => id;
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
export function SolveView({ item, workingCopies }: { item: Item; workingCopies: readonly WorkingCopy[] }) {
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

  // The code comes from the working copies on the server, read as the page
  // opened, and from the edits this browser has not had confirmed yet.
  const qc = useQueryClient();
  const saver = useMemo(() => workspaceSaver(qc, item.id), [qc, item.id]);
  const [opened] = useState(() => openWorkspace(workingCopies, readUnsaved(item.id), readLegacy(item.id), rememberedLanguage(item.id)));
  /** The code of each language that has some of its own, for this visit. */
  const sources = useRef<Record<string, string>>({ ...opened.sources });
  const [language, setLanguageState] = useState<string | null>(() => openingLanguage(item.id, languages, opened.recent, starter));
  const [code, setCode] = useState(() => (language ? codeFor(opened.sources, starter, language) : ''));
  const failing = useSyncExternalStore(saver.subscribe, () => saver.failing);
  const saveError = failing ? saver.error : null;
  const [leftTab, setLeftTab] = useUrlChoice('tab', LEFT_TABS, 'description');
  const [drawerTab, setDrawerTab] = useUrlChoice('panel', DRAWER_TABS, 'tests');
  const [panes, setPanes] = useState(readPanes);
  // Running opens the drawer for the visit without changing what is remembered.
  // A link that names a drawer tab opens the drawer on it.
  const [drawerOpen, setDrawerOpen] = useState(panes.drawer || drawerTab !== 'tests');
  const statementMin = panes.statement && !narrow;
  const reveal = useReveal();
  const shell = useShellLayout();
  const [saving, setSaving] = useState<{ language: string; source: string; name?: string; run?: RunFigures; submissionId?: string; accepted?: boolean } | null>(null);
  const [savedFrom, setSavedFrom] = useState<ReadonlySet<string>>(() => new Set());
  const [customInput, setCustomInput] = useState(() => loadCustomInput(item.id));
  // The past submission open in the Submissions tab, in place of the list:
  // part of the address, each opening a step that Back undoes.
  const [openSubmission, setOpenSubmission] = useUrlState('submission', parseId, formatId, true);
  /** The details were opened from the list in this visit, so the list is one step back. */
  const openedFromList = useRef(false);
  /** The submission whose details were last left, so its row takes the focus back. */
  const [leftSubmission, setLeftSubmission] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useUrlChoice('pane', NARROW_PANES, 'problem');
  const runner = useSubmissionRunner(item.id);

  // ---- Saving the code ----

  /** What the editor holds. */
  const latest = useRef({ language, code });
  /** The code last put into the editor from outside or handed to the saver: what differs from it is an edit. */
  const recorded = useRef({ language, code });
  /** Hand an edit, if there is one, to the saver, which keeps it in this browser until the server has it. */
  const record = useCallback(() => {
    const { language: l, code: c } = latest.current;
    if (!l || (recorded.current.language === l && recorded.current.code === c)) return;
    saver.edit(l, c);
    sources.current[l] = c;
    recorded.current = { language: l, code: c };
  }, [saver]);
  /** Put code into the editor that is not an edit: opening, switching language, a reset. */
  const load = (l: string | null, c: string) => {
    latest.current = { language: l, code: c };
    recorded.current = { language: l, code: c };
    setLanguageState(l);
    setCode(c);
  };

  // As the problem opens: what the server does not have yet is sent, the
  // language it opens with last, and the unsaved edits that lost are
  // forgotten. Code an older version kept only in this browser goes up
  // once, where the server has none, and is removed either way.
  useEffect(() => {
    saver.seed(workingCopies);
    for (const l of opened.drop) if (!saver.unsent(l)) clearUnsaved(item.id, l);
    for (const [l, source] of Object.entries(opened.send)) saver.edit(l, source);
    for (const l of Object.keys(readLegacy(item.id))) clearLegacy(item.id, l);
    void saver.sendAll(sendOrder(opened.send, latest.current.language));
    // Once per opening: what changes later is the editor's own doing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saver]);

  // The judge's language list can arrive or change after the first render.
  useEffect(() => {
    if (language && languages.includes(language)) return;
    record();
    const next = openingLanguage(item.id, languages, opened.recent, starter);
    load(next, next ? codeFor(sources.current, starter, next) : '');
  }, [languages, language, item.id, starter, opened, record]);

  // Kept here a moment after typing stops, and sent a moment later, with
  // anything an earlier attempt could not save.
  useEffect(() => {
    latest.current = { language, code };
    if (!language) return;
    const keep = window.setTimeout(record, KEEP_LOCALLY_AFTER_MS);
    const send = window.setTimeout(() => {
      record();
      void saver.sendAll();
    }, SAVE_AFTER_MS);
    return () => {
      window.clearTimeout(keep);
      window.clearTimeout(send);
    };
  }, [language, code, record, saver]);

  // Sent at once when the page goes away or the tab is hidden, as a request
  // that outlives the page, and on leaving the problem. Tried again when the
  // browser is back online.
  useEffect(() => {
    const flush = () => {
      record();
      const l = latest.current.language;
      if (l) void saver.send(l, { keepalive: true });
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const retry = () => void saver.sendAll();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('online', retry);
      record();
      void saver.sendAll();
    };
  }, [record, saver]);

  // And the custom input, per item, within a size that storage can spare.
  const latestInput = useRef(customInput);
  useEffect(() => {
    latestInput.current = customInput;
    const t = window.setTimeout(() => saveCustomInput(item.id, customInput), 300);
    return () => window.clearTimeout(t);
  }, [item.id, customInput]);
  useEffect(() => () => saveCustomInput(item.id, latestInput.current), [item.id]);

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

  /** Switch language: the code so far is sent, and the other language opens on its own code, else its starter. */
  const setLanguage = (next: string) => {
    record();
    if (language) void saver.send(language);
    rememberLanguage(item.id, next);
    load(next, codeFor(sources.current, starter, next));
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
    saver.reset(language, target);
    delete sources.current[language];
    load(language, target);
    void saver.send(language);
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
    showInDrawer('result');
    if (narrow) setNarrowPane('code');
    void runner.start(language, code, mode, stdin);
  };
  const noRunnerWhy = hasRunner ? 'no runner for any language the judge supports' : 'no runner yet';
  const noRunner = `Cannot run: ${noRunnerWhy}.`;
  const runSamples = () => {
    if (cannotRun) {
      toast.info(noRunner);
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
      toast.info(noRunner);
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
  const saveSubmission = (summary: SubmissionSummary | Submission) => {
    const name = `${summary.verdict === 'accepted' ? 'Accepted' : languageName(summary.language)} ${summary.mode === 'submit' ? 'submission' : 'run'}, ${new Date(summary.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    const shown = 'source' in summary ? summary : runner.submission?.id === summary.id ? runner.submission : null;
    if (shown) {
      setSaving({ language: shown.language, source: shown.source, name, run: shown, submissionId: shown.id });
      return;
    }
    // The history lists submissions without their code; fetch the one that was picked.
    api.submissions.get(summary.id).then(
      (full) => setSaving({ language: full.language, source: full.source, name, run: full, submissionId: full.id }),
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
    if (!s || s.status !== 'completed' || s.mode !== 'submit' || s.verdict !== 'accepted') return;
    if (solutions === undefined || offered.current.has(s.id)) return;
    offered.current.add(s.id);
    if (savedWithCode(solutions, s)) return;
    setSaving((open) => open ?? { language: s.language, source: s.source, run: s, submissionId: s.id, accepted: true });
  }, [justJudged, solutions]);

  // ---- Past submissions ----

  /** Set by "Open in editor": the editor takes the focus once it shows the code. */
  const focusEditor = useRef(false);
  /** Why a language's code cannot go into the editor, or `null`. */
  const blockedReason = (l: string): string | null => (languages.includes(l) ? null : `${languageName(l)} is not offered here`);

  /**
   * Put a past submission's code into the editor, in its language, saved as
   * an edit. Work of the user's own in that language is only replaced after
   * they agree.
   */
  const openInEditor = async (s: Submission) => {
    if (blockedReason(s.language) !== null) return;
    // What the editor would show for that language: this visit's code, from an unsaved edit, the working copy or older code kept here.
    const current = s.language === language ? code : sources.current[s.language];
    if (replaceNeedsConfirm(current, starter[s.language], s.source)) {
      const name = languageName(s.language);
      const ok = await confirm({
        title: `Replace your ${name} code?`,
        body: `You have work in ${name} on this problem. Opening this submission replaces it.`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
    }
    if (s.language !== language) {
      record();
      if (language) void saver.send(language);
      rememberLanguage(item.id, s.language);
    }
    latest.current = { language: s.language, code: s.source };
    setLanguageState(s.language);
    setCode(s.source);
    record();
    void saver.send(s.language);
    if (narrow) setNarrowPane('code');
    focusEditor.current = true;
  };

  // After "Open in editor", the editor takes the focus once it is there (a new language mounts a new one).
  useEffect(() => {
    if (!focusEditor.current) return;
    let frames = 0;
    let raf = 0;
    const tryFocus = () => {
      const target = document.querySelector<HTMLElement>('.editor-host .cm-content');
      if (target) {
        focusEditor.current = false;
        target.focus();
      } else if (++frames < 60) raf = requestAnimationFrame(tryFocus);
    };
    // A frame later: a new editor can be set up twice as it mounts (React's strict mode), the first one gone.
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [language, code, narrowPane]);

  // A link to a submission opens the Submissions tab on it.
  useEffect(() => {
    if (openSubmission && !new URLSearchParams(window.location.search).has('tab')) setLeftTab('submissions');
    // Only as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showSubmission = (id: string) => {
    openedFromList.current = true;
    setLeftSubmission(null);
    setOpenSubmission(id);
  };
  const backToList = () => {
    setLeftSubmission(openSubmission);
    // Opened from the list: the list is the step before, so Back and this agree.
    if (openedFromList.current) {
      openedFromList.current = false;
      window.history.back();
    } else setOpenSubmission(null);
  };

  if (!problem) return <PageLoading />;

  // Shown around the solver's code, collapsed, for the curious; it is changed by editing the problem.
  const activeRunner = language ? runners[language] : undefined;

  const description = (
    <div className="statement">
      {item.body.trim() === '' ? (
        <Callout tone="info" title="No statement yet" actions={<Link to={`/items/${item.id}/edit`}>Write the statement</Link>}>
          {item.summary ? `So far this problem has only a summary: “${item.summary}”.` : 'So far this problem has only a title.'}
        </Callout>
      ) : (
        <Markdown source={item.body} />
      )}
      {/* After the statement: its tags, then how it is judged and where it came from. */}
      <div className="statement-facts">
        {item.tags.length > 0 && (
          <div className="statement-fact">
            <span className="muted">Tags:</span>
            <TagChips tags={item.tags} />
          </div>
        )}
        <div className="statement-fact">
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
        <ChangeSourceLine createdBy={item.createdBy} lastUpdatedBy={item.lastUpdatedBy} className="muted" />
      </div>
      <Related item={item} />
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
        {leftTab === 'submissions' &&
          (openSubmission ? (
            <SubmissionDetails
              key={openSubmission}
              itemId={item.id}
              submissionId={openSubmission}
              compare={problem.compare}
              timeLimitMs={problem.timeLimitMs}
              reveal={reveal}
              focusOnOpen={openedFromList.current}
              onBack={backToList}
              blockedReason={blockedReason}
              onOpenInEditor={(s) => void openInEditor(s)}
              onSaveSolution={saveSubmission}
              savedFrom={savedFrom}
              solutions={solutions}
            />
          ) : (
            <HistoryList itemId={item.id} focusId={leftSubmission} timeLimitMs={problem.timeLimitMs} onOpen={showSubmission} onSaveSolution={saveSubmission} />
          ))}
      </div>
    </div>
  );

  const editor = (
    <div className="pane">
      <div className="editor-toolbar">
        <label htmlFor="solve-language" className="sr-only">
          Language
        </label>
        <Select
          id="solve-language"
          name="language"
          className="input-sm solve-language"
          value={language ?? ''}
          onChange={setLanguage}
          options={languages.map((l) => ({ value: l, label: `${languageName(l)}${versionOf(l) ? ` ${versionOf(l)}` : ''}` }))}
          disabled={languages.length === 0}
        />
        <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => void resetCode()} title="Replace your code with the starter code">
          Reset
        </Button>
        <span className="editor-save-status" title={failing ? `Kept in this browser until it is saved: ${errorLine(saveError)}` : undefined}>
          <StatusSwap icon={failing ? <CloudOff size={13} /> : null} text={failing ? 'Not saved' : ''} />
        </span>
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
          <span>{noRunner}</span>
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
      ? { text: 'No runner available', tone: 'neutral' }
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
          This server has no judge engine configured, so code cannot be run or submitted. You can still read the problem, keep notes and write a solution; the editor keeps your code.
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
            {hasRunner ? 'No runner for any language the judge supports.' : 'No runner yet.'}
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
        {judgeOn && !judge?.healthy && <span className="judge-warn truncate">The judge engine is not responding, so runs may fail</span>}
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
            maxFirstPx={STATEMENT_PANE_MAX}
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
