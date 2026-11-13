/*
 * The runner of a "Solution only" problem, shown around the solver's code in
 * the solve editor: a collapsed row above the first line for the code that
 * runs before theirs, one below the last line for the code after it. A row
 * expands in place to the runner code, read-only and dimmed.
 *
 * The rows are block widgets, not text: the document stays the solver's code
 * alone, so line numbers, selection, copying, undo, saved drafts and
 * submissions are about that code only.
 */

import { highlightingFor, language, type Language } from '@codemirror/language';
import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { highlightCode, type Highlighter } from '@lezer/highlight';
import { plural } from '../lib/format';

export interface RunnerCode {
  prefix: string;
  suffix: string;
}

type Part = 'prefix' | 'suffix';
type Expanded = Readonly<Record<Part, boolean>>;

const COLLAPSED: Expanded = { prefix: false, suffix: false };

const runnerCode = Facet.define<RunnerCode, RunnerCode | null>({ combine: (values) => values[0] ?? null });

const toggleRunner = StateEffect.define<Part>();

/** The part as shown: without the blank lines it starts or ends with. Empty when there is nothing to show. */
function shownCode(source: string): string {
  return source.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

class RunnerWidget extends WidgetType {
  constructor(
    readonly part: Part,
    readonly code: string,
    readonly expanded: boolean,
    readonly lang: Language | null,
    /** The editor's own highlighting, which does not change during its life. */
    readonly highlighter: Highlighter,
  ) {
    super();
  }

  eq(other: RunnerWidget): boolean {
    return other.part === this.part && other.code === this.code && other.expanded === this.expanded && other.lang === this.lang;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `cm-runner cm-runner-${this.part}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cm-runner-toggle';
    toggle.addEventListener('click', () => view.dispatch({ effects: toggleRunner.of(this.part) }));
    dom.append(toggle);
    this.fill(dom, toggle);
    return dom;
  }

  /** Expanding or collapsing keeps the row's button, and with it the focus. */
  updateDOM(dom: HTMLElement): boolean {
    const toggle = dom.querySelector<HTMLButtonElement>('.cm-runner-toggle');
    if (!toggle || !dom.classList.contains(`cm-runner-${this.part}`)) return false;
    this.fill(dom, toggle);
    return true;
  }

  private fill(dom: HTMLElement, toggle: HTMLButtonElement): void {
    const lines = plural(this.code.split('\n').length, 'line');
    dom.classList.toggle('cm-runner-open', this.expanded);
    toggle.setAttribute('aria-expanded', String(this.expanded));
    toggle.setAttribute('aria-label', `Runner · ${lines}, ${this.part === 'prefix' ? 'before' : 'after'} your code`);
    toggle.title = this.expanded ? 'Hide the runner' : 'Show the runner';
    toggle.replaceChildren(chevron(), text('span', `Runner · ${lines}`));
    if (!this.expanded) toggle.append(text('span', '…', 'cm-runner-more'));
    dom.querySelector('.cm-runner-code')?.remove();
    if (this.expanded) dom.append(this.codeDOM());
  }

  private codeDOM(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'cm-runner-code';
    let line = document.createElement('div');
    line.className = 'cm-runner-line';
    block.append(line);
    const putText = (code: string, classes: string) => line.append(classes ? text('span', code, classes) : code);
    const putBreak = () => {
      line = document.createElement('div');
      line.className = 'cm-runner-line';
      block.append(line);
    };
    try {
      if (!this.lang) throw new Error('no language');
      highlightCode(this.code, this.lang.parser.parse(this.code), this.highlighter, putText, putBreak);
    } catch {
      block.replaceChildren();
      for (const l of this.code.split('\n')) {
        putBreak();
        line.append(l);
      }
    }
    // An empty line would have no height of its own.
    for (const l of block.children) if (l.childNodes.length === 0) l.append(document.createElement('br'));
    return block;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function text(tag: string, content: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = content;
  if (className) el.className = className;
  return el;
}

/** The chevron of lucide's `ChevronRight`; turned down when expanded, by the theme. */
function chevron(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '12', height: '12', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'cm-runner-chevron' })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'm9 18 6-6-6-6');
  svg.append(path);
  return svg;
}

function rows(state: EditorState, expanded: Expanded): DecorationSet {
  const runner = state.facet(runnerCode);
  if (!runner) return Decoration.none;
  const lang = state.facet(language);
  const highlighter: Highlighter = { style: (tags) => highlightingFor(state, tags) };
  const ranges: Range<Decoration>[] = [];
  for (const part of ['prefix', 'suffix'] as const) {
    const code = shownCode(runner[part]);
    if (code === '') continue;
    const widget = new RunnerWidget(part, code, expanded[part], lang, highlighter);
    ranges.push(Decoration.widget({ widget, block: true, side: part === 'prefix' ? -1 : 1 }).range(part === 'prefix' ? 0 : state.doc.length));
  }
  return Decoration.set(ranges, true);
}

/** Block decorations have to come from a state field rather than a view plugin. */
const runnerRows = StateField.define<{ expanded: Expanded; decorations: DecorationSet }>({
  create: (state) => ({ expanded: COLLAPSED, decorations: rows(state, COLLAPSED) }),
  update(value, tr) {
    let expanded = value.expanded;
    for (const e of tr.effects) if (e.is(toggleRunner)) expanded = { ...expanded, [e.value]: !expanded[e.value] };
    const runnerChanged = tr.startState.facet(runnerCode) !== tr.state.facet(runnerCode);
    if (runnerChanged) expanded = COLLAPSED;
    const restyled = tr.startState.facet(language) !== tr.state.facet(language);
    if (expanded === value.expanded && !runnerChanged && !restyled && !tr.docChanged) return value;
    return { expanded, decorations: rows(tr.state, expanded) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The rows for `runner`, collapsed; nothing without one. */
export function runnerExtension(runner: RunnerCode | null | undefined): Extension {
  return runner ? [runnerCode.of(runner), runnerRows] : [];
}
