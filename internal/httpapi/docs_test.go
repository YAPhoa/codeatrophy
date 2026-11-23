package httpapi_test

import (
	"encoding/json"
	"maps"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// GET /meta answers as the example in docs/api.md shows: on an instance
// with the default limits, the same limits, and the same fields elsewhere.
func TestMetaIsAsDocumented(t *testing.T) {
	doc, err := os.ReadFile("../../docs/api.md")
	if err != nil {
		t.Fatal(err)
	}
	section := string(doc)
	section = section[strings.Index(section, "### `GET /meta`"):]
	example := regexp.MustCompile("(?s)```json\n(.*?)\n```").FindStringSubmatch(section)
	if example == nil {
		t.Fatal("no JSON example under GET /meta in docs/api.md")
	}
	var documented map[string]any
	if err := json.Unmarshal([]byte(example[1]), &documented); err != nil {
		t.Fatalf("the example under GET /meta in docs/api.md: %v", err)
	}

	c := newServerWith(t, func(o *app.Options) { o.Limits = domain.Limits{} })
	meta := c.expect("GET", api+"/meta", "", 200).json(t)
	keys := func(m any) []string {
		obj, _ := m.(map[string]any)
		return slices.Sorted(maps.Keys(obj))
	}
	if got, want := keys(meta), keys(documented); !slices.Equal(got, want) {
		t.Errorf("fields: %v, documented %v", got, want)
	}
	for _, part := range []string{"ai", "judge", "mcp"} {
		if got, want := keys(meta[part]), keys(documented[part]); !slices.Equal(got, want) {
			t.Errorf("%s: fields %v, documented %v", part, got, want)
		}
	}
	got, want := meta["limits"].(map[string]any), documented["limits"].(map[string]any)
	for _, k := range slices.Sorted(maps.Keys(want)) {
		if !reflect.DeepEqual(got[k], want[k]) {
			t.Errorf("limits.%s: %v, documented %v", k, got[k], want[k])
		}
	}
	for _, k := range slices.Sorted(maps.Keys(got)) {
		if _, ok := want[k]; !ok {
			t.Errorf("limits.%s is not documented", k)
		}
	}
}
