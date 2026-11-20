import { entries, words, type LibraryName, type LibraryTable } from './table';

/*
 * Python 3.8. Imports are `module` (import module) or `module:name` (from
 * module import name). A member marked `*` is offered on its own as well,
 * with a from-import.
 */

const MODULES: Record<string, string> = {
  heapq: `
    f* heappush (heap, item)
    f* heappop (heap)
    f* heapify (x)
    f heappushpop (heap, item)
    f heapreplace (heap, item)
    f nlargest (n, iterable, key=None)
    f nsmallest (n, iterable, key=None)
    f merge (*iterables, key=None)
  `,
  collections: `
    c* deque ([iterable[, maxlen]])
    c* Counter ([iterable])
    c* defaultdict (default_factory)
    c* OrderedDict ()
    f* namedtuple (typename, field_names)
    c ChainMap (*maps)
  `,
  itertools: `
    f* permutations (iterable, r=None)
    f* combinations (iterable, r)
    f* combinations_with_replacement (iterable, r)
    f* product (*iterables, repeat=1)
    f* accumulate (iterable[, func, *, initial])
    f* chain (*iterables)
    f* groupby (iterable, key=None)
    f count (start=0, step=1)
    f cycle (iterable)
    f repeat (object[, times])
    f islice (iterable, stop)
    f starmap (function, iterable)
    f takewhile (predicate, iterable)
    f dropwhile (predicate, iterable)
    f zip_longest (*iterables, fillvalue=None)
  `,
  bisect: `
    f* bisect_left (a, x, lo=0, hi=len(a))
    f* bisect_right (a, x, lo=0, hi=len(a))
    f bisect (a, x, lo=0, hi=len(a))
    f* insort (a, x, lo=0, hi=len(a))
    f insort_left (a, x)
    f insort_right (a, x)
  `,
  math: `
    k* inf float
    k pi float
    k e float
    k tau float
    k nan float
    f* gcd (a, b)
    f* isqrt (n)
    f sqrt (x)
    f floor (x)
    f ceil (x)
    f log (x[, base])
    f log2 (x)
    f log10 (x)
    f exp (x)
    f pow (x, y)
    f fabs (x)
    f factorial (n)
    f comb (n, k)
    f perm (n, k=None)
    f prod (iterable, *, start=1)
    f hypot (*coordinates)
    f dist (p, q)
    f isclose (a, b)
    f trunc (x)
    f fsum (iterable)
    f atan2 (y, x)
    f sin (x)
    f cos (x)
    f tan (x)
    f degrees (x)
    f radians (x)
    f isinf (x)
    f isnan (x)
  `,
  functools: `
    f* lru_cache (maxsize=128)
    f* reduce (function, iterable[, initial])
    f* cmp_to_key (func)
    f partial (func, *args, **keywords)
    f total_ordering (cls)
  `,
  sys: `
    v stdin TextIO
    v stdout TextIO
    v stderr TextIO
    f setrecursionlimit (limit)
    f getrecursionlimit ()
    k maxsize int
    f exit ([arg])
    v argv list
  `,
  string: `
    k* ascii_lowercase str
    k* ascii_uppercase str
    k ascii_letters str
    k digits str
    k hexdigits str
    k octdigits str
    k punctuation str
    k whitespace str
    k printable str
  `,
  operator: `
    f* itemgetter (*items)
    f attrgetter (*attrs)
    f methodcaller (name, *args)
    f add (a, b)
    f sub (a, b)
    f mul (a, b)
    f truediv (a, b)
    f floordiv (a, b)
    f mod (a, b)
    f neg (a)
    f and_ (a, b)
    f or_ (a, b)
    f xor (a, b)
  `,
  typing: `
    t* List List[T]
    t* Dict Dict[K, V]
    t* Set Set[T]
    t* Tuple Tuple[T, ...]
    t* Optional Optional[T]
    t Deque Deque[T]
    t DefaultDict DefaultDict[K, V]
    t Union Union[A, B]
    t Callable Callable[[A], R]
    t Any
  `,
};

const members: Record<string, LibraryName[]> = {
  'sys.stdin.': entries(`
    f readline ()
    f read ()
    f readlines ()
    v buffer BinaryIO
  `),
  'sys.stdout.': entries(`
    f write (s)
    f flush ()
  `),
};
const names: LibraryName[] = [];

for (const [module, lines] of Object.entries(MODULES)) {
  const list = entries(lines);
  members[`${module}.`] = list.map(({ star: _, ...e }) => ({ ...e, import: module }));
  names.push({ label: module, type: 'namespace', detail: 'module', import: module });
  for (const { star, ...e } of list) if (star) names.push({ ...e, detail: module, import: `${module}:${e.label}` });
}

const table: LibraryTable = {
  names,
  members,
  methods: words(
    'method',
    `append extend insert pop remove index count sort reverse copy clear keys values items get setdefault update
     add discard union intersection difference issubset issuperset split rsplit splitlines join strip lstrip rstrip
     replace find rfind startswith endswith upper lower isdigit isalpha isalnum isspace isupper islower zfill ljust
     rjust format encode appendleft popleft extendleft rotate most_common elements bit_length`,
  ),
};

export default table;
