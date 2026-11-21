import { styleTags, tags as t } from '@lezer/highlight';

/** How deep inside an annotation a name is still coloured, as in `dict[str, list[Optional[Node]]]`. */
const DEPTH = 6;

const under = (name: string): string =>
  Array.from({ length: DEPTH }, (_, i) => ['TypeDef', ...Array<string>(i).fill('*'), name].join('/')).join(' ');

/**
 * The names in a Python annotation (`nums: list[int]`, `-> Optional[Node]`,
 * `x: tree.Node`) tagged as types. Lezer's Python grammar marks an
 * annotation (`TypeDef`) but tags the names in it as plain variables, so
 * without this only a class's own name takes the type colour.
 */
export const pythonTypeTags = styleTags({
  [under('VariableName')]: t.typeName,
  [under('PropertyName')]: t.typeName,
});
