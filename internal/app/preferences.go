package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Preferences are an account's personal settings for clients to honour. The server stores
// and validates them but does not act on them. They are never exported.
// Over MCP the test case preferences can be read (see Overview), never
// changed.

type prefKind int

const (
	prefBool prefKind = iota
	prefInt
)

// prefDef defines one preference. Adding a preference is a one-line change
// here: defaults, validation and the response shape all derive from this
// table.
type prefDef struct {
	path    string // dotted path, e.g. "editor.tabSize"
	kind    prefKind
	def     any
	min     int   // prefInt: inclusive bounds when allowed is empty
	max     int   //
	allowed []int // prefInt: the only accepted values, if set
	// limit, if set, gives max from the instance's limits instead. A stored
	// value above it (saved under a higher limit) reads as the limit, and
	// the default never exceeds it.
	limit func(domain.Limits) int
}

// bounds returns d with max resolved against the instance's limits.
func (d prefDef) bounds(l domain.Limits) prefDef {
	if d.limit != nil {
		d.max = d.limit(l)
		if n, ok := d.def.(int); ok {
			d.def = min(n, d.max)
		}
	}
	return d
}

var preferenceSchema = []prefDef{
	{path: "hideTestCases", kind: prefBool, def: true},
	{path: "generatedTestCases", kind: prefInt, def: DefaultGeneratedCases, min: 1,
		limit: func(l domain.Limits) int { return l.MaxGeneratedTestCases }},
	{path: "largeTestCase", kind: prefBool, def: false},
	{path: "largeTestCaseCount", kind: prefInt, def: DefaultLargeTestCases, min: 1,
		limit: func(l domain.Limits) int { return l.MaxLargeTestCases }},
	{path: "editor.autocomplete", kind: prefBool, def: true},
	{path: "editor.closeBrackets", kind: prefBool, def: true},
	{path: "editor.matchBrackets", kind: prefBool, def: true},
	{path: "editor.lineWrapping", kind: prefBool, def: false},
	{path: "editor.tabSize", kind: prefInt, def: 4, allowed: []int{2, 4, 8}},
	{path: "editor.fontSize", kind: prefInt, def: 14, min: 10, max: 24},
}

// Preferences is the nested preferences document.
type Preferences map[string]any

func prefByPath(path string, l domain.Limits) (prefDef, bool) {
	for _, d := range preferenceSchema {
		if d.path == path {
			return d.bounds(l), true
		}
	}
	return prefDef{}, false
}

func isPrefGroup(prefix string) bool {
	return slices.ContainsFunc(preferenceSchema, func(d prefDef) bool { return strings.HasPrefix(d.path, prefix+".") })
}

// validatePref checks a decoded JSON value against its definition and
// returns the normalized value.
func validatePref(d prefDef, v any) (any, string) {
	switch d.kind {
	case prefBool:
		b, ok := v.(bool)
		if !ok {
			return nil, "must be a boolean"
		}
		return b, ""
	case prefInt:
		num, ok := v.(json.Number)
		if !ok {
			return nil, "must be an integer"
		}
		n, err := strconv.Atoi(num.String())
		if err != nil {
			return nil, "must be an integer"
		}
		if len(d.allowed) > 0 {
			if !slices.Contains(d.allowed, n) {
				parts := make([]string, len(d.allowed))
				for i, a := range d.allowed {
					parts[i] = strconv.Itoa(a)
				}
				return nil, "must be one of " + strings.Join(parts, ", ")
			}
		} else if n < d.min || n > d.max {
			return nil, fmt.Sprintf("must be between %d and %d", d.min, d.max)
		}
		return n, ""
	}
	return nil, "unsupported preference"
}

// render builds the nested document from defaults overlaid with stored
// values. Stored values no longer in the schema, or no longer valid, are
// ignored, except that one above a limit from the instance's limits (saved
// under a higher limit) reads as the limit.
func renderPreferences(stored map[string]any, l domain.Limits) Preferences {
	out := Preferences{}
	for _, d := range preferenceSchema {
		d = d.bounds(l)
		v := d.def
		if s, ok := stored[d.path]; ok {
			wide := d
			if d.limit != nil {
				wide.max = math.MaxInt
			}
			if nv, msg := validatePref(wide, normalizeStored(s)); msg == "" {
				v = nv
				if n, ok := nv.(int); ok && d.limit != nil {
					v = min(n, d.max)
				}
			}
		}
		parts := strings.Split(d.path, ".")
		m := map[string]any(out)
		for _, p := range parts[:len(parts)-1] {
			next, ok := m[p].(map[string]any)
			if !ok {
				next = map[string]any{}
				m[p] = next
			}
			m = next
		}
		m[parts[len(parts)-1]] = v
	}
	return out
}

// normalizeStored converts values decoded from storage to the forms
// validatePref expects.
func normalizeStored(v any) any {
	switch x := v.(type) {
	case float64:
		return json.Number(strconv.FormatFloat(x, 'f', -1, 64))
	case int:
		return json.Number(strconv.Itoa(x))
	}
	return v
}

// storedPreferences reads the preferences of the account ctx acts for.
func (a *App) storedPreferences(ctx context.Context, tx store.Tx) (map[string]any, error) {
	stored := map[string]any{}
	raw, ok, err := tx.GetSetting(store.PreferencesKey(accountOf(ctx)))
	if err != nil || !ok {
		return stored, err
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&stored); err != nil {
		a.log.Warn("stored preferences are unreadable; defaults apply", "error", err)
		return map[string]any{}, nil
	}
	return stored, nil
}

// GetPreferences returns every preference, defaults filled in.
func (a *App) GetPreferences(ctx context.Context) (Preferences, error) {
	var out Preferences
	err := a.store.Read(ctx, func(tx store.Tx) error {
		stored, err := a.storedPreferences(ctx, tx)
		out = renderPreferences(stored, a.limits)
		return err
	})
	return out, err
}

// UpdatePreferences deep-merges a partial document. An unknown key or an
// invalid value rejects the whole update.
func (a *App) UpdatePreferences(ctx context.Context, raw json.RawMessage) (Preferences, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, errBadRequest("malformed JSON")
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return nil, errBadRequest("the request body must be a JSON object")
	}
	updates := map[string]any{}
	fe := domain.FieldErrors{}
	var walk func(prefix string, m map[string]any)
	walk = func(prefix string, m map[string]any) {
		for k, v := range m {
			path := k
			if prefix != "" {
				path = prefix + "." + k
			}
			if d, ok := prefByPath(path, a.limits); ok {
				nv, msg := validatePref(d, v)
				if msg != "" {
					fe.Add(path, msg)
					continue
				}
				updates[path] = nv
				continue
			}
			if isPrefGroup(path) {
				sub, ok := v.(map[string]any)
				if !ok {
					fe.Add(path, "must be an object")
					continue
				}
				walk(path, sub)
				continue
			}
			fe.Add(path, "unknown preference")
		}
	}
	walk("", obj)
	if err := errValidation(fe); err != nil {
		return nil, err
	}
	var out Preferences
	err := a.store.Write(ctx, func(tx store.Tx) error {
		stored, err := a.storedPreferences(ctx, tx)
		if err != nil {
			return err
		}
		for k, v := range updates {
			stored[k] = v
		}
		b, err := json.Marshal(stored)
		if err != nil {
			return err
		}
		if err := tx.SetSetting(store.PreferencesKey(accountOf(ctx)), string(b)); err != nil {
			return err
		}
		out = renderPreferences(stored, a.limits)
		return nil
	})
	return out, err
}
