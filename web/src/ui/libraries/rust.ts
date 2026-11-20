import { entries, words, type LibraryName, type LibraryTable } from './table';

/*
 * Rust 1.40, 2015 edition (the judge's rustc runs without --edition): no
 * i32::MAX (std::i32::MAX instead), no inherent char::from_digit. Imports
 * are full paths, brought in with `use`. A path written out in full needs
 * none, so the members of std's modules carry no import; those of a type
 * (`HashMap::`) carry the type's.
 */

const KEYWORDS = `
  as break const continue crate dyn else enum extern false fn for if impl in let loop match mod
  move mut pub ref return self Self static struct super trait true type unsafe use where while
  bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize
`;

const MODULES: Record<string, string> = {
  std: `
    n collections
    n cmp
    n io
    n mem
    n iter
    n fmt
    n process
    n convert
    n char
    n i32
    n i64
    n u32
    n u64
    n usize
    n f64
  `,
  'std::collections': `
    c* HashMap HashMap<K, V>
    c* HashSet HashSet<T>
    c* BTreeMap BTreeMap<K, V>
    c* BTreeSet BTreeSet<T>
    c* VecDeque VecDeque<T>
    c* BinaryHeap BinaryHeap<T>
    c LinkedList LinkedList<T>
  `,
  'std::cmp': `
    e* Ordering
    c* Reverse Reverse<T>
    f* max (a, b)
    f* min (a, b)
  `,
  'std::io': `
    f stdin () -> Stdin
    f stdout () -> Stdout
    i* Read
    i* Write
    i* BufRead
    c BufReader BufReader<R>
    c* BufWriter BufWriter<W>
    n prelude
  `,
  'std::mem': `
    f* swap (x, y)
    f replace (dest, src)
    f take (dest)
  `,
  'std::iter': `
    f once (value)
    f repeat (elt)
    f empty ()
    f successors (first, succ)
    f from_fn (f)
  `,
  'std::process': 'f exit (code)',
  'std::convert': `
    i TryFrom
    i TryInto
  `,
  'std::char': `
    f from_digit (num, radix) -> Option<char>
    f from_u32 (i) -> Option<char>
  `,
  'std::fmt': `
    i Display
    i Debug
    i Write
    c Formatter
  `,
  'std::f64': `
    k MAX f64
    k MIN f64
    k INFINITY f64
    k NEG_INFINITY f64
    k EPSILON f64
    k NAN f64
    n consts
  `,
  'std::f64::consts': `
    k PI f64
    k E f64
    k SQRT_2 f64
    k LN_2 f64
  `,
};

const members: Record<string, LibraryName[]> = {};
const names: LibraryName[] = [
  ...words('class', 'String Vec Option Result Box'),
  ...words('constant', 'Some None Ok Err'),
  ...words('function', 'println print eprintln eprint format vec panic assert assert_eq assert_ne unreachable write writeln'),
  { label: 'std', type: 'namespace' },
  { label: 'io', type: 'namespace', detail: 'std::io', import: 'std::io' },
];

for (const [path, lines] of Object.entries(MODULES)) {
  const list = entries(lines);
  members[`${path}::`] = list.map(({ star: _, ...e }) => e);
  for (const { star, ...e } of list) if (star) names.push({ ...e, detail: path, import: `${path}::${e.label}` });
}
for (const int of ['i32', 'i64', 'u32', 'u64', 'usize']) {
  members[`std::${int}::`] = entries(`k MAX ${int}\nk MIN ${int}`);
  members[`${int}::`] = entries(`f max_value () -> ${int}\nf min_value () -> ${int}\nf from_str_radix (src, radix)`);
}

/** Associated functions of a type, with the type's import. */
function associated(type: string, imp: string | undefined, lines: string) {
  members[`${type}::`] = entries(lines, imp);
}
for (const type of ['HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'VecDeque', 'BinaryHeap']) {
  associated(type, `std::collections::${type}`, type === 'BTreeMap' || type === 'BTreeSet' ? 'f new ()' : 'f new ()\nf with_capacity (capacity)');
}
members['BinaryHeap::'] = [...(members['BinaryHeap::'] ?? []), ...entries('f from (vec)', 'std::collections::BinaryHeap')];
associated('Vec', undefined, 'f new ()\nf with_capacity (capacity)');
associated('String', undefined, 'f new ()\nf with_capacity (capacity)\nf from (s)\nf from_utf8 (vec)');
associated('Ordering', 'std::cmp::Ordering', 'k Less\nk Equal\nk Greater');

const table: LibraryTable = {
  keywords: KEYWORDS.trim().split(/\s+/),
  names,
  members,
  methods: words(
    'method',
    `iter into_iter iter_mut map filter filter_map flat_map collect sum product fold enumerate zip rev chain
     take skip step_by count any all position max_by_key min_by_key cloned copied peekable windows chunks
     unwrap unwrap_or expect parse trim split split_whitespace chars bytes lines len push pop insert remove
     contains contains_key get get_mut entry or_insert or_default sort sort_unstable sort_by sort_by_key dedup
     reverse binary_search min max abs pow rem_euclid cmp clone to_string to_owned as_str as_bytes is_empty
     push_str push_back push_front pop_back pop_front peek extend retain keys values join concat swap first last
     read_line read_to_string lock flush`,
  ),
};

export default table;
