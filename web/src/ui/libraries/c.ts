import { entries, type LibraryName, type LibraryTable } from './table';

/* C on GCC 9 (GNU C11). Imports are header names. */

const KEYWORDS = `
  auto break case char const continue default do double else enum extern float for goto if inline int long
  register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
  include define NULL size_t
`;

const HEADERS: Record<string, string> = {
  'stdio.h': `
    f printf (format, ...)
    f scanf (format, ...)
    f puts (str)
    f putchar (ch)
    f getchar ()
    f fgets (str, count, stream)
    f sscanf (str, format, ...)
    f sprintf (buf, format, ...)
    f snprintf (buf, size, format, ...)
    f fprintf (stream, format, ...)
    v stdin FILE *
    v stdout FILE *
    v stderr FILE *
    k EOF int
  `,
  'stdlib.h': `
    f malloc (size)
    f calloc (count, size)
    f realloc (ptr, size)
    f free (ptr)
    f qsort (base, count, size, comp)
    f bsearch (key, base, count, size, comp)
    f abs (n)
    f labs (n)
    f llabs (n)
    f atoi (str)
    f atoll (str)
    f strtol (str, end, base)
    f strtoll (str, end, base)
    f exit (status)
  `,
  'string.h': `
    f memset (dest, ch, count)
    f memcpy (dest, src, count)
    f memmove (dest, src, count)
    f memcmp (a, b, count)
    f strlen (str)
    f strcmp (a, b)
    f strncmp (a, b, count)
    f strcpy (dest, src)
    f strncpy (dest, src, count)
    f strcat (dest, src)
    f strchr (str, ch)
    f strstr (str, sub)
    f strtok (str, delim)
  `,
  'math.h': `
    f sqrt (x)
    f pow (x, y)
    f floor (x)
    f ceil (x)
    f fabs (x)
    f round (x)
    f log (x)
    f log2 (x)
    f exp (x)
  `,
  'limits.h': `
    k INT_MAX int
    k INT_MIN int
    k LLONG_MAX long long
    k LLONG_MIN long long
    k UINT_MAX unsigned
  `,
  'stdbool.h': `
    t bool
    k true
    k false
  `,
  'stdint.h': `
    t int32_t
    t int64_t
    t uint32_t
    t uint64_t
  `,
  'ctype.h': `
    f isdigit (ch)
    f isalpha (ch)
    f isalnum (ch)
    f isspace (ch)
    f isupper (ch)
    f islower (ch)
    f toupper (ch)
    f tolower (ch)
  `,
};

const names: LibraryName[] = [];
for (const [header, lines] of Object.entries(HEADERS)) for (const e of entries(lines, header)) names.push(e);

const table: LibraryTable = { keywords: KEYWORDS.trim().split(/\s+/), names, members: {} };

export default table;
