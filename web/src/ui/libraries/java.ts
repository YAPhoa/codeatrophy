import { entries, type LibraryName, type LibraryTable } from './table';

/*
 * Java 13 (OpenJDK). Imports are fully qualified class names; java.lang
 * needs none. Every class is offered on its own, after its package
 * (`java.util.`) and, for the ones with static members, with those after it.
 */

const KEYWORDS = `
  abstract assert boolean break byte case catch char class continue default do double else enum extends final
  finally float for if implements import instanceof int interface long native new null package private
  protected public return short static super switch synchronized this throw throws transient try var void
  volatile while true false
`;

/** Classes by package, `java.lang` first. */
const PACKAGES: Record<string, string> = {
  'java.lang': `
    c String
    c StringBuilder
    c Integer
    c Long
    c Double
    c Boolean
    c Character
    c Math
    c System
    c Object
  `,
  'java.util': `
    c ArrayList ArrayList<E>
    c LinkedList LinkedList<E>
    c HashMap HashMap<K, V>
    c TreeMap TreeMap<K, V>
    c LinkedHashMap LinkedHashMap<K, V>
    c HashSet HashSet<E>
    c TreeSet TreeSet<E>
    c LinkedHashSet LinkedHashSet<E>
    c ArrayDeque ArrayDeque<E>
    c PriorityQueue PriorityQueue<E>
    c Stack Stack<E>
    i List List<E>
    i Map Map<K, V>
    i Set Set<E>
    i Deque Deque<E>
    i Queue Queue<E>
    i Iterator Iterator<E>
    i Comparator Comparator<T>
    c Arrays
    c Collections
    c Objects
    c Optional Optional<T>
    c Scanner
    c StringTokenizer
    c Random
    c BitSet
  `,
  'java.util.stream': `
    c Collectors
    i IntStream
    i LongStream
    i Stream Stream<T>
  `,
  'java.io': `
    c BufferedReader
    c InputStreamReader
    c PrintWriter
    c BufferedWriter
    c OutputStreamWriter
    c StreamTokenizer
    c IOException
  `,
  'java.math': `
    c BigInteger
    c BigDecimal
  `,
};

/** Static members by class. */
const STATICS: Record<string, string> = {
  Math: `
    f abs (a)
    f max (a, b)
    f min (a, b)
    f pow (a, b)
    f sqrt (a)
    f cbrt (a)
    f floor (a)
    f ceil (a)
    f round (a)
    f floorDiv (x, y)
    f floorMod (x, y)
    f log (a)
    f log10 (a)
    f exp (a)
    f hypot (x, y)
    f signum (d)
    f random ()
    f addExact (x, y)
    f multiplyExact (x, y)
    f toIntExact (value)
    k PI double
    k E double
  `,
  Arrays: `
    f sort (a)
    f fill (a, val)
    f asList (a...)
    f stream (array)
    f toString (a)
    f deepToString (a)
    f copyOf (original, newLength)
    f copyOfRange (original, from, to)
    f binarySearch (a, key)
    f equals (a, b)
    f setAll (array, generator)
  `,
  Collections: `
    f sort (list)
    f reverse (list)
    f max (coll)
    f min (coll)
    f swap (list, i, j)
    f shuffle (list)
    f reverseOrder ()
    f frequency (c, o)
    f nCopies (n, o)
    f addAll (c, elements...)
    f emptyList ()
    f singletonList (o)
    f unmodifiableList (list)
  `,
  Integer: `
    f parseInt (s)
    f valueOf (i)
    f toString (i)
    f toBinaryString (i)
    f toHexString (i)
    f bitCount (i)
    f compare (x, y)
    f max (a, b)
    f min (a, b)
    f sum (a, b)
    f highestOneBit (i)
    f numberOfTrailingZeros (i)
    f numberOfLeadingZeros (i)
    k MAX_VALUE int
    k MIN_VALUE int
  `,
  Long: `
    f parseLong (s)
    f valueOf (l)
    f toString (l)
    f toBinaryString (l)
    f bitCount (l)
    f compare (x, y)
    f max (a, b)
    f min (a, b)
    f numberOfTrailingZeros (l)
    k MAX_VALUE long
    k MIN_VALUE long
  `,
  Double: `
    f parseDouble (s)
    f compare (a, b)
    f isNaN (v)
    k MAX_VALUE double
    k MIN_VALUE double
    k POSITIVE_INFINITY double
    k NEGATIVE_INFINITY double
  `,
  Boolean: 'f parseBoolean (s)',
  Character: `
    f isDigit (ch)
    f isLetter (ch)
    f isLetterOrDigit (ch)
    f isAlphabetic (ch)
    f isUpperCase (ch)
    f isLowerCase (ch)
    f isWhitespace (ch)
    f toUpperCase (ch)
    f toLowerCase (ch)
    f getNumericValue (ch)
  `,
  String: `
    f valueOf (x)
    f join (delimiter, elements)
    f format (format, args...)
  `,
  System: `
    v in InputStream
    v out PrintStream
    v err PrintStream
    f currentTimeMillis ()
    f nanoTime ()
    f exit (status)
    f arraycopy (src, srcPos, dest, destPos, length)
    f lineSeparator ()
  `,
  List: 'f of (elements...)',
  Set: 'f of (elements...)',
  Map: `
    f of (k1, v1, ...)
    f entry (k, v)
  `,
  Objects: `
    f equals (a, b)
    f hash (values...)
    f requireNonNull (obj)
  `,
  Comparator: `
    f comparingInt (keyExtractor)
    f comparingLong (keyExtractor)
    f comparing (keyExtractor)
    f naturalOrder ()
    f reverseOrder ()
  `,
  IntStream: `
    f range (start, end)
    f rangeClosed (start, end)
    f of (values...)
  `,
  Stream: 'f of (values...)',
  Collectors: `
    f toList ()
    f toSet ()
    f toMap (keyMapper, valueMapper)
    f joining ([delimiter])
    f groupingBy (classifier)
    f counting ()
    f summingInt (mapper)
  `,
  BigInteger: `
    f valueOf (val)
    k ZERO BigInteger
    k ONE BigInteger
    k TWO BigInteger
    k TEN BigInteger
  `,
};

const names: LibraryName[] = [];
const members: Record<string, LibraryName[]> = {
  'System.out.': entries(`
    f println (x)
    f print (x)
    f printf (format, args...)
    f flush ()
  `),
};
const classImport: Record<string, string | undefined> = {};
for (const [pkg, lines] of Object.entries(PACKAGES)) {
  const imp = pkg === 'java.lang' ? undefined : (label: string) => `${pkg}.${label}`;
  const list = entries(lines, imp).map((e) => ({ ...e, detail: e.detail ? `${e.detail} · ${pkg}` : pkg }));
  for (const e of list) classImport[e.label] = e.import;
  names.push(...list);
  // Written out in full, a class needs no import.
  members[`${pkg}.`] = list.map(({ import: _, ...e }) => e);
}
for (const [cls, lines] of Object.entries(STATICS)) members[`${cls}.`] = entries(lines, classImport[cls]);

const table: LibraryTable = {
  keywords: KEYWORDS.trim().split(/\s+/),
  names: [...names, ...entries('f main (String[] args)')],
  members,
  methods: entries(`
    m length ()
    m charAt (index)
    m substring (begin[, end])
    m split (regex)
    m trim ()
    m equals (o)
    m compareTo (o)
    m toCharArray ()
    m isEmpty ()
    m contains (o)
    m indexOf (o)
    m append (x)
    m toString ()
    m size ()
    m get (index)
    m set (index, e)
    m put (key, value)
    m add (e)
    m remove (o)
    m containsKey (key)
    m getOrDefault (key, default)
    m putIfAbsent (key, value)
    m merge (key, value, fn)
    m computeIfAbsent (key, fn)
    m keySet ()
    m values ()
    m entrySet ()
    m getKey ()
    m getValue ()
    m offer (e)
    m poll ()
    m peek ()
    m push (e)
    m pop ()
    m addFirst (e)
    m addLast (e)
    m pollFirst ()
    m pollLast ()
    m peekFirst ()
    m peekLast ()
    m firstKey ()
    m lastKey ()
    m floorKey (key)
    m ceilingKey (key)
    m first ()
    m last ()
    m floor (e)
    m ceiling (e)
    m clear ()
    m stream ()
    m map (fn)
    m filter (pred)
    m collect (collector)
    m sum ()
    m sorted ()
    m forEach (action)
    m readLine ()
    m nextInt ()
    m nextLong ()
    m nextLine ()
    m next ()
    m hasNext ()
    m nextToken ()
    m hasMoreTokens ()
    m println (x)
    m flush ()
    m close ()
  `),
};

export default table;
