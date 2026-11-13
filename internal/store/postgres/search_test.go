package postgres

import (
	"strings"
	"testing"
)

func TestSearchTextsAndTerms(t *testing.T) {
	got, err := searchTexts("Two-Sum, again", "", "Ünïcödé façade CAFÉ", "dp hash-map")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{" two sum again ", " ", " unicode facade cafe ", " dp hash map "}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("searchTexts: got %q, want %q", got, want)
	}
	cases := map[string][]string{
		"Two-Sum dp":               {" two sum", " dp"},
		`"); DROP TABLE items; --`: {" drop", " table", " items"},
		"--- ... !!":               nil,
		"Café":                     {" cafe"},
		"":                         nil,
	}
	for q, want := range cases {
		got, err := searchTerms(q)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("%q: got %q, want %q", q, got, want)
		}
	}
}
