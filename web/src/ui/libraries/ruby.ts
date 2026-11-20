import { entries, words, type LibraryTable } from './table';

/*
 * Ruby 2.7. Imports are library names, loaded with `require`: Set and Prime
 * still need theirs in 2.7. The legacy mode brings the keywords.
 */

const table: LibraryTable = {
  names: [
    ...entries('c Set\nc SortedSet', 'set'),
    ...entries('c Prime', 'prime'),
    ...entries(`
      c Math
      c Integer
      c Float
      c Array
      c Hash
      c String
      v STDIN IO
      v STDOUT IO
      f gets () String
      f puts (obj...)
      f print (obj...)
      f p (obj...)
    `),
  ],
  members: {
    'Math.': entries(`
      f sqrt (x)
      f cbrt (x)
      f log (x[, base])
      f log2 (x)
      f log10 (x)
      f exp (x)
      f hypot (x, y)
      f sin (x)
      f cos (x)
      f atan2 (y, x)
    `),
    'Math::': entries('k PI Float\nk E Float'),
    'Integer.': entries('f sqrt (n) Integer'),
    'Float::': entries('k INFINITY Float\nk NAN Float\nk EPSILON Float'),
    'Array.': entries('f new (size = 0, default = nil)'),
    'Hash.': entries('f new (default = nil)'),
    'Set.': entries('f new (enum = nil)', 'set'),
    'Prime.': entries(`
      f each (ubound = nil)
      f prime? (n) bool
      f first (n) Array
      f prime_division (n) Array
    `, 'prime'),
    'STDIN.': entries(`
      f gets () String
      f read () String
      f readlines () Array
      f each_line ()
    `),
    '$stdin.': entries(`
      f gets () String
      f read () String
      f readlines () Array
      f each_line ()
    `),
  },
  methods: words(
    'method',
    `each each_with_index each_with_object each_slice each_cons map flat_map select filter filter_map reject
     reduce inject sum min max min_by max_by minmax sort sort_by uniq include? push pop shift unshift size length
     first last join split to_i to_s to_f to_a to_sym chars bytes times upto downto step group_by tally count
     zip flatten keys values key? fetch dig abs gcd lcm pow divmod strip chomp reverse index any? all? none?
     find take drop take_while drop_while partition combination permutation product transpose rotate slice
     each_char sub gsub start_with? end_with? empty? nil? freeze dup`,
  ),
};

export default table;
