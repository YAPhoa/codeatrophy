/*
 * How the editor colours code: which syntax tags take which role of the code
 * theme (lib/codeThemes.ts). A language that tells things apart that its
 * grammar's tags do not (Python's, in pythonSyntax.ts) tags them with the
 * tags below, or marks ranges with `roleMark`.
 */

import { HighlightStyle } from '@codemirror/language';
import { Decoration, EditorView } from '@codemirror/view';
import { Tag, tags as t } from '@lezer/highlight';
import { roleColor, SYNTAX_ROLES, type SyntaxRole } from '../lib/codeThemes';

/** Tags for roles the standard tags have no name for. */
export const codeTags = {
  /** A parameter's name where it is declared. */
  parameter: Tag.define(t.variableName),
  /** A part of a string that is not its text: an f-string's braces, conversion and format spec. */
  stringPart: Tag.define(t.string),
  /** A decorator's `@` and name. */
  decorator: Tag.define(t.meta),
};

interface RoleRule {
  role: SyntaxRole;
  tags: Tag[];
  fontStyle?: string;
  fontWeight?: string;
}

/** The tags each role colours. A tag takes the role of the most specific tag listed for it. */
export const ROLE_TAGS: readonly RoleRule[] = [
  // Declaring keywords (def, class, const) apart from those that steer or import (if, return, from), as VS Code does.
  { role: 'declare', tags: [t.keyword, t.definitionKeyword, t.modifier] },
  { role: 'control', tags: [t.controlKeyword, t.moduleKeyword] },
  { role: 'operatorWord', tags: [t.operatorKeyword] },
  { role: 'constant', tags: [t.bool, t.null, t.atom] },
  { role: 'number', tags: [t.number] },
  // Markdown's inline code too.
  { role: 'string', tags: [t.string, t.special(t.string), t.character, t.regexp, t.docString, t.monospace] },
  { role: 'stringPart', tags: [codeTags.stringPart] },
  { role: 'escape', tags: [t.escape] },
  { role: 'comment', tags: [t.comment, t.lineComment, t.blockComment, t.docComment], fontStyle: 'italic' },
  // Markdown's links too.
  { role: 'function', tags: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.link, t.url] },
  { role: 'decorator', tags: [codeTags.decorator] },
  { role: 'type', tags: [t.typeName, t.className, t.namespace, t.standard(t.typeName)] },
  { role: 'parameter', tags: [codeTags.parameter] },
  { role: 'meta', tags: [t.meta, t.annotation, t.processingInstruction, t.self] },
  // Markdown's quotes, which read as an aside.
  { role: 'comment', tags: [t.quote] },
  { role: 'text', tags: [t.heading], fontWeight: '600' },
  { role: 'invalid', tags: [t.invalid] },
];

export const codeHighlightStyle = HighlightStyle.define([
  ...ROLE_TAGS.map(({ role, tags, fontStyle, fontWeight }) => ({
    tag: tags,
    color: roleColor(role),
    ...(fontStyle && { fontStyle }),
    ...(fontWeight && { fontWeight }),
  })),
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
]);

/** The class of a range marked with a role, for what a grammar's tags cannot tell apart. */
export function roleClass(role: SyntaxRole): string {
  return `cm-code-${role}`;
}

const marks = Object.fromEntries(SYNTAX_ROLES.map((role) => [role, Decoration.mark({ class: roleClass(role) })])) as Record<
  SyntaxRole,
  Decoration
>;

/** A mark decoration that colours its range in a role. */
export function roleMark(role: SyntaxRole): Decoration {
  return marks[role];
}

/** The colours of `roleMark`'s classes. */
export const roleMarkTheme = EditorView.baseTheme(
  Object.fromEntries(SYNTAX_ROLES.map((role) => [`.${roleClass(role)}`, { color: roleColor(role) }])),
);
