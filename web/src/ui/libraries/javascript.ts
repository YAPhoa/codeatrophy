import { entries, words, type LibraryTable } from './table';

/*
 * JavaScript on Node.js 12, and TypeScript 3.7 on top of it: the global
 * objects, which need no import. Nothing newer than Node.js 12 (no
 * replaceAll, no Array.prototype.at). The JavaScript package brings the
 * keywords.
 */

const table: LibraryTable = {
  names: entries(`
    c Math
    c Number
    c Array
    c Object
    c String
    c JSON
    c Map Map<K, V>
    c Set Set<T>
    c BigInt
    v console
    v process
    f parseInt (string, radix)
    f parseFloat (string)
    f isNaN (value)
    k Infinity number
    k NaN number
  `),
  members: {
    'Math.': entries(`
      f abs (x)
      f max (...values)
      f min (...values)
      f floor (x)
      f ceil (x)
      f round (x)
      f trunc (x)
      f sign (x)
      f sqrt (x)
      f cbrt (x)
      f pow (x, y)
      f log (x)
      f log2 (x)
      f log10 (x)
      f exp (x)
      f hypot (...values)
      f random ()
      k PI number
      k E number
    `),
    'Number.': entries(`
      f parseInt (string, radix)
      f parseFloat (string)
      f isInteger (value)
      f isSafeInteger (value)
      f isNaN (value)
      f isFinite (value)
      k MAX_SAFE_INTEGER number
      k MIN_SAFE_INTEGER number
      k MAX_VALUE number
      k MIN_VALUE number
      k EPSILON number
      k POSITIVE_INFINITY number
      k NEGATIVE_INFINITY number
    `),
    'Array.': entries(`
      f from (arrayLike[, mapFn])
      f isArray (value)
      f of (...items)
    `),
    'Object.': entries(`
      f keys (obj)
      f values (obj)
      f entries (obj)
      f fromEntries (entries)
      f assign (target, ...sources)
      f freeze (obj)
      f create (proto)
    `),
    'String.': entries(`
      f fromCharCode (...codes)
      f fromCodePoint (...codePoints)
    `),
    'JSON.': entries(`
      f parse (text)
      f stringify (value)
    `),
    'console.': entries(`
      f log (...data)
      f error (...data)
      f warn (...data)
    `),
    'process.': entries(`
      v stdin
      v stdout
      v stderr
      v argv string[]
      v env
      f exit ([code])
    `),
    'process.stdout.': entries('f write (chunk)'),
    'process.stdin.': entries(`
      f on (event, listener)
      f setEncoding (encoding)
      f resume ()
    `),
    'BigInt.': entries(`
      f asIntN (bits, bigint)
      f asUintN (bits, bigint)
    `),
  },
  methods: words(
    'method',
    `push pop shift unshift slice splice map filter reduce reduceRight forEach sort reverse join split includes
     indexOf lastIndexOf concat fill find findIndex some every flat flatMap keys values entries has get set add
     delete clear trim trimStart trimEnd padStart padEnd repeat startsWith endsWith charAt charCodeAt codePointAt
     substring toUpperCase toLowerCase toString toFixed localeCompare match matchAll replace`,
  ).concat(words('property', 'length size')),
};

export default table;
