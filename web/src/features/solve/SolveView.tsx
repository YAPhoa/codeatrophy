import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, FlaskConical, Play, RotateCcw, Send, ServerOff } from 'lucide-react';
import { useMeta, useTestCases } from '../../api/queries';
import type { Item } from '../../api/types';
import { clearCode, initialCode, pickLanguage, rememberLanguage, saveCode } from '../../lib/codeStore';
import { formatBytes, formatMemoryKb, formatMs, plural } from '../../lib/format';
import { MOD, useHotkeys } from '../../lib/hotkeys';
import { LANGUAGES, languageName, sortLanguages } from '../../lib/languages';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { Button, LinkButton } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { useConfirm } from '../../ui/Dialog';
import { Markdown } from '../../ui/Markdown';
import { SplitPane } from '../../ui/SplitPane';
import { Callout, ErrorCallout, PageLoading, Tabs, tabPanelProps } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { TagChips } from '../item/controls';
import { ItemBar } from '../item/ItemBar';
import { Notes } from '../item/Notes';
import { Related } from '../item/Related';
import { HistoryList } from './HistoryList';
import { ResultPanel } from './ResultPanel';
import { useSubmissionRunner } from './useSubmissionRunner';

type LeftTab = 'description' | 'notes' | 'submissions';
type ConsoleTab = 'result' | 'custom';

/** The solving workspace: statement, notes and history on one side; editor and results on the other. */
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

  // With a judge, offer what it can run. Without one the editor is only a
  // scratchpad, so offer the languages that have starter code (or all).
  const languages = useMemo(() => {
    if (judgeOn) return (judge?.languages ?? []).map((l) => l.id);
    const withStarter = sortLanguages(Object.keys(starter));
    return withStarter.length > 0 ? withStarter : LANGUAGES.map((l) => l.id);
  }, [judgeOn, judge, starter]);
  const versionOf = (id: string) => judge?.languages.find((l) => l.id === id)?.version;

  const [language, setLanguageState] = useState<string | null>(() => pickLanguage(item.id, languages, starter));
  const [code, setCode] = useState(() => (language ? initialCode(item.id, language, starter) : ''));
  const [leftTab, setLeftTab] = useState<LeftTab>('description');
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('result');
  const [customInput, setCustomInput] = useState('');
  const [historic, setHistoric] = useState(false);
  const [narrowPane, setNarrowPane] = useState<'problem' | 'code'>('problem');
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
      confirmLabel: 'Reset',
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
    if (!judgeOn || runner.judging || !language || !checkSource()) return;
    const maxInput = meta?.limits.maxTestDataBytes ?? Infinity;
    if (stdin !== null && new Blob([stdin]).size > maxInput) {
      toast.error(`The input is ${formatBytes(new Blob([stdin]).size)}; the limit is ${formatBytes(maxInput)}.`);
      return;
    }
    setHistoric(false);
    setConsoleTab('result');
    if (narrow) setNarrowPane('code');
    void runner.start(language, code, mode, stdin);
  };
  const runSamples = () => {
    if (sampleCount === 0 && cases.isSuccess) {
      toast.info('There are no sample cases to run. Use a custom input, or add samples under Test cases.');
      setConsoleTab('custom');
      return;
    }
    begin('run', null);
  };
  const submit = () => {
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
  });

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
      <Related item={item} />
    </div>
  );

  const left = (
    <div className="pane">
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
          ]}
        />
      </div>
      <div className="pane-body" {...tabPanelProps('left', leftTab)} tabIndex={0}>
        {leftTab === 'description' && description}
        {leftTab === 'notes' && <Notes item={item} />}
        {leftTab === 'submissions' && (
          <HistoryList
            itemId={item.id}
            activeId={runner.submission?.id ?? null}
            onOpen={(id) => {
              setHistoric(true);
              setConsoleTab('result');
              runner.view(id);
              if (narrow) setNarrowPane('code');
            }}
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
        <select id="solve-language" className="input input-sm select solve-language" value={language ?? ''} onChange={(e) => setLanguage(e.target.value)} disabled={languages.length === 0}>
          {languages.map((l) => (
            <option key={l} value={l}>
              {languageName(l)}
              {versionOf(l) ? ` ${versionOf(l)}` : ''}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => void resetCode()} title="Replace your code with the starter code">
          Reset
        </Button>
        <span className="muted editor-saved">Kept in this browser</span>
        <span className="spacer" />
        {judgeOn && (
          <>
            <Button size="sm" icon={<Play size={13} />} onClick={runSamples} busy={runner.starting === 'run'} disabled={runner.judging} title={`Run against the sample cases (${MOD}+Enter)`}>
              Run
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Send size={13} />}
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
      <div className="editor-host">
        <CodeEditor
          key={language ?? 'none'}
          value={code}
          onChange={setCode}
          language={language}
          ariaLabel={`Solution code${language ? ` (${languageName(language)})` : ''}. Press Escape then Tab to leave the editor.`}
          shortcuts={[
            { key: 'Mod-Enter', run: runSamples },
            { key: 'Shift-Mod-Enter', run: submit },
          ]}
        />
      </div>
    </div>
  );

  const consolePane = !judgeOn ? (
    <div className="pane">
      <div className="pane-body">
        <div className="no-judge">
          <ServerOff size={20} aria-hidden="true" />
          <div>
            <h2>Running code is not available here</h2>
            <p>
              This server has no judge engine configured, so code cannot be run or submitted. Everything else works: read the problem, keep notes, and draft a solution — the editor keeps it in this
              browser.
            </p>
            <Link to="/settings#judge">Judge status</Link>
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div className="pane">
      <div className="pane-tabs">
        <Tabs
          idBase="console"
          label="Console"
          value={consoleTab}
          onChange={setConsoleTab}
          tabs={[
            { value: 'result', label: 'Result' },
            { value: 'custom', label: 'Custom input' },
          ]}
        />
        <span className="spacer" />
        {!judge?.healthy && <span className="judge-warn">The judge engine is not responding — runs may fail</span>}
      </div>
      <div className="pane-body" {...tabPanelProps('console', consoleTab)} tabIndex={0}>
        {consoleTab === 'custom' ? (
          <div className="custom-input">
            <label htmlFor="custom-stdin" className="field-label">
              Standard input for one run
            </label>
            <textarea
              id="custom-stdin"
              className="input textarea mono"
              rows={5}
              spellCheck={false}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="Type or paste the input your program should read."
            />
            <div className="row">
              <Button size="sm" icon={<Play size={13} />} onClick={() => begin('run', customInput)} disabled={runner.judging}>
                Run with this input
              </Button>
              <span className="muted">The output is shown as it is; nothing is compared.</span>
            </div>
          </div>
        ) : (
          <>
            {runner.startError != null && <ErrorCallout error={runner.startError} title="The run could not be started" />}
            {runner.pollError != null && <ErrorCallout error={runner.pollError} title="Lost track of this run" onRetry={runner.retryPoll} />}
            {runner.submission ? (
              <ResultPanel
                submission={runner.submission}
                compare={problem.compare}
                historic={historic}
                onLoadCode={loadSubmissionCode}
                onClose={() => {
                  setHistoric(false);
                  runner.clear();
                }}
              />
            ) : runner.loading ? (
              <PageLoading />
            ) : runner.starting ? (
              <PageLoading label="Sending…" />
            ) : (
              runner.startError == null &&
              (item.testCaseCount === 0 ? (
                <Callout
                  tone="info"
                  title="No test cases yet"
                  actions={
                    <>
                      <LinkButton size="sm" to={`/items/${item.id}/tests`}>
                        Add test cases
                      </LinkButton>
                      {meta?.ai.enabled && (
                        <LinkButton size="sm" to={`/items/${item.id}/tests/generate`} icon={<FlaskConical size={13} />}>
                          Generate with AI
                        </LinkButton>
                      )}
                    </>
                  }
                >
                  Without test cases this problem cannot be judged. You can still run your code against a custom input.
                </Callout>
              ) : (
                <p className="console-hint">
                  <strong>Run</strong> executes the {plural(sampleCount, 'sample case')}. <strong>Submit</strong> judges against all {plural(item.testCaseCount, 'test case')} and records the
                  verdict.
                </p>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );

  const right = <SplitPane direction="vertical" storageKey="solve-v" label="Resize editor and console" initial={0.6} min={0.25} max={0.85} first={editor} second={consolePane} />;

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
          <SplitPane direction="horizontal" storageKey="solve-h" label="Resize statement and editor" initial={0.44} min={0.25} max={0.7} first={left} second={right} />
        </div>
      )}
    </div>
  );
}
