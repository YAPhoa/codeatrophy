import { entries, words, type LibraryName, type LibraryTable } from './table';

/*
 * Kotlin 1.3.70. Imports are fully qualified names. The standard library's
 * collection builders and I/O need none; kotlin.math and the java.util
 * classes do. Kotlin's own ArrayDeque is still experimental in 1.3.70, so
 * java.util's is offered. The legacy mode brings the keywords.
 */

const NAMES = `
  f listOf (elements...) List<T>
  f mutableListOf (elements...) MutableList<T>
  f arrayListOf (elements...) ArrayList<T>
  f setOf (elements...) Set<T>
  f mutableSetOf (elements...) MutableSet<T>
  f hashSetOf (elements...) HashSet<T>
  f sortedSetOf (elements...) TreeSet<T>
  f mapOf (pairs...) Map<K, V>
  f mutableMapOf (pairs...) MutableMap<K, V>
  f hashMapOf (pairs...) HashMap<K, V>
  f sortedMapOf (pairs...) SortedMap<K, V>
  f arrayOf (elements...) Array<T>
  f intArrayOf (elements...) IntArray
  f longArrayOf (elements...) LongArray
  f emptyList () List<T>
  f emptySet () Set<T>
  f emptyMap () Map<K, V>
  f readLine () String?
  f println (message)
  f print (message)
  f maxOf (a, b)
  f minOf (a, b)
  f repeat (times, action)
  f require (value)
  f check (value)
  f error (message)
  f compareBy (selector)
  f compareByDescending (selector)
  f buildString (action) String
  c IntArray (size)
  c LongArray (size)
  c BooleanArray (size)
  c CharArray (size)
  c DoubleArray (size)
  c Array Array<T>
  c Pair Pair<A, B>
  c Triple Triple<A, B, C>
  c StringBuilder
`;

const MATH = `
  f abs (x)
  f max (a, b)
  f min (a, b)
  f sqrt (x) Double
  f floor (x) Double
  f ceil (x) Double
  f round (x) Double
  f ln (x) Double
  f log2 (x) Double
  f log10 (x) Double
  f exp (x) Double
  f hypot (x, y) Double
  f sign (x)
  k PI Double
  k E Double
`;

const JAVA: Record<string, string> = {
  'java.util': `
    c PriorityQueue PriorityQueue<E>
    c ArrayDeque ArrayDeque<E>
    c TreeMap TreeMap<K, V>
    c TreeSet TreeSet<E>
    c LinkedList LinkedList<E>
    c Stack Stack<E>
    c BitSet
    c Scanner
    c StringTokenizer
  `,
  'java.io': `
    c BufferedReader
    c InputStreamReader
    c PrintWriter
  `,
};

const names: LibraryName[] = [
  ...entries(NAMES),
  ...entries(MATH, (label) => `kotlin.math.${label}`).map((e) => ({ ...e, detail: e.detail ? `${e.detail} · kotlin.math` : 'kotlin.math' })),
];
for (const [pkg, lines] of Object.entries(JAVA)) {
  names.push(...entries(lines, (label) => `${pkg}.${label}`).map((e) => ({ ...e, detail: e.detail ? `${e.detail} · ${pkg}` : pkg })));
}

const limits = (type: string) => entries(`k MAX_VALUE ${type}\nk MIN_VALUE ${type}`);

const table: LibraryTable = {
  names,
  members: {
    'Int.': limits('Int'),
    'Long.': limits('Long'),
    'Math.': entries(`
      f abs (a)
      f max (a, b)
      f min (a, b)
      f pow (a, b) Double
      f sqrt (a) Double
      f floorDiv (x, y)
      f floorMod (x, y)
    `),
    // `in` is a keyword in Kotlin, so the field has to be quoted.
    'System.': [{ label: 'in', type: 'property', detail: 'InputStream', apply: '`in`' }, ...entries('p out PrintStream\nf currentTimeMillis () Long\nf nanoTime () Long\nf exit (status)')],
    'kotlin.math.': entries(MATH),
  },
  methods: words(
    'method',
    `add addAll remove removeAt contains containsKey get getOrDefault getOrPut put size isEmpty isNotEmpty first
     last firstOrNull lastOrNull map filter forEach forEachIndexed mapIndexed withIndex indices sum sumBy max min
     maxBy minBy sorted sortedBy sortedDescending sortBy sortDescending sort reversed joinToString split trim toInt
     toLong toDouble toString toCharArray toList toMutableList toSet toIntArray count any all none groupBy
     distinct zip chunked windowed take drop let also apply run poll peek offer substring startsWith endsWith
     lines padStart repeat fold reduce flatMap bufferedReader readLine`,
  ),
};

export default table;
