package bundle

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"codeathropy/internal/domain"
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
		Generator     struct {
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
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &m); err != nil {
		return nil, formatErr("bundle.json is malformed: %v", err)
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
	b := &Bundle{Meta: Meta{
		Name: m.Name, Description: m.Description, Author: m.Author, FormatVersion: *m.FormatVersion,
		GeneratorName: m.Generator.Name, GeneratorVersion: m.Generator.Version,
	}}
	if m.CreatedAt != nil {
		b.Meta.CreatedAt = m.CreatedAt.UTC()
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

// breakCycles moves collections that are part of a parent cycle to the top
// level.
func (r *reader) breakCycles(b *Bundle) {
	byID := map[string]*Collection{}
	for i := range b.Collections {
		byID[b.Collections[i].ID] = &b.Collections[i]
	}
	for i := range b.Collections {
		c := &b.Collections[i]
		visited := map[string]bool{c.ID: true}
		for p := c.ParentID; p != nil; {
			parent, ok := byID[*p]
			if !ok {
				c.ParentID = nil
				break
			}
			if visited[parent.ID] {
				r.warn("bundle.json: collection %s is part of a parent cycle; placed at the top level", c.ID)
				c.ParentID = nil
				break
			}
			visited[parent.ID] = true
			p = parent.ParentID
		}
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
		CreatedAt *time.Time `json:"createdAt"`
		UpdatedAt *time.Time `json:"updatedAt"`
		Problem   *struct {
			TimeLimitMs       *int              `json:"timeLimitMs"`
			MemoryLimitKb     *int              `json:"memoryLimitKb"`
			Compare           *string           `json:"compare"`
			Starter           map[string]string `json:"starter"`
			ReferenceSolution *struct {
				Language string `json:"language"`
				Path     string `json:"path"`
			} `json:"referenceSolution"`
		} `json:"problem"`
	}
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &j); err != nil {
		r.warn("%s/item.json: malformed (%v); item skipped", dir, err)
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
		r.warn("%s/item.json: invalid title; item skipped", dir)
		return Item{}, false
	}
	if utf8.RuneCountInString(it.Summary) > domain.MaxSummaryChars {
		r.warn("%s/item.json: summary too long; ignored", dir)
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
	now := time.Now().UTC().Truncate(time.Second)
	it.CreatedAt, it.UpdatedAt = now, now
	if j.CreatedAt != nil {
		it.CreatedAt = j.CreatedAt.UTC().Truncate(time.Second)
	}
	if j.UpdatedAt != nil {
		it.UpdatedAt = j.UpdatedAt.UTC().Truncate(time.Second)
	}

	if body, ok := r.file(dir + "/body.md"); ok {
		if s, ok := textOK(body); ok && len(s) <= domain.MaxTextBytes {
			it.Body = domain.NormalizeText(s)
		} else {
			r.warn("%s/body.md: not valid UTF-8 or too large; ignored", dir)
		}
	} else {
		r.warn("%s/body.md: missing; body left empty", dir)
	}

	if it.Type == domain.TypeProblem {
		p := &Problem{
			TimeLimitMs: domain.DefaultTimeLimitMs, MemoryLimitKb: domain.DefaultMemoryLimitKb,
			Compare: domain.CompareTokens, StarterCode: map[string]string{},
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
			if rs := jp.ReferenceSolution; rs != nil {
				if !domain.KnownLanguage(rs.Language) {
					r.warn("%s/item.json: unknown language %q in reference solution; ignored", dir, rs.Language)
				} else if src, ok := r.source(dir, rs.Path); ok {
					if strings.TrimSpace(src) == "" {
						r.warn("%s/%s: empty reference solution; ignored", dir, rs.Path)
					} else {
						p.ReferenceSolution = &domain.Solution{Language: rs.Language, Source: src}
					}
				}
			}
		}
		it.Problem = p
		it.TestCases = r.readTests(dir)
	}
	return it, true
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

func (r *reader) readTests(dir string) []TestCase {
	raw, ok := r.file(dir + "/tests/tests.json")
	if !ok {
		return nil
	}
	var tj struct {
		Cases []struct {
			Name     string  `json:"name"`
			Input    string  `json:"input"`
			Output   string  `json:"output"`
			Sample   bool    `json:"sample"`
			Origin   *string `json:"origin"`
			Verified bool    `json:"verified"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &tj); err != nil {
		r.warn("%s/tests/tests.json: malformed (%v); tests ignored", dir, err)
		return nil
	}
	var out []TestCase
	for i, c := range tj.Cases {
		if len(out) >= domain.MaxTestCasesPerItem {
			r.warn("%s/tests/tests.json: more than %d cases; the rest are ignored", dir, domain.MaxTestCasesPerItem)
			break
		}
		in, ok1 := r.testFile(dir, c.Input)
		exp, ok2 := r.testFile(dir, c.Output)
		if !ok1 || !ok2 {
			r.warn("%s/tests/tests.json: case %d refers to a missing file; skipped", dir, i+1)
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
		out = append(out, tc)
	}
	return out
}

func (r *reader) testFile(dir, name string) (string, bool) {
	if name == "" || strings.ContainsAny(name, `/\`) {
		return "", false
	}
	data, ok := r.file(dir + "/tests/" + name)
	if !ok || len(data) > domain.MaxTestCaseBytes {
		return "", false
	}
	return string(data), true
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
