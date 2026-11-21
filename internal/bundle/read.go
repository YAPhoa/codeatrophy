package bundle

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"codeatrophy/internal/domain"
)

// Limits bound what Read accepts.
type Limits struct {
	MaxCompressedBytes   int64
	MaxUncompressedBytes int64
	MaxEntries           int
	MaxSourceBytes       int
}

// DefaultLimits derives limits from the maximum upload size.
func DefaultLimits(maxImportBytes int64, maxSourceBytes int) Limits {
	return Limits{
		MaxCompressedBytes:   maxImportBytes,
		MaxUncompressedBytes: domain.BundleExpansionFactor * maxImportBytes,
		MaxEntries:           domain.MaxBundleEntries,
		MaxSourceBytes:       maxSourceBytes,
	}
}

// FormatError means the archive is not a valid bundle.
type FormatError struct{ Msg string }

func (e *FormatError) Error() string { return e.Msg }

// LimitError means the archive exceeds a size limit.
type LimitError struct{ Msg string }

func (e *LimitError) Error() string { return e.Msg }

func formatErr(format string, args ...any) error {
	return &FormatError{Msg: fmt.Sprintf(format, args...)}
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ValidID reports whether s is a UUID string.
func ValidID(s string) bool { return uuidRe.MatchString(s) }

// safePath checks an archive entry name and returns it cleaned. It rejects
// absolute paths and any ".." segment, treating backslashes as separators
// for the check.
func safePath(name string) (string, bool) {
	if name == "" || strings.ContainsRune(name, 0) {
		return "", false
	}
	check := strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(check, "/") || (len(check) >= 2 && check[1] == ':') {
		return "", false
	}
	for _, seg := range strings.Split(check, "/") {
		if seg == ".." {
			return "", false
		}
	}
	return path.Clean(check), true
}

// Read parses and validates a bundle archive. Problems confined to one item
// or field are returned as warnings; anything that makes the whole archive
// unusable is a *FormatError or *LimitError.
func Read(data []byte, lim Limits) (*Bundle, []string, error) {
	if lim.MaxCompressedBytes > 0 && int64(len(data)) > lim.MaxCompressedBytes {
		return nil, nil, &LimitError{Msg: fmt.Sprintf("bundle exceeds the maximum size of %d bytes", lim.MaxCompressedBytes)}
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, formatErr("not a zip archive")
	}
	if lim.MaxEntries > 0 && len(zr.File) > lim.MaxEntries {
		return nil, nil, &LimitError{Msg: fmt.Sprintf("bundle has more than %d entries", lim.MaxEntries)}
	}
	files := map[string][]byte{}
	var total int64
	var warnings []string
	for _, f := range zr.File {
		name, ok := safePath(f.Name)
		if !ok {
			return nil, nil, formatErr("unsafe path in archive: %q", f.Name)
		}
		if f.FileInfo().IsDir() || strings.HasSuffix(f.Name, "/") {
			continue
		}
		if !f.Mode().IsRegular() {
			warnings = append(warnings, fmt.Sprintf("%s: not a regular file; ignored", name))
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, nil, formatErr("cannot read %s: %v", name, err)
		}
		remaining := int64(-1)
		if lim.MaxUncompressedBytes > 0 {
			remaining = lim.MaxUncompressedBytes - total
		}
		var r io.Reader = rc
		if remaining >= 0 {
			r = io.LimitReader(rc, remaining+1)
		}
		content, err := io.ReadAll(r)
		rc.Close()
		if err != nil {
			return nil, nil, formatErr("cannot read %s: %v", name, err)
		}
		total += int64(len(content))
		if lim.MaxUncompressedBytes > 0 && total > lim.MaxUncompressedBytes {
			return nil, nil, &LimitError{Msg: fmt.Sprintf("bundle expands to more than %d bytes", lim.MaxUncompressedBytes)}
		}
		files[name] = content
	}

	root := ""
	if _, ok := files["bundle.json"]; !ok {
		var candidates []string
		for name := range files {
			dir, rest, ok := strings.Cut(name, "/")
			if ok && rest == "bundle.json" && !slices.Contains(candidates, dir) {
				candidates = append(candidates, dir)
			}
		}
		if len(candidates) != 1 {
			return nil, nil, formatErr("bundle.json not found")
		}
		root = candidates[0] + "/"
	}
	r := &reader{files: files, root: root, lim: lim}
	b, err := r.parse()
	if err != nil {
		return nil, nil, err
	}
	return b, append(warnings, r.warnings...), nil
}

type reader struct {
	files    map[string][]byte
	root     string
	lim      Limits
	warnings []string
	version  int // the bundle's format version
}

func (r *reader) warn(format string, args ...any) {
	r.warnings = append(r.warnings, fmt.Sprintf(format, args...))
}

func (r *reader) file(rel string) ([]byte, bool) {
	clean, ok := safePath(rel)
	if !ok {
		return nil, false
	}
	b, ok := r.files[r.root+clean]
	return b, ok
}

func textOK(b []byte) (string, bool) {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(b) {
		return "", false
	}
	return string(b), true
}

func (r *reader) parse() (*Bundle, error) {
	raw, _ := r.file("bundle.json")
	var m struct {
		Format        *string    `json:"format"`
		FormatVersion *int       `json:"formatVersion"`
		Name          string     `json:"name"`
		Description   string     `json:"description"`
		Author        string     `json:"author"`
		CreatedAt     *time.Time `json:"createdAt"`
		Includes      *struct {
			Solutions   *bool `json:"solutions"`
			HiddenTests *bool `json:"hiddenTests"`
		} `json:"includes"`
		Generator struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"generator"`
		Items []struct {
			ID          string `json:"id"`
			Path        string `json:"path"`
			Type        string `json:"type"`
			Title       string `json:"title"`
			ContentHash string `json:"contentHash"`
		} `json:"items"`
		Collections []struct {
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Description string   `json:"description"`
			ParentID    *string  `json:"parentId"`
			Position    int      `json:"position"`
			ItemIDs     []string `json:"itemIds"`
		} `json:"collections"`
	}
	if err := domain.DecodeJSON(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &m); err != nil {
		return nil, formatErr("bundle.json: %s", jsonProblem(err))
	}
	if m.Format == nil || *m.Format != FormatName {
		return nil, formatErr("bundle.json: format must be %q", FormatName)
	}
	if m.FormatVersion == nil || *m.FormatVersion < 1 {
		return nil, formatErr("bundle.json: formatVersion is missing or invalid")
	}
	if *m.FormatVersion > FormatVersion {
		return nil, formatErr("bundle format version %d is newer than this server supports (%d)", *m.FormatVersion, FormatVersion)
	}
	if len(m.Collections) > domain.MaxBundleCollections {
		return nil, &LimitError{Msg: fmt.Sprintf("bundle has more than %d collections", domain.MaxBundleCollections)}
	}
	r.version = *m.FormatVersion
	b := &Bundle{Meta: Meta{
		Name: m.Name, Description: m.Description, Author: m.Author, FormatVersion: *m.FormatVersion,
		GeneratorName: m.Generator.Name, GeneratorVersion: m.Generator.Version,
	}}
	if m.CreatedAt != nil {
		b.Meta.CreatedAt = m.CreatedAt.UTC()
	}
	if inc := m.Includes; inc != nil && inc.Solutions != nil && inc.HiddenTests != nil {
		b.Meta.Includes = &Includes{Solutions: *inc.Solutions, HiddenTests: *inc.HiddenTests}
	} else if inc != nil {
		r.warn("bundle.json: includes needs both solutions and hiddenTests; ignored")
	}
	seen := map[string]bool{}
	for _, e := range m.Items {
		if !ValidID(e.ID) {
			r.warn("bundle.json: item %q has an invalid id; skipped", e.Title)
			continue
		}
		id := strings.ToLower(e.ID)
		if seen[id] {
			r.warn("bundle.json: duplicate item id %s; skipped", id)
			continue
		}
		dir, ok := safePath(e.Path)
		if !ok || dir == "." {
			r.warn("bundle.json: item %s has an invalid path; skipped", id)
			continue
		}
		it, ok := r.readItem(id, dir)
		if !ok {
			continue
		}
		r.applyIncludes(&it, b.Meta.Includes)
		it.StoredHash = e.ContentHash
		if e.ContentHash != "" && e.ContentHash != ContentHash(&it) {
			r.warn("%s: content hash does not match the files; the files are used", dir)
		}
		seen[id] = true
		b.Items = append(b.Items, it)
	}

	collSeen := map[string]bool{}
	for _, c := range m.Collections {
		if ValidID(c.ID) {
			collSeen[strings.ToLower(c.ID)] = true
		}
	}
	added := map[string]bool{}
	for _, c := range m.Collections {
		if !ValidID(c.ID) {
			r.warn("bundle.json: collection %q has an invalid id; skipped", c.Name)
			continue
		}
		id := strings.ToLower(c.ID)
		if added[id] {
			r.warn("bundle.json: duplicate collection id %s; skipped", id)
			continue
		}
		col := domain.Collection{Name: c.Name, Description: c.Description}
		if errs := domain.ValidateCollection(&col); len(errs) > 0 {
			r.warn("bundle.json: collection %s: %s; skipped", id, errs.First())
			continue
		}
		out := Collection{ID: id, Name: col.Name, Description: col.Description, Position: c.Position, ItemIDs: []string{}}
		if c.ParentID != nil {
			pid := strings.ToLower(*c.ParentID)
			if collSeen[pid] && pid != id {
				out.ParentID = &pid
			} else {
				r.warn("bundle.json: collection %s refers to a parent that is not in the bundle; placed at the top level", id)
			}
		}
		memberSeen := map[string]bool{}
		for _, iid := range c.ItemIDs {
			iid = strings.ToLower(iid)
			if !seen[iid] {
				r.warn("bundle.json: collection %s lists item %s, which is not in the bundle; ignored", id, iid)
				continue
			}
			if !memberSeen[iid] {
				memberSeen[iid] = true
				out.ItemIDs = append(out.ItemIDs, iid)
			}
		}
		added[id] = true
		b.Collections = append(b.Collections, out)
	}
	r.breakCycles(b)
	return b, nil
}

// breakCycles removes parent cycles by cutting, for each cycle, the parent
// link that closes it, so collections hanging off a cycle keep their place.
// It runs in linear time.
func (r *reader) breakCycles(b *Bundle) {
	byID := make(map[string]*Collection, len(b.Collections))
	for i := range b.Collections {
		byID[b.Collections[i].ID] = &b.Collections[i]
	}
	const (
		unvisited = iota
		onPath
		done
	)
	state := make(map[string]int, len(b.Collections))
	for i := range b.Collections {
		var path []*Collection
		for c := &b.Collections[i]; c != nil && state[c.ID] == unvisited; {
			state[c.ID] = onPath
			path = append(path, c)
			if c.ParentID == nil {
				break
			}
			parent, ok := byID[*c.ParentID]
			if !ok {
				c.ParentID = nil
				break
			}
			if state[parent.ID] == onPath {
				r.warn("bundle.json: collections %s and %s form a parent cycle; %s placed at the top level", c.ID, parent.ID, c.ID)
				c.ParentID = nil
				break
			}
			c = parent
		}
		for _, c := range path {
			state[c.ID] = done
		}
	}
}

// applyIncludes sets what an item carries, from the bundle's includes or,
// when a bundle does not say, inferred from its files.
func (r *reader) applyIncludes(it *Item, inc *Includes) {
	if it.Type != domain.TypeProblem {
		return
	}
	if inc == nil {
		it.HiddenTestsIncluded = anyHidden(it.TestCases)
		return
	}
	it.HiddenTestsIncluded = inc.HiddenTests
	if !inc.HiddenTests && anyHidden(it.TestCases) {
		r.warn("%s: hidden test cases in a bundle exported without them; ignored", it.Dir)
		var samples []TestCase
		for _, tc := range it.TestCases {
			if tc.IsSample {
				samples = append(samples, tc)
			}
		}
		it.TestCases = samples
	}
	switch {
	case inc.Solutions && !it.SolutionsIncluded:
		it.SolutionsIncluded, it.Solutions = true, []Solution{}
	case !inc.Solutions && it.SolutionsIncluded:
		r.warn("%s: solutions in a bundle exported without them; ignored", it.Dir)
		it.SolutionsIncluded, it.Solutions = false, nil
	}
}

func (r *reader) readItem(id, dir string) (Item, bool) {
	raw, ok := r.file(dir + "/item.json")
	if !ok {
		r.warn("%s/item.json: missing; item skipped", dir)
		return Item{}, false
	}
	var j struct {
		ID         string   `json:"id"`
		Type       string   `json:"type"`
		Title      string   `json:"title"`
		Summary    string   `json:"summary"`
		Difficulty *string  `json:"difficulty"`
		Tags       []string `json:"tags"`
		Source     *struct {
			URL  *string `json:"url"`
			Note *string `json:"note"`
		} `json:"source"`
		VariantOf *string    `json:"variantOf"`
		Related   []string   `json:"related"`
		CreatedAt *time.Time `json:"createdAt"`
		UpdatedAt *time.Time `json:"updatedAt"`
		Problem   *struct {
			TimeLimitMs   *int              `json:"timeLimitMs"`
			MemoryLimitKb *int              `json:"memoryLimitKb"`
			Compare       *string           `json:"compare"`
			Starter       map[string]string `json:"starter"`
			// Format version 2. Decoded only for such bundles: in version 1
			// they are unknown fields, which readers ignore.
			Interface json.RawMessage `json:"interface"`
			Harness   json.RawMessage `json:"harness"`
		} `json:"problem"`
	}
	if err := domain.DecodeJSON(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &j); err != nil {
		r.warn("%s/item.json: %s; item skipped", dir, jsonProblem(err))
		return Item{}, false
	}
	if strings.ToLower(j.ID) != id {
		r.warn("%s/item.json: id does not match bundle.json; item skipped", dir)
		return Item{}, false
	}
	it := Item{ID: id, Type: domain.ItemType(j.Type), Title: strings.TrimSpace(domain.NormalizeText(j.Title)),
		Summary: domain.NormalizeText(j.Summary), Dir: dir}
	if !it.Type.Valid() {
		r.warn("%s/item.json: unknown type %q; item skipped", dir, j.Type)
		return Item{}, false
	}
	if n := utf8.RuneCountInString(it.Title); n < 1 || n > domain.MaxTitleChars {
		r.warn("%s/item.json: title must be 1-%d characters; item skipped", dir, domain.MaxTitleChars)
		return Item{}, false
	}
	if !domain.IsSingleLine(it.Title) {
		r.warn("%s/item.json: title %s; item skipped", dir, domain.SingleLineMessage)
		return Item{}, false
	}
	if utf8.RuneCountInString(it.Summary) > domain.MaxSummaryChars {
		r.warn("%s/item.json: summary longer than %d characters; ignored", dir, domain.MaxSummaryChars)
		it.Summary = ""
	}
	if j.Difficulty != nil {
		d := domain.Difficulty(*j.Difficulty)
		if d.Valid() {
			it.Difficulty = &d
		} else {
			r.warn("%s/item.json: unknown difficulty %q; ignored", dir, *j.Difficulty)
		}
	}
	it.Tags = []string{}
	for _, t := range domain.NormalizeTags(j.Tags) {
		if msg := domain.ValidateTag(t); msg != "" {
			r.warn("%s/item.json: tag %q %s; ignored", dir, t, msg)
			continue
		}
		if len(it.Tags) >= domain.MaxTags {
			r.warn("%s/item.json: more than %d tags; the rest are ignored", dir, domain.MaxTags)
			break
		}
		it.Tags = append(it.Tags, t)
	}
	if j.Source != nil {
		if j.Source.URL != nil && strings.TrimSpace(*j.Source.URL) != "" {
			u := strings.TrimSpace(domain.NormalizeText(*j.Source.URL))
			if msg := domain.ValidateURL(u); msg == "" {
				it.Source.URL = &u
			} else {
				r.warn("%s/item.json: source.url %s; ignored", dir, msg)
			}
		}
		if j.Source.Note != nil && strings.TrimSpace(*j.Source.Note) != "" {
			n := strings.TrimSpace(domain.NormalizeText(*j.Source.Note))
			if utf8.RuneCountInString(n) <= domain.MaxSourceNoteChars {
				it.Source.Note = &n
			} else {
				r.warn("%s/item.json: source.note too long; ignored", dir)
			}
		}
	}
	if j.VariantOf != nil {
		if ValidID(*j.VariantOf) {
			v := strings.ToLower(*j.VariantOf)
			if v != id {
				it.VariantOf = &v
			}
		} else {
			r.warn("%s/item.json: invalid variantOf; ignored", dir)
		}
	}
	related := map[string]bool{}
	for _, rel := range j.Related {
		if !ValidID(rel) {
			r.warn("%s/item.json: invalid id %q in related; ignored", dir, rel)
			continue
		}
		if v := strings.ToLower(rel); v != id {
			related[v] = true
		}
	}
	if len(related) > MaxRelated {
		r.warn("%s/item.json: more than %d related items; the rest are ignored", dir, MaxRelated)
	}
	for _, rel := range slices.Sorted(maps.Keys(related)) {
		if len(it.Related) == MaxRelated {
			break
		}
		it.Related = append(it.Related, rel)
	}
	now := time.Now().UTC().Truncate(time.Second)
	it.CreatedAt, it.UpdatedAt = now, now
	if j.CreatedAt != nil {
		it.CreatedAt = j.CreatedAt.UTC().Truncate(time.Second)
	}
	if j.UpdatedAt != nil {
		it.UpdatedAt = j.UpdatedAt.UTC().Truncate(time.Second)
	}

	if body, ok := r.file(dir + "/body.md"); ok {
		switch s, ok := textOK(body); {
		case !ok:
			r.warn("%s/body.md: not valid UTF-8; body left empty", dir)
		case len(domain.NormalizeText(s)) > domain.MaxTextBytes:
			r.warn("%s/body.md: larger than %d bytes; body left empty", dir, domain.MaxTextBytes)
		default:
			it.Body = domain.NormalizeText(s)
		}
	} else {
		r.warn("%s/body.md: missing; body left empty", dir)
	}

	if it.Type == domain.TypeProblem {
		p := &Problem{
			TimeLimitMs: domain.DefaultTimeLimitMs, MemoryLimitKb: domain.DefaultMemoryLimitKb,
			Compare: domain.CompareTokens, StarterCode: map[string]string{},
			Interface: domain.InterfaceProgram, Harness: map[string]domain.HarnessCode{},
		}
		if jp := j.Problem; jp != nil {
			if jp.TimeLimitMs != nil {
				if v := *jp.TimeLimitMs; v >= domain.MinTimeLimitMs && v <= domain.MaxTimeLimitMs {
					p.TimeLimitMs = v
				} else {
					r.warn("%s/item.json: timeLimitMs %d out of range; default used", dir, v)
				}
			}
			if jp.MemoryLimitKb != nil {
				if v := *jp.MemoryLimitKb; v >= domain.MinMemoryLimitKb && v <= domain.MaxMemoryLimitKb {
					p.MemoryLimitKb = v
				} else {
					r.warn("%s/item.json: memoryLimitKb %d out of range; default used", dir, v)
				}
			}
			if jp.Compare != nil {
				if m := domain.CompareMode(*jp.Compare); m.Valid() {
					p.Compare = m
				} else {
					r.warn("%s/item.json: unknown compare mode %q; default used", dir, *jp.Compare)
				}
			}
			langs := make([]string, 0, len(jp.Starter))
			for lang := range jp.Starter {
				langs = append(langs, lang)
			}
			slices.Sort(langs)
			for _, lang := range langs {
				if !domain.KnownLanguage(lang) {
					r.warn("%s/item.json: unknown language %q in starter code; ignored", dir, lang)
					continue
				}
				src, ok := r.source(dir, jp.Starter[lang])
				if !ok {
					continue
				}
				p.StarterCode[lang] = src
			}
			if !r.readInterface(dir, p, jp.Interface, jp.Harness) {
				return Item{}, false
			}
		}
		it.Problem = p
		if it.TestCases, ok = r.readTests(dir); !ok {
			return Item{}, false
		}
		if it.Solutions, it.SolutionsIncluded, ok = r.readSolutions(dir); !ok {
			return Item{}, false
		}
	}
	return it, true
}

// readInterface reads problem.interface and problem.harness into p. In a
// version 1 bundle they mean nothing and are ignored. It returns false when
// the item cannot be imported faithfully: an unknown interface or a
// malformed harness would turn it into a problem that cannot be solved.
func (r *reader) readInterface(dir string, p *Problem, rawIface, rawHarness json.RawMessage) bool {
	present := func(raw json.RawMessage) bool {
		t := bytes.TrimSpace(raw)
		return len(t) > 0 && !bytes.Equal(t, []byte("null"))
	}
	if r.version < Version2 {
		if present(rawIface) && !bytes.Equal(bytes.TrimSpace(rawIface), []byte(`"program"`)) {
			r.warn("%s/item.json: problem.interface is not part of bundle format version 1; ignored, the problem is a full program", dir)
		}
		return true
	}
	if present(rawIface) {
		var iface string
		if err := json.Unmarshal(rawIface, &iface); err != nil {
			r.warn("%s/item.json: problem.interface must be a string; item skipped", dir)
			return false
		}
		switch f := domain.ProblemInterface(iface); f {
		case domain.InterfaceProgram, domain.InterfaceFunction:
			p.Interface = f
		default:
			r.warn("%s/item.json: unknown problem.interface %q; item skipped", dir, iface)
			return false
		}
	}
	if !present(rawHarness) {
		return true
	}
	var hj map[string]struct {
		Prefix *string `json:"prefix"`
		Suffix *string `json:"suffix"`
	}
	if err := domain.DecodeJSON(rawHarness, &hj); err != nil {
		r.warn("%s/item.json: problem.harness: %s; item skipped", dir, jsonProblem(err))
		return false
	}
	if p.Interface != domain.InterfaceFunction {
		if len(hj) > 0 {
			r.warn("%s/item.json: problem.harness given for a full-program problem; ignored", dir)
		}
		return true
	}
	for _, lang := range slices.Sorted(maps.Keys(hj)) {
		if !domain.KnownLanguage(lang) {
			r.warn("%s/item.json: unknown language %q in harness; ignored", dir, lang)
			continue
		}
		var code domain.HarnessCode
		ok := true
		for _, part := range []struct {
			rel *string
			dst *string
		}{{hj[lang].Prefix, &code.Prefix}, {hj[lang].Suffix, &code.Suffix}} {
			if part.rel == nil || *part.rel == "" {
				continue // an empty part
			}
			src, found := r.source(dir, *part.rel)
			if !found {
				ok = false
				break
			}
			*part.dst = src
		}
		if !ok {
			r.warn("%s/item.json: the %s harness is incomplete; %s cannot be used for this problem", dir, lang, lang)
			continue
		}
		p.Harness[lang] = code
	}
	return true
}

func (r *reader) source(dir, rel string) (string, bool) {
	data, ok := r.file(dir + "/" + rel)
	if !ok {
		r.warn("%s/%s: missing; ignored", dir, rel)
		return "", false
	}
	s, ok := textOK(data)
	if !ok {
		r.warn("%s/%s: not valid UTF-8; ignored", dir, rel)
		return "", false
	}
	s = domain.NormalizeText(s)
	if r.lim.MaxSourceBytes > 0 && len(s) > r.lim.MaxSourceBytes {
		r.warn("%s/%s: larger than %d bytes; ignored", dir, rel, r.lim.MaxSourceBytes)
		return "", false
	}
	return s, true
}

// readTests reads an item's test cases. It returns false when tests.json
// is malformed, in which case the item cannot be imported safely (an
// overwrite would replace the local cases with none).
func (r *reader) readTests(dir string) ([]TestCase, bool) {
	raw, ok := r.file(dir + "/tests/tests.json")
	if !ok {
		return nil, true
	}
	var tj struct {
		Cases []struct {
			Name     string  `json:"name"`
			Input    string  `json:"input"`
			Output   string  `json:"output"`
			Sample   bool    `json:"sample"`
			Origin   *string `json:"origin"`
			Verified bool    `json:"verified"`
			// Generator is read apart: one that is not usable is left
			// out, and the case is imported without it.
			Generator json.RawMessage `json:"generator"`
		} `json:"cases"`
	}
	if err := domain.DecodeJSON(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &tj); err != nil {
		r.warn("%s/tests/tests.json: %s; item skipped", dir, jsonProblem(err))
		return nil, false
	}
	var out []TestCase
	for i, c := range tj.Cases {
		if len(out) >= domain.MaxTestCasesPerItem {
			r.warn("%s/tests/tests.json: more than %d cases; the rest are ignored", dir, domain.MaxTestCasesPerItem)
			break
		}
		in, msg1 := r.testFile(dir, c.Input)
		exp, msg2 := r.testFile(dir, c.Output)
		if msg := msg1 + msg2; msg != "" {
			r.warn("%s/tests/tests.json: case %d: %s; skipped", dir, i+1, strings.TrimSuffix(msg1+"; "+msg2, "; "))
			continue
		}
		tc := TestCase{Name: domain.NormalizeText(c.Name), Stdin: in, ExpectedStdout: exp, IsSample: c.Sample, Origin: domain.OriginImport, Verified: c.Verified}
		if c.Origin != nil {
			if o := domain.TestOrigin(*c.Origin); o.Valid() {
				tc.Origin = o
			} else {
				r.warn("%s/tests/tests.json: case %d has unknown origin %q; recorded as import", dir, i+1, *c.Origin)
			}
		}
		if utf8.RuneCountInString(tc.Name) > domain.MaxTestCaseNameChars {
			tc.Name = ""
			r.warn("%s/tests/tests.json: case %d name too long; ignored", dir, i+1)
		}
		tc.Generator = r.readGenerator(dir, i, c.Generator)
		out = append(out, tc)
	}
	return out, true
}

// readGenerator reads a test case's optional generator: a language and the
// name of the file in tests/ that holds its source. One that cannot be used
// is reported and left out; the case keeps its stdin either way.
func (r *reader) readGenerator(dir string, i int, raw json.RawMessage) *domain.GeneratorSpec {
	if t := bytes.TrimSpace(raw); len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return nil
	}
	var gj struct {
		Language string `json:"language"`
		File     string `json:"file"`
	}
	skip := func(why string) *domain.GeneratorSpec {
		r.warn("%s/tests/tests.json: case %d: generator %s; the case is imported without it", dir, i+1, why)
		return nil
	}
	if err := domain.DecodeJSON(raw, &gj); err != nil {
		var te *domain.TypeError
		if errors.As(err, &te) && te.Path == "" {
			return skip("must be an object")
		}
		return skip(jsonProblem(err))
	}
	if !domain.KnownLanguage(gj.Language) {
		return skip(fmt.Sprintf("has unknown language %q", gj.Language))
	}
	if gj.File == "" || strings.ContainsAny(gj.File, `/\`) {
		return skip(fmt.Sprintf("has invalid file name %q", gj.File))
	}
	data, ok := r.file(dir + "/tests/" + gj.File)
	if !ok {
		return skip(fmt.Sprintf("file %s is missing", gj.File))
	}
	src, ok := textOK(data)
	if !ok {
		return skip(fmt.Sprintf("file %s is not valid UTF-8", gj.File))
	}
	g := domain.GeneratorSpec{Language: gj.Language, Source: domain.NormalizeText(src)}
	if fe := domain.ValidateSolution(g.Solution(), domain.Limits{MaxSourceBytes: r.lim.MaxSourceBytes}); len(fe) > 0 {
		return skip(fmt.Sprintf("file %s: %s", gj.File, fe.First()))
	}
	return &g
}

// testFile reads a test input or output; the second result is "" or a
// description of the problem.
func (r *reader) testFile(dir, name string) (string, string) {
	if name == "" || strings.ContainsAny(name, `/\`) {
		return "", fmt.Sprintf("invalid file name %q", name)
	}
	data, ok := r.file(dir + "/tests/" + name)
	switch {
	case !ok:
		return "", fmt.Sprintf("file %s is missing", name)
	case len(data) > domain.MaxTestCaseBytes:
		return "", fmt.Sprintf("file %s is larger than %d bytes", name, domain.MaxTestCaseBytes)
	case !utf8.Valid(data):
		// Test data travels as JSON strings in the API, which cannot hold
		// invalid UTF-8; importing it would alter it silently.
		return "", fmt.Sprintf("file %s is not valid UTF-8", name)
	}
	return string(data), ""
}

// jsonProblem describes a JSON decoding error.
func jsonProblem(err error) string {
	var te *domain.TypeError
	if errors.As(err, &te) {
		return te.Error()
	}
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return fmt.Sprintf("malformed JSON at byte %d: %v", se.Offset, se)
	}
	return "malformed JSON: " + err.Error()
}

// IsFormatError reports whether err means the archive is not a valid bundle.
func IsFormatError(err error) bool {
	var fe *FormatError
	return errors.As(err, &fe)
}

// IsLimitError reports whether err means the archive exceeds a size limit.
func IsLimitError(err error) bool {
	var le *LimitError
	return errors.As(err, &le)
}

// readSolutions reads solutions/solutions.json. Its absence means the bundle
// was exported without solutions.
// readSolutions reads an item's solutions; included is false when the
// bundle carries none for it. ok is false when solutions.json is malformed:
// the item is then skipped, since an overwrite would replace the local
// solutions with none.
func (r *reader) readSolutions(dir string) (sols []Solution, included, ok bool) {
	raw, found := r.file(dir + "/solutions/solutions.json")
	if !found {
		return nil, false, true
	}
	var sj struct {
		Solutions []struct {
			Name      string `json:"name"`
			Language  string `json:"language"`
			File      string `json:"file"`
			Notes     string `json:"notes"`
			Reference bool   `json:"reference"`
		} `json:"solutions"`
	}
	if err := domain.DecodeJSON(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &sj); err != nil {
		r.warn("%s/solutions/solutions.json: %s; item skipped", dir, jsonProblem(err))
		return nil, false, false
	}
	out := []Solution{}
	haveRef := false
	for i, e := range sj.Solutions {
		if len(out) >= domain.MaxSolutionsPerItem {
			r.warn("%s/solutions/solutions.json: more than %d solutions; the rest are ignored", dir, domain.MaxSolutionsPerItem)
			break
		}
		if !domain.KnownLanguage(e.Language) {
			r.warn("%s/solutions/solutions.json: solution %d has unknown language %q; skipped", dir, i+1, e.Language)
			continue
		}
		if e.File == "" || strings.ContainsAny(e.File, `/\`) {
			r.warn("%s/solutions/solutions.json: solution %d has an invalid file name; skipped", dir, i+1)
			continue
		}
		src, ok := r.source(dir, "solutions/"+e.File)
		if !ok {
			continue
		}
		s := domain.ItemSolution{Name: e.Name, Language: e.Language, Source: src, Notes: e.Notes}
		if fe := domain.ValidateItemSolution(&s, domain.Limits{MaxSourceBytes: r.lim.MaxSourceBytes}); len(fe) > 0 {
			r.warn("%s/solutions/solutions.json: solution %d: %s; skipped", dir, i+1, fe.First())
			continue
		}
		ref := e.Reference
		if ref && haveRef {
			r.warn("%s/solutions/solutions.json: more than one reference solution; only the first is kept as reference", dir)
			ref = false
		}
		haveRef = haveRef || ref
		out = append(out, Solution{Name: s.Name, Language: s.Language, Source: s.Source, Notes: s.Notes, IsReference: ref})
	}
	return out, true, true
}
