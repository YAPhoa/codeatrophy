package bundle

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"
	"time"

	"codeatrophy/internal/domain"
)

// JSON shapes of the files in a bundle.

type bundleJSON struct {
	Format        string           `json:"format"`
	FormatVersion int              `json:"formatVersion"`
	Name          string           `json:"name"`
	Description   string           `json:"description"`
	Author        string           `json:"author"`
	CreatedAt     time.Time        `json:"createdAt"`
	Generator     generatorJSON    `json:"generator"`
	Includes      *includesJSON    `json:"includes,omitempty"`
	Items         []itemEntryJSON  `json:"items"`
	Collections   []collectionJSON `json:"collections"`
}

type includesJSON struct {
	Solutions   bool `json:"solutions"`
	HiddenTests bool `json:"hiddenTests"`
}

type generatorJSON struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type itemEntryJSON struct {
	ID          string `json:"id"`
	Path        string `json:"path"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	ContentHash string `json:"contentHash"`
}

type collectionJSON struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	ParentID    *string  `json:"parentId"`
	Position    int      `json:"position"`
	ItemIDs     []string `json:"itemIds"`
}

type itemJSON struct {
	ID         string        `json:"id"`
	Type       string        `json:"type"`
	Title      string        `json:"title"`
	Summary    string        `json:"summary"`
	Difficulty *string       `json:"difficulty"`
	Tags       []string      `json:"tags"`
	Source     domain.Source `json:"source"`
	VariantOf  *string       `json:"variantOf"`
	Related    []string      `json:"related,omitempty"`
	CreatedAt  time.Time     `json:"createdAt"`
	UpdatedAt  time.Time     `json:"updatedAt"`
	Problem    *problemJSON  `json:"problem,omitempty"`
}

type problemJSON struct {
	TimeLimitMs   int               `json:"timeLimitMs"`
	MemoryLimitKb int               `json:"memoryLimitKb"`
	Compare       string            `json:"compare"`
	Starter       map[string]string `json:"starter"`
	// Format version 2, solution-only problems only.
	Interface string                 `json:"interface,omitempty"`
	Harness   map[string]harnessJSON `json:"harness,omitempty"`
}

// harnessJSON names the files holding one language's runner code.
type harnessJSON struct {
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

type solutionsJSON struct {
	Solutions []solutionJSON `json:"solutions"`
}

type solutionJSON struct {
	Name      string `json:"name"`
	Language  string `json:"language"`
	File      string `json:"file"`
	Notes     string `json:"notes"`
	Reference bool   `json:"reference"`
}

type testsJSON struct {
	Cases []testCaseJSON `json:"cases"`
}

type testCaseJSON struct {
	Name      string             `json:"name"`
	Input     string             `json:"input"`
	Output    string             `json:"output"`
	Sample    bool               `json:"sample"`
	Origin    string             `json:"origin"`
	Verified  bool               `json:"verified"`
	Generator *caseGeneratorJSON `json:"generator,omitempty"`
}

// caseGeneratorJSON names the file holding a test case's generator.
type caseGeneratorJSON struct {
	Language string `json:"language"`
	File     string `json:"file"`
}

func marshalPretty(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func extension(lang string) string {
	if l, ok := domain.LookupLanguage(lang); ok {
		return l.Extension
	}
	return "txt"
}

// Write serialises b as a zip archive to w. Item directories and content
// hashes are computed here.
func Write(w io.Writer, b *Bundle) error {
	zw := zip.NewWriter(w)
	mod := b.Meta.CreatedAt
	if mod.IsZero() {
		mod = time.Now().UTC()
	}
	add := func(name string, data []byte) error {
		f, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: mod})
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	}

	manifest := bundleJSON{
		Format: FormatName, FormatVersion: RequiredVersion(b.Items), Name: b.Meta.Name, Description: b.Meta.Description,
		Author: b.Meta.Author, CreatedAt: mod.UTC().Truncate(time.Second),
		Generator:   generatorJSON{Name: b.Meta.GeneratorName, Version: b.Meta.GeneratorVersion},
		Items:       []itemEntryJSON{},
		Collections: []collectionJSON{},
	}
	if inc := b.Meta.Includes; inc != nil {
		manifest.Includes = &includesJSON{Solutions: inc.Solutions, HiddenTests: inc.HiddenTests}
	}
	used := map[string]bool{}
	type pending struct {
		name string
		data []byte
	}
	var files []pending
	for i := range b.Items {
		it := &b.Items[i]
		hexID := strings.ReplaceAll(it.ID, "-", "")
		if len(hexID) > 8 {
			hexID = hexID[:8]
		}
		dir := "items/" + Slug(it.Title) + "-" + hexID
		for n := 2; used[dir]; n++ {
			dir = fmt.Sprintf("items/%s-%s-%d", Slug(it.Title), hexID, n)
		}
		used[dir] = true
		it.Dir = dir

		ij := itemJSON{
			ID: it.ID, Type: string(it.Type), Title: it.Title, Summary: it.Summary, Tags: it.Tags,
			Source: it.Source, VariantOf: it.VariantOf, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt,
		}
		if len(it.Related) > 0 {
			ij.Related = slices.Sorted(slices.Values(it.Related))
		}
		if ij.Tags == nil {
			ij.Tags = []string{}
		}
		if it.Difficulty != nil {
			d := string(*it.Difficulty)
			ij.Difficulty = &d
		}
		files = append(files, pending{dir + "/body.md", []byte(it.Body)})
		if it.Type == domain.TypeProblem && it.Problem != nil {
			p := it.Problem
			pj := &problemJSON{TimeLimitMs: p.TimeLimitMs, MemoryLimitKb: p.MemoryLimitKb, Compare: string(p.Compare),
				Starter: map[string]string{}}
			for _, lang := range slices.Sorted(maps.Keys(p.StarterCode)) {
				src := p.StarterCode[lang]
				rel := "starter/" + lang + "." + extension(lang)
				pj.Starter[lang] = rel
				files = append(files, pending{dir + "/" + rel, []byte(src)})
			}
			if p.Interface == domain.InterfaceFunction {
				pj.Interface = string(p.Interface)
				pj.Harness = map[string]harnessJSON{}
				for _, lang := range slices.Sorted(maps.Keys(p.Harness)) {
					h := p.Harness[lang]
					ext := extension(lang)
					hj := harnessJSON{Prefix: "harness/" + lang + "-prefix." + ext, Suffix: "harness/" + lang + "-suffix." + ext}
					pj.Harness[lang] = hj
					files = append(files, pending{dir + "/" + hj.Prefix, []byte(h.Prefix)},
						pending{dir + "/" + hj.Suffix, []byte(h.Suffix)})
				}
			}
			if it.SolutionsIncluded {
				// Written even when empty, so that "no solutions" and
				// "exported without solutions" stay distinguishable.
				width := max(2, len(fmt.Sprint(len(it.Solutions))))
				sj := solutionsJSON{Solutions: []solutionJSON{}}
				for n, s := range it.Solutions {
					file := fmt.Sprintf("%0*d-%s.%s", width, n+1, Slug(s.Name), extension(s.Language))
					sj.Solutions = append(sj.Solutions, solutionJSON{Name: s.Name, Language: s.Language, File: file,
						Notes: s.Notes, Reference: s.IsReference})
					files = append(files, pending{dir + "/solutions/" + file, []byte(s.Source)})
				}
				data, err := marshalPretty(sj)
				if err != nil {
					return err
				}
				files = append(files, pending{dir + "/solutions/solutions.json", data})
			}
			ij.Problem = pj
			if len(it.TestCases) > 0 {
				width := max(2, len(fmt.Sprint(len(it.TestCases))))
				tj := testsJSON{Cases: []testCaseJSON{}}
				for n, tc := range it.TestCases {
					base := fmt.Sprintf("%0*d", width, n+1)
					origin := string(tc.Origin)
					if origin == "" {
						origin = string(domain.OriginManual)
					}
					cj := testCaseJSON{Name: tc.Name, Input: base + ".in", Output: base + ".out",
						Sample: tc.IsSample, Origin: origin, Verified: tc.Verified}
					files = append(files, pending{dir + "/tests/" + base + ".in", []byte(tc.Stdin)},
						pending{dir + "/tests/" + base + ".out", []byte(tc.ExpectedStdout)})
					if g := tc.Generator; g != nil {
						cj.Generator = &caseGeneratorJSON{Language: g.Language, File: base + ".gen." + extension(g.Language)}
						files = append(files, pending{dir + "/tests/" + cj.Generator.File, []byte(g.Source)})
					}
					tj.Cases = append(tj.Cases, cj)
				}
				data, err := marshalPretty(tj)
				if err != nil {
					return err
				}
				files = append(files, pending{dir + "/tests/tests.json", data})
			}
		}
		data, err := marshalPretty(ij)
		if err != nil {
			return err
		}
		files = append(files, pending{dir + "/item.json", data})
		manifest.Items = append(manifest.Items, itemEntryJSON{
			ID: it.ID, Path: dir, Type: string(it.Type), Title: it.Title, ContentHash: ContentHash(it),
		})
	}
	for _, c := range b.Collections {
		ids := c.ItemIDs
		if ids == nil {
			ids = []string{}
		}
		manifest.Collections = append(manifest.Collections, collectionJSON{
			ID: c.ID, Name: c.Name, Description: c.Description, ParentID: c.ParentID, Position: c.Position, ItemIDs: ids,
		})
	}
	data, err := marshalPretty(manifest)
	if err != nil {
		return err
	}
	if err := add("bundle.json", data); err != nil {
		return err
	}
	for _, f := range files {
		if err := add(f.name, f.data); err != nil {
			return err
		}
	}
	return zw.Close()
}
