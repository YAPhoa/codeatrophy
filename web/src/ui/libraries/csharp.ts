import { entries, type LibraryName, type LibraryTable } from './table';

/*
 * C# on Mono 6.6. Imports are namespaces, brought in with `using`. The
 * legacy mode brings the keywords and the built-in type names.
 */

const NAMESPACES: Record<string, string> = {
  System: `
    c Console
    c Math
    c Convert
    c Array
    c Tuple
  `,
  'System.Collections.Generic': `
    c List List<T>
    c Dictionary Dictionary<TKey, TValue>
    c HashSet HashSet<T>
    c Queue Queue<T>
    c Stack Stack<T>
    c SortedDictionary SortedDictionary<TKey, TValue>
    c SortedSet SortedSet<T>
    c SortedList SortedList<TKey, TValue>
    c LinkedList LinkedList<T>
    c KeyValuePair KeyValuePair<TKey, TValue>
    c Comparer Comparer<T>
  `,
  'System.Text': 'c StringBuilder',
  'System.Linq': 'c Enumerable',
};

const STATICS: Record<string, [string | undefined, string]> = {
  Console: [
    'System',
    `
    f WriteLine (value)
    f Write (value)
    f ReadLine () string
    f Read () int
    p In TextReader
    p Out TextWriter
    p Error TextWriter
    f SetOut (writer)
    f OpenStandardInput () Stream
    f OpenStandardOutput () Stream
  `,
  ],
  Math: [
    'System',
    `
    f Abs (value)
    f Max (a, b)
    f Min (a, b)
    f Pow (x, y) double
    f Sqrt (d) double
    f Floor (d)
    f Ceiling (d)
    f Round (d)
    f Truncate (d)
    f Log (d) double
    f Log10 (d) double
    f Exp (d) double
    f Sign (value) int
    f BigMul (a, b) long
    k PI double
    k E double
  `,
  ],
  Convert: [
    'System',
    `
    f ToInt32 (value) int
    f ToInt64 (value) long
    f ToString (value[, toBase]) string
    f ToChar (value) char
    f ToDouble (value) double
    f ToBoolean (value) bool
  `,
  ],
  Array: [
    'System',
    `
    f Sort (array)
    f Reverse (array)
    f IndexOf (array, value) int
    f BinarySearch (array, value) int
    f Copy (source, dest, length)
    f Resize (ref array, newSize)
    f Fill (array, value)
    f Exists (array, match) bool
    f Find (array, match)
    f ConvertAll (array, converter)
  `,
  ],
  Tuple: ['System', 'f Create (items...)'],
  Enumerable: [
    'System.Linq',
    `
    f Range (start, count)
    f Repeat (element, count)
  `,
  ],
};

/** Static members of the built-in types, which need no using. */
const BUILT_IN: Record<string, string> = {
  int: `
    f Parse (s) int
    f TryParse (s, out result) bool
    k MaxValue int
    k MinValue int
  `,
  long: `
    f Parse (s) long
    f TryParse (s, out result) bool
    k MaxValue long
    k MinValue long
  `,
  double: `
    f Parse (s) double
    f IsNaN (d) bool
    k MaxValue double
    k PositiveInfinity double
    k NegativeInfinity double
    k Epsilon double
    k NaN double
  `,
  char: `
    f IsDigit (c) bool
    f IsLetter (c) bool
    f IsLetterOrDigit (c) bool
    f IsUpper (c) bool
    f IsLower (c) bool
    f IsWhiteSpace (c) bool
    f ToUpper (c) char
    f ToLower (c) char
    f GetNumericValue (c) double
  `,
  string: `
    f Join (separator, values) string
    f Format (format, args...) string
    f Concat (values...) string
    f IsNullOrEmpty (value) bool
    f IsNullOrWhiteSpace (value) bool
    k Empty string
  `,
};

const names: LibraryName[] = [];
for (const [ns, lines] of Object.entries(NAMESPACES)) {
  names.push(...entries(lines, ns).map((e) => ({ ...e, detail: e.detail ? `${e.detail} · ${ns}` : ns })));
}
const members: Record<string, LibraryName[]> = {};
for (const [cls, [ns, lines]] of Object.entries(STATICS)) members[`${cls}.`] = entries(lines, ns);
for (const [type, lines] of Object.entries(BUILT_IN)) members[`${type}.`] = entries(lines);
for (const [alias, type] of [['Int32', 'int'], ['Int64', 'long'], ['String', 'string'], ['Char', 'char']]) members[`${alias}.`] = members[`${type}.`] ?? [];

const table: LibraryTable = {
  names,
  members,
  methods: [
    ...entries(`
      m Add (item)
      m AddRange (items)
      m Remove (item)
      m RemoveAt (index)
      m Insert (index, item)
      m Contains (item) bool
      m ContainsKey (key) bool
      m TryGetValue (key, out value) bool
      m Clear ()
      p Count int
      p Length int
      p Keys
      p Values
      m Sort ()
      m Reverse ()
      m IndexOf (item) int
      m Enqueue (item)
      m Dequeue ()
      m Push (item)
      m Pop ()
      m Peek ()
      m Split (separator) string[]
      m Trim () string
      m Substring (start[, length]) string
      m Replace (old, new) string
      m StartsWith (value) bool
      m EndsWith (value) bool
      m ToUpper () string
      m ToLower () string
      m ToCharArray () char[]
      m ToString () string
      m Append (value)
      m CompareTo (other) int
      m Equals (other) bool
    `),
    // LINQ, which needs its using.
    ...entries(
      `
      m Select (selector)
      m Where (predicate)
      m OrderBy (keySelector)
      m OrderByDescending (keySelector)
      m ThenBy (keySelector)
      m Sum ()
      m Max ()
      m Min ()
      m Any ([predicate]) bool
      m All (predicate) bool
      m First ()
      m FirstOrDefault ()
      m Last ()
      m Distinct ()
      m GroupBy (keySelector)
      m Aggregate (func)
      m Skip (count)
      m Take (count)
      m ToList ()
      m ToArray ()
      m ToDictionary (keySelector)
    `,
      'System.Linq',
    ),
  ],
};

export default table;
