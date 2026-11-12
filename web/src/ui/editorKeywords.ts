/*
 * Completion word lists for the languages whose CodeMirror packages highlight
 * and indent but offer no completions of their own (C, C++, Java, Rust).
 * Python, JavaScript, TypeScript and Go bring completions with their
 * packages, and the legacy modes (C#, Kotlin, Ruby) bring keyword lists.
 *
 * The lists hold the keywords plus the standard-library names that turn up
 * most in short programs reading stdin and writing stdout. They are a typing
 * aid, not a language reference.
 */

const split = (words: string): string[] => words.trim().split(/\s+/);

const C_KEYWORDS = split(`
  auto break case char const continue default do double else enum extern float for goto if inline int long
  register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
  NULL size_t int32_t int64_t uint32_t uint64_t bool true false
`);

const C_LIBRARY = split(`
  include define printf scanf puts putchar getchar fgets sscanf sprintf snprintf malloc calloc realloc free
  memset memcpy memmove memcmp strlen strcmp strncmp strcpy strncpy strcat strchr strstr strtol strtoll atoi qsort
  bsearch abs labs llabs sqrt pow floor ceil fabs stdin stdout stderr EOF INT_MAX INT_MIN LLONG_MAX LLONG_MIN
`);

const CPP_KEYWORDS = split(`
  alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype default
  delete do double dynamic_cast else enum explicit extern false float for friend goto if inline int long mutable
  namespace new noexcept nullptr operator override private protected public return short signed sizeof static
  static_cast struct switch template this throw true try typedef typename union unsigned using virtual void
  volatile while
`);

const CPP_LIBRARY = split(`
  include define std cin cout cerr endl getline string vector array deque list map unordered_map set
  unordered_set multiset multimap pair tuple stack queue priority_queue bitset optional function
  push_back emplace_back pop_back push_front pop_front push pop top front back begin end rbegin rend size empty
  clear insert erase find count resize reserve assign substr length first second make_pair make_tuple
  sort stable_sort reverse unique lower_bound upper_bound binary_search min max min_element max_element
  accumulate swap fill iota next_permutation prev_permutation abs gcd to_string stoi stol stoll stod
  numeric_limits size_t int64_t uint64_t ios_base sync_with_stdio greater less
  algorithm iostream numeric utility unordered_map unordered_set
`);

const JAVA_KEYWORDS = split(`
  abstract assert boolean break byte case catch char class continue default do double else enum extends final
  finally float for if implements import instanceof int interface long native new null package private
  protected public return short static super switch synchronized this throw throws transient try var void
  volatile while true false
`);

const JAVA_LIBRARY = split(`
  String StringBuilder Integer Long Double Boolean Character Math Object System Scanner BufferedReader
  InputStreamReader PrintWriter StringTokenizer IOException Arrays Collections List ArrayList LinkedList Map
  HashMap TreeMap LinkedHashMap Set HashSet TreeSet Deque ArrayDeque Queue PriorityQueue Iterator Comparator
  Optional main args println print printf readLine nextInt nextLong nextLine hasNext parseInt parseLong valueOf
  length charAt substring split trim equals compareTo append toString toCharArray isEmpty contains indexOf
  size get put add remove containsKey getOrDefault keySet values entrySet sort asList fill stream
  MAX_VALUE MIN_VALUE
`);

const RUST_KEYWORDS = split(`
  as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod
  move mut pub ref return self Self static struct super trait true type unsafe use where while
  bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize
`);

const RUST_LIBRARY = split(`
  String Vec VecDeque HashMap HashSet BTreeMap BTreeSet BinaryHeap Option Some None Result Ok Err Box
  println print eprintln format vec panic assert assert_eq unreachable
  std io stdin stdout Read Write BufRead read_line read_to_string lines lock collections cmp Ordering Reverse
  iter into_iter map filter collect sum fold enumerate zip rev unwrap unwrap_or expect parse trim
  split_whitespace chars len push pop insert remove contains get entry or_insert sort sort_unstable
  sort_by_key min max clone to_string to_owned as_str is_empty
`);

export interface KeywordList {
  keywords: readonly string[];
  library: readonly string[];
}

/** Word lists by language id, for the languages that need one. */
export const EDITOR_KEYWORDS: Readonly<Record<string, KeywordList>> = {
  c: { keywords: C_KEYWORDS, library: C_LIBRARY },
  cpp: { keywords: CPP_KEYWORDS, library: CPP_LIBRARY },
  java: { keywords: JAVA_KEYWORDS, library: JAVA_LIBRARY },
  rust: { keywords: RUST_KEYWORDS, library: RUST_LIBRARY },
};
