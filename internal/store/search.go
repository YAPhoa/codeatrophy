package store

import (
	"strings"
	"unicode"
)

// SearchWords splits a search query (ItemFilter.Query) into the words an
// item must match: the whitespace-separated words that contain a letter or
// a digit. Words of punctuation only are skipped, since the search
// tokenizer finds no token in them.
func SearchWords(q string) []string {
	var words []string
	for _, w := range strings.FieldsFunc(q, unicode.IsSpace) {
		if strings.IndexFunc(w, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) >= 0 {
			words = append(words, w)
		}
	}
	return words
}
