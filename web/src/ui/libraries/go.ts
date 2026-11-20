import { entries, type LibraryName, type LibraryTable } from './table';

/*
 * Go 1.13: no generics, no slices or maps packages, no math.MaxInt. Imports
 * are package paths. The Go package brings the keywords; the builtins are
 * here.
 */

/** Exported names by package path. */
const PACKAGES: Record<string, string> = {
  fmt: `
    f Println (a ...interface{})
    f Printf (format string, a ...interface{})
    f Print (a ...interface{})
    f Sprintf (format string, a ...interface{}) string
    f Sprint (a ...interface{}) string
    f Sprintln (a ...interface{}) string
    f Scan (a ...interface{})
    f Scanln (a ...interface{})
    f Scanf (format string, a ...interface{})
    f Sscan (str string, a ...interface{})
    f Sscanf (str string, format string, a ...interface{})
    f Fscan (r io.Reader, a ...interface{})
    f Fscanln (r io.Reader, a ...interface{})
    f Fscanf (r io.Reader, format string, a ...interface{})
    f Fprintln (w io.Writer, a ...interface{})
    f Fprintf (w io.Writer, format string, a ...interface{})
    f Fprint (w io.Writer, a ...interface{})
    f Errorf (format string, a ...interface{}) error
  `,
  sort: `
    f Ints (a []int)
    f Strings (a []string)
    f Float64s (a []float64)
    f Slice (slice interface{}, less func(i, j int) bool)
    f SliceStable (slice interface{}, less func(i, j int) bool)
    f Sort (data sort.Interface)
    f Stable (data sort.Interface)
    f Search (n int, f func(int) bool) int
    f SearchInts (a []int, x int) int
    f SearchStrings (a []string, x string) int
    f Reverse (data sort.Interface) sort.Interface
    f IntsAreSorted (a []int) bool
    f SliceIsSorted (slice interface{}, less func(i, j int) bool) bool
    t IntSlice []int
    t StringSlice []string
    i Interface
  `,
  strings: `
    f Split (s, sep string) []string
    f SplitN (s, sep string, n int) []string
    f Join (elems []string, sep string) string
    f Fields (s string) []string
    f Contains (s, substr string) bool
    f ContainsRune (s string, r rune) bool
    f HasPrefix (s, prefix string) bool
    f HasSuffix (s, suffix string) bool
    f Index (s, substr string) int
    f LastIndex (s, substr string) int
    f IndexByte (s string, c byte) int
    f Repeat (s string, count int) string
    f Replace (s, old, new string, n int) string
    f ReplaceAll (s, old, new string) string
    f ToUpper (s string) string
    f ToLower (s string) string
    f TrimSpace (s string) string
    f Trim (s, cutset string) string
    f TrimLeft (s, cutset string) string
    f TrimRight (s, cutset string) string
    f TrimPrefix (s, prefix string) string
    f TrimSuffix (s, suffix string) string
    f Count (s, substr string) int
    f EqualFold (s, t string) bool
    f Map (mapping func(rune) rune, s string) string
    f NewReader (s string) *strings.Reader
    t Builder struct
  `,
  strconv: `
    f Atoi (s string) (int, error)
    f Itoa (i int) string
    f ParseInt (s string, base int, bitSize int) (int64, error)
    f ParseFloat (s string, bitSize int) (float64, error)
    f ParseBool (str string) (bool, error)
    f FormatInt (i int64, base int) string
    f FormatFloat (f float64, fmt byte, prec, bitSize int) string
    f Quote (s string) string
    f AppendInt (dst []byte, i int64, base int) []byte
  `,
  bufio: `
    f NewReader (rd io.Reader) *bufio.Reader
    f NewReaderSize (rd io.Reader, size int) *bufio.Reader
    f NewWriter (w io.Writer) *bufio.Writer
    f NewWriterSize (w io.Writer, size int) *bufio.Writer
    f NewScanner (r io.Reader) *bufio.Scanner
    f ScanWords (data []byte, atEOF bool) (int, []byte, error)
    f ScanLines (data []byte, atEOF bool) (int, []byte, error)
    f ScanRunes (data []byte, atEOF bool) (int, []byte, error)
    t Reader struct
    t Writer struct
    t Scanner struct
    k MaxScanTokenSize int
  `,
  os: `
    v Stdin *os.File
    v Stdout *os.File
    v Stderr *os.File
    v Args []string
    f Exit (code int)
  `,
  io: `
    v EOF error
    i Reader
    i Writer
  `,
  'io/ioutil': 'f ReadAll (r io.Reader) ([]byte, error)',
  math: `
    k MaxInt64 int64
    k MinInt64 int64
    k MaxInt32 int32
    k MinInt32 int32
    k MaxUint32 uint32
    k MaxFloat64 float64
    k Pi float64
    k E float64
    f Inf (sign int) float64
    f NaN () float64
    f IsInf (f float64, sign int) bool
    f IsNaN (f float64) bool
    f Sqrt (x float64) float64
    f Cbrt (x float64) float64
    f Abs (x float64) float64
    f Max (x, y float64) float64
    f Min (x, y float64) float64
    f Pow (x, y float64) float64
    f Floor (x float64) float64
    f Ceil (x float64) float64
    f Round (x float64) float64
    f Trunc (x float64) float64
    f Mod (x, y float64) float64
    f Log (x float64) float64
    f Log2 (x float64) float64
    f Log10 (x float64) float64
    f Exp (x float64) float64
    f Hypot (p, q float64) float64
  `,
  'math/bits': `
    f OnesCount (x uint) int
    f OnesCount64 (x uint64) int
    f LeadingZeros (x uint) int
    f LeadingZeros64 (x uint64) int
    f TrailingZeros (x uint) int
    f TrailingZeros64 (x uint64) int
    f Len (x uint) int
    f Len64 (x uint64) int
    f Reverse (x uint) uint
  `,
  'math/rand': `
    f Intn (n int) int
    f Int () int
    f Int63 () int64
    f Float64 () float64
    f Perm (n int) []int
    f Shuffle (n int, swap func(i, j int))
    f Seed (seed int64)
  `,
  'math/big': `
    f NewInt (x int64) *big.Int
    t Int struct
  `,
  'container/heap': `
    f Init (h heap.Interface)
    f Push (h heap.Interface, x interface{})
    f Pop (h heap.Interface) interface{}
    f Fix (h heap.Interface, i int)
    f Remove (h heap.Interface, i int) interface{}
    i Interface
  `,
  'container/list': `
    f New () *list.List
    t List struct
    t Element struct
  `,
  unicode: `
    f IsDigit (r rune) bool
    f IsLetter (r rune) bool
    f IsSpace (r rune) bool
    f IsUpper (r rune) bool
    f IsLower (r rune) bool
    f ToUpper (r rune) rune
    f ToLower (r rune) rune
  `,
};

const BUILTINS = `
  f append (slice []T, elems ...T) []T
  f len (v) int
  f cap (v) int
  f make (t T, size ...int) T
  f new (T) *T
  f copy (dst, src []T) int
  f delete (m map[K]V, key K)
  f panic (v interface{})
  f recover () interface{}
  f close (c chan T)
  t int
  t int64
  t int32
  t uint
  t uint64
  t float64
  t string
  t bool
  t byte
  t rune
  t error
`;

const names: LibraryName[] = entries(BUILTINS);
const members: Record<string, LibraryName[]> = {};
for (const [path, lines] of Object.entries(PACKAGES)) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  names.push({ label: name, type: 'namespace', detail: path === name ? 'package' : path, import: path });
  members[`${name}.`] = entries(lines, path);
}

const table: LibraryTable = {
  names,
  members,
  // Slices, maps and strings have no methods; these are the reader's, the writer's and the builder's.
  methods: entries(`
    m Scan () bool
    m Text () string
    m Split (split bufio.SplitFunc)
    m Buffer (buf []byte, max int)
    m ReadString (delim byte) (string, error)
    m ReadRune () (rune, int, error)
    m WriteString (s string) (int, error)
    m WriteByte (c byte) error
    m WriteRune (r rune) (int, error)
    m Flush () error
    m String () string
    m Len () int
  `),
};

export default table;
