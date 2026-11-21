/*
 * Python's colours beyond what its grammar tags (@lezer/python). Two parts:
 *
 * - `pythonStyleTags`, more tags by place in the tree: the names in an
 *   annotation as types, parameters where declared, the keywords that steer
 *   apart from those that declare, the parts of an f-string, decorators.
 * - `pythonMarks`, for what a place in the tree cannot tell: built-in types
 *   and exceptions and `self` / `cls` (by their text), keyword arguments (a
 *   name followed by `=`), string prefixes (inside a string's token). The
 *   editor draws them as mark decorations (`pythonDecorations`).
 */

import { syntaxTree } from '@codemirror/language';
import type { Extension, Text } from '@codemirror/state';
import { type DecorationSet, Decoration, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { styleTags, tags as t } from '@lezer/highlight';
import type { SyntaxRole } from '../lib/codeThemes';
import { codeTags, roleMark } from './codeHighlight';

/** How deep inside an annotation a name is still coloured, as in `dict[str, list[Optional[Node]]]`. */
const DEPTH = 6;

/** `name` anywhere under one of `roots`, up to DEPTH levels down. */
const under = (roots: string[], name: string): string =>
  roots.flatMap((root) => Array.from({ length: DEPTH }, (_, i) => [root, ...Array<string>(i).fill('*'), name].join('/'))).join(' ');

/** Annotations (`x: int`, `-> Node`) and the right-hand side of a `type X = …` alias. */
const TYPE_PLACES = ['TypeDef', 'TypeDefinition', 'TypeParam'];

const COMPREHENSIONS = ['ComprehensionExpression', 'ArrayComprehensionExpression', 'SetComprehensionExpression', 'DictionaryComprehensionExpression'];

/** The loops whose `in` and `async` steer, rather than test or declare. */
const LOOPS = ['ForStatement', ...COMPREHENSIONS];

export const pythonStyleTags = styleTags({
  // Lezer's Python grammar marks an annotation (`TypeDef`) but tags the names in it as plain variables.
  [under(TYPE_PLACES, 'VariableName')]: t.typeName,
  [under(TYPE_PLACES, 'PropertyName')]: t.typeName,
  // A parameter where it is declared, and a keyword in a class pattern (`case Point(x=0)`); their uses stay plain.
  'ParamList/VariableName KeywordPattern/VariableName': codeTags.parameter,
  // The grammar files `from` with def and class; in an import or `raise … from` it is not a declaration.
  'ImportStatement/from': t.moduleKeyword,
  'RaiseStatement/from YieldStatement/from YieldExpression/from': t.controlKeyword,
  // `in` of a loop steers; elsewhere it tests membership, as `not in` does.
  [LOOPS.map((loop) => `${loop}/in`).join(' ')]: t.controlKeyword,
  // `async` declares in `async def`, and steers in `async for` and `async with`.
  [[...LOOPS, 'WithStatement'].map((p) => `${p}/async`).join(' ')]: t.controlKeyword,
  'WithStatement/with */as': t.controlKeyword,
  'DeleteStatement/del': t.controlKeyword,
  // The soft keyword of a type alias, `type X = …`.
  'TypeDefinition/type': t.definitionKeyword,
  'FormatReplacement/{ FormatReplacement/} FormatConversion FormatSpec FormatSpec/:': codeTags.stringPart,
  'Decorator/At Decorator/VariableName Decorator/.': codeTags.decorator,
});

/** Python's built-in types and exception classes, which take the type colour wherever they are named. */
export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  ...['int', 'str', 'bool', 'float', 'complex', 'bytes', 'bytearray', 'object', 'list', 'dict', 'set', 'frozenset', 'tuple', 'type', 'range', 'memoryview'],
  ...['BaseException', 'BaseExceptionGroup', 'Exception', 'ExceptionGroup', 'GeneratorExit', 'KeyboardInterrupt', 'SystemExit'],
  ...['ArithmeticError', 'FloatingPointError', 'OverflowError', 'ZeroDivisionError', 'AssertionError', 'AttributeError', 'BufferError', 'EOFError'],
  ...['ImportError', 'ModuleNotFoundError', 'LookupError', 'IndexError', 'KeyError', 'MemoryError', 'NameError', 'UnboundLocalError'],
  ...['OSError', 'EnvironmentError', 'IOError', 'BlockingIOError', 'ChildProcessError', 'ConnectionError', 'BrokenPipeError'],
  ...['ConnectionAbortedError', 'ConnectionRefusedError', 'ConnectionResetError', 'FileExistsError', 'FileNotFoundError', 'InterruptedError'],
  ...['IsADirectoryError', 'NotADirectoryError', 'PermissionError', 'ProcessLookupError', 'TimeoutError', 'ReferenceError', 'RuntimeError'],
  ...['NotImplementedError', 'RecursionError', 'StopAsyncIteration', 'StopIteration', 'SyntaxError', 'IndentationError', 'TabError'],
  ...['SystemError', 'TypeError', 'ValueError', 'UnicodeError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeTranslateError'],
  ...['Warning', 'BytesWarning', 'DeprecationWarning', 'EncodingWarning', 'FutureWarning', 'ImportWarning', 'PendingDeprecationWarning'],
  ...['ResourceWarning', 'RuntimeWarning', 'SyntaxWarning', 'UnicodeWarning', 'UserWarning'],
]);

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = ReturnType<Tree['resolveInner']>;

export interface RoleRange {
  from: number;
  to: number;
  role: SyntaxRole;
}

/** The role of a name that its text or its neighbours decide, or null to leave it to the tags. */
function nameRole(node: SyntaxNode, doc: Text): SyntaxRole | null {
  const parent = node.parent?.name;
  // A decorator's name is the decorator's, whatever it is; a declared parameter is a parameter already.
  if (parent === 'Decorator' || parent === 'ParamList') return null;
  const next = node.nextSibling;
  if (parent === 'ArgList' && next?.name === 'AssignOp' && doc.sliceString(next.from, next.to) === '=') return 'parameter';
  const name = doc.sliceString(node.from, node.to);
  if (name === 'self' || name === 'cls') return 'parameter';
  if (BUILTIN_TYPES.has(name)) return 'type';
  return null;
}

const PREFIX = /^[A-Za-z]+/;

/** The ranges between `from` and `to` that take a role the tags cannot give them, in order. */
export function pythonMarks(tree: Tree, doc: Text, from = 0, to = doc.length): RoleRange[] {
  const out: RoleRange[] = [];
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'VariableName') {
        const role = nameRole(node.node, doc);
        if (role) out.push({ from: node.from, to: node.to, role });
      } else if (node.name === 'String' || node.name === 'FormatString') {
        const prefix = PREFIX.exec(doc.sliceString(node.from, Math.min(node.to, node.from + 4)));
        if (prefix) out.push({ from: node.from, to: node.from + prefix[0].length, role: 'stringPart' });
      }
    },
  });
  return out;
}

function decorations(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  // A node across two visible ranges is met in both.
  const ranges = new Map<string, RoleRange>();
  for (const { from, to } of view.visibleRanges) {
    for (const r of pythonMarks(tree, view.state.doc, from, to)) ranges.set(`${r.from}:${r.to}`, r);
  }
  return Decoration.set(
    [...ranges.values()].map((r) => roleMark(r.role).range(r.from, r.to)),
    true,
  );
}

/** `pythonMarks` over the visible part of the editor. */
export const pythonDecorations: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = decorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
