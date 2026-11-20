import { entries, words, type LibraryName, type LibraryTable } from './table';

/*
 * C++ on GCC 9, which the judge runs without a -std flag: GNU C++14, so
 * nothing from C++17 or later (no gcd, optional, string_view, clamp). Imports
 * are header names; `bits/stdc++.h` stands for all of them. The names of
 * std are offered both after `std::` and on their own, for code that says
 * `using namespace std;`.
 */

const KEYWORDS = `
  alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype default
  delete do double dynamic_cast else enum explicit extern false float for friend goto if inline int long mutable
  namespace new noexcept nullptr operator override private protected public return short signed sizeof static
  static_cast struct switch template this throw true try typedef typename union unsigned using virtual void
  volatile while include define size_t int64_t uint64_t
`;

/** The names of std, by header. */
const STD: Record<string, string> = {
  iostream: `
    v cin istream
    v cout ostream
    v cerr ostream
    f endl manipulator
    f fixed manipulator
  `,
  string: `
    c string
    f to_string (value)
    f stoi (str)
    f stol (str)
    f stoll (str)
    f stoull (str)
    f stod (str)
    f getline (in, str)
  `,
  vector: 'c vector vector<T>',
  array: 'c array array<T, N>',
  deque: 'c deque deque<T>',
  list: 'c list list<T>',
  map: `
    c map map<K, V>
    c multimap multimap<K, V>
  `,
  unordered_map: 'c unordered_map unordered_map<K, V>',
  set: `
    c set set<T>
    c multiset multiset<T>
  `,
  unordered_set: 'c unordered_set unordered_set<T>',
  queue: `
    c queue queue<T>
    c priority_queue priority_queue<T>
  `,
  stack: 'c stack stack<T>',
  bitset: 'c bitset bitset<N>',
  utility: `
    c pair pair<A, B>
    f make_pair (a, b)
    f swap (a, b)
    f move (x)
  `,
  tuple: `
    c tuple tuple<T...>
    f make_tuple (args...)
    f tie (args...)
    f get get<I>(t)
  `,
  algorithm: `
    f sort (first, last[, comp])
    f stable_sort (first, last[, comp])
    f partial_sort (first, middle, last)
    f nth_element (first, nth, last)
    f reverse (first, last)
    f unique (first, last)
    f lower_bound (first, last, value)
    f upper_bound (first, last, value)
    f equal_range (first, last, value)
    f binary_search (first, last, value)
    f min (a, b)
    f max (a, b)
    f min_element (first, last)
    f max_element (first, last)
    f find (first, last, value)
    f find_if (first, last, pred)
    f count (first, last, value)
    f count_if (first, last, pred)
    f fill (first, last, value)
    f copy (first, last, out)
    f next_permutation (first, last)
    f prev_permutation (first, last)
    f rotate (first, middle, last)
    f all_of (first, last, pred)
    f any_of (first, last, pred)
    f none_of (first, last, pred)
    f remove (first, last, value)
    f remove_if (first, last, pred)
    f transform (first, last, out, op)
    f merge (first1, last1, first2, last2, out)
    f is_sorted (first, last)
  `,
  numeric: `
    f accumulate (first, last, init)
    f iota (first, last, value)
    f partial_sum (first, last, out)
    f adjacent_difference (first, last, out)
    f inner_product (first1, last1, first2, init)
  `,
  functional: `
    c function function<R(Args...)>
    c greater greater<T>
    c less less<T>
    c hash hash<T>
  `,
  cmath: `
    f abs (x)
    f sqrt (x)
    f pow (x, y)
    f floor (x)
    f ceil (x)
    f round (x)
    f log (x)
    f log2 (x)
    f log10 (x)
    f exp (x)
    f fabs (x)
    f hypot (x, y)
    f atan2 (y, x)
  `,
  limits: 'c numeric_limits numeric_limits<T>',
  iomanip: `
    f setprecision (n)
    f setw (n)
  `,
  sstream: `
    c stringstream
    c istringstream
    c ostringstream
  `,
  memory: `
    c unique_ptr unique_ptr<T>
    c shared_ptr shared_ptr<T>
    f make_unique make_unique<T>(args...)
    f make_shared make_shared<T>(args...)
  `,
  cstring: `
    f memset (dest, ch, count)
    f memcpy (dest, src, count)
    f strlen (str)
    f strcmp (a, b)
  `,
  cstdio: `
    f printf (format, ...)
    f scanf (format, ...)
    f puts (str)
    f getchar ()
    f putchar (ch)
  `,
  cstdlib: 'f exit (status)',
  random: 'c mt19937 (seed)',
};

/** Names that are not in std. */
const GLOBAL: Record<string, string> = {
  climits: `
    k INT_MAX int
    k INT_MIN int
    k LLONG_MAX long long
    k LLONG_MIN long long
    k UINT_MAX unsigned
  `,
  cassert: 'f assert (condition)',
  algorithm: 'f __gcd (a, b) GNU',
};

const std: LibraryName[] = [];
const names: LibraryName[] = [];
for (const [header, lines] of Object.entries(STD)) {
  for (const e of entries(lines, header)) {
    std.push(e);
    names.push(e);
  }
}
for (const [header, lines] of Object.entries(GLOBAL)) for (const e of entries(lines, header)) names.push(e);

const syncWithStdio = entries('f sync_with_stdio (sync)', 'iostream');

const table: LibraryTable = {
  keywords: KEYWORDS.trim().split(/\s+/),
  names: [...names, { label: 'std', type: 'namespace' }, { label: 'ios', type: 'class', import: 'iostream' }],
  members: {
    'std::': [...std, { label: 'ios', type: 'class', import: 'iostream' }, { label: 'ios_base', type: 'class', import: 'iostream' }],
    'ios::': syncWithStdio,
    'ios_base::': syncWithStdio,
    'std::ios::': syncWithStdio,
    'std::ios_base::': syncWithStdio,
  },
  methods: [
    ...words(
      'method',
      `push_back emplace_back pop_back push_front pop_front emplace push pop top front back begin end rbegin rend
       size empty clear insert erase find count resize reserve assign substr length at data c_str append
       lower_bound upper_bound swap`,
    ),
    ...words('property', 'first second'),
  ],
};

export default table;
