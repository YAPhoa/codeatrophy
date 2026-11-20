package bundle

import (
	"archive/zip"
	"bytes"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"codeatrophy/internal/domain"
)

// testdata/v1 and testdata/v2 are bundles written by hand from
// docs/bundle-format.md, kept unzipped so they can be read and edited.

const (
	fxTwoSumID = "0193b2f0-1111-7000-8000-000000000001"
	fxCapID    = "0193b2f4-1111-7000-8000-000000000002"
	fxDPID     = "0193b2f1-1111-7000-8000-000000000001"
	fxWarmUpID = "0193b2f1-1111-7000-8000-000000000002"
	fxAddID    = "0193b2f0-2222-7000-8000-000000000001"

	// The fixtures' content hashes, computed from the canonical content
	// document as docs/bundle-format.md defines it, not with ContentHash.
	fxTwoSumHash = "sha256:716b292d0ce477ac811e275d7642678ba8b1f4093efd22df72884ee3f10f5975"
	fxCapHash    = "sha256:63a2a07ae67bd8df0baba22d130d7d8b57f1ec87796a207e8230c568c4815625"
	fxAddHash    = "sha256:603edc49d6bac5e0683d718f3af6d82ebd1562489c7dbd28db4742546871ccac"
)

func ptr[T any](v T) *T { return &v }

// zipDir zips a directory of testdata into a bundle archive.
func zipDir(t *testing.T, dir string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		w, err := zw.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// v1Fixture is testdata/v1 as Read returns it.
func v1Fixture() *Bundle {
	dp := fxDPID
	return &Bundle{
		Meta: Meta{Name: "Hand-written v1", Description: "Written by hand from docs/bundle-format.md.", Author: "tests",
			FormatVersion: 1, CreatedAt: time.Date(2026, 1, 31, 12, 0, 0, 0, time.UTC),
			GeneratorName: "hand", GeneratorVersion: "1.0", Includes: &Includes{Solutions: true, HiddenTests: true}},
		Items: []Item{
			{
				ID: fxTwoSumID, Type: domain.TypeProblem, Title: "Two Sum",
				Summary: "Find two indices whose values add up to a target.", Difficulty: ptr(domain.DifficultyEasy),
				Tags: []string{"array", "hash-map"}, Source: domain.Source{URL: ptr("https://example.com/two-sum")},
				CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
				Body: "## Problem\n\nGiven `nums` and `target`, print two indices.\n",
				Problem: &Problem{TimeLimitMs: 2000, MemoryLimitKb: 262144, Compare: domain.CompareExact,
					StarterCode: map[string]string{"python": "import sys\n", "cpp": "#include <iostream>\nint main() {}\n"},
					Interface:   domain.InterfaceProgram, Harness: map[string]domain.HarnessCode{}},
				TestCases: []TestCase{
					{Name: "Example 1", Stdin: "4\n2 7 11 15\n9\n", ExpectedStdout: "0 1\n", IsSample: true, Origin: domain.OriginManual, Verified: true},
					{Name: "Large", Stdin: "2\n1 2\n3", ExpectedStdout: "0 1", Origin: domain.OriginAI},
				},
				// The language comes from solutions.json, not from the
				// file's .txt extension.
				Solutions: []Solution{
					{Name: "Hash map, one pass", Language: "python", Source: "print(0, 1)\n", Notes: "O(n) time, O(n) space.", IsReference: true},
					{Name: "Brute force", Language: "cpp", Source: "int main() { return 0; }\n"},
				},
				SolutionsIncluded: true, HiddenTestsIncluded: true,
				StoredHash: fxTwoSumHash, Dir: "items/two-sum",
			},
			{
				ID: fxCapID, Type: domain.TypeReading, Title: "CAP theorem notes", Tags: []string{},
				Source: domain.Source{Note: ptr("From a lecture.")}, VariantOf: ptr(fxTwoSumID),
				CreatedAt: time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC),
				Body:       "# CAP\n\nPick two.\n",
				StoredHash: fxCapHash, Dir: "items/cap-notes",
			},
		},
		Collections: []Collection{
			{ID: fxDPID, Name: "Dynamic Programming", Description: "Bottom-up first.", ItemIDs: []string{fxTwoSumID}},
			{ID: fxWarmUpID, Name: "Warm-up", ParentID: &dp, Position: 1, ItemIDs: []string{fxCapID, fxTwoSumID}},
		},
	}
}

// v2Fixture is testdata/v2 as Read returns it. It has no includes, so what
// it carries is inferred from its files: no solutions.json, so no solutions;
// a case with sample false, so hidden tests.
func v2Fixture() *Bundle {
	return &Bundle{
		Meta: Meta{Name: "Hand-written v2", FormatVersion: 2, CreatedAt: time.Date(2026, 2, 1, 8, 30, 0, 0, time.UTC),
			GeneratorName: "hand", GeneratorVersion: "2.0"},
		Items: []Item{{
			ID: fxAddID, Type: domain.TypeProblem, Title: "Add two numbers", Difficulty: ptr(domain.DifficultyMedium),
			Tags: []string{"math"}, CreatedAt: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
			Body: "Write `add(a, b)`.\n",
			Problem: &Problem{TimeLimitMs: 1000, MemoryLimitKb: 65536, Compare: domain.CompareTokens,
				StarterCode: map[string]string{"python": "def add(a: int, b: int) -> int:\n    "},
				Interface:   domain.InterfaceFunction,
				// An empty path is an empty part.
				Harness: map[string]domain.HarnessCode{"python": {Prefix: "import sys\n\n", Suffix: ""}}},
			TestCases: []TestCase{
				{Name: "", Stdin: "1 2\n", ExpectedStdout: "3\n", IsSample: true, Origin: domain.OriginManual},
				{Name: "hidden", Stdin: "40 2\n", ExpectedStdout: "42\n", Origin: domain.OriginImport, Verified: true},
			},
			HiddenTestsIncluded: true,
			StoredHash:          fxAddHash, Dir: "items/add",
		}},
	}
}

func checkBundle(t *testing.T, got, want *Bundle) {
	t.Helper()
	if !reflect.DeepEqual(got.Meta, want.Meta) {
		t.Errorf("meta:\n got %+v\nwant %+v", got.Meta, want.Meta)
	}
	if len(got.Items) != len(want.Items) {
		t.Fatalf("%d items, want %d", len(got.Items), len(want.Items))
	}
	for i := range want.Items {
		g, w := got.Items[i], want.Items[i]
		if !reflect.DeepEqual(g, w) {
			t.Errorf("item %s:\n got %+v\nwant %+v", w.ID, g, w)
			if g.Problem != nil && w.Problem != nil && !reflect.DeepEqual(*g.Problem, *w.Problem) {
				t.Errorf("item %s problem:\n got %+v\nwant %+v", w.ID, *g.Problem, *w.Problem)
			}
		}
		if h := ContentHash(&g); h != w.StoredHash {
			t.Errorf("item %s: content hash %s, want %s", w.ID, h, w.StoredHash)
		}
	}
	if !reflect.DeepEqual(got.Collections, want.Collections) {
		t.Errorf("collections:\n got %+v\nwant %+v", got.Collections, want.Collections)
	}
}

func TestReadHandWrittenBundles(t *testing.T) {
	for dir, want := range map[string]*Bundle{"testdata/v1": v1Fixture(), "testdata/v2": v2Fixture()} {
		t.Run(dir, func(t *testing.T) {
			got, warnings, err := Read(zipDir(t, dir), lim)
			if err != nil {
				t.Fatal(err)
			}
			// Unknown files and fields are ignored without a warning, and
			// the stored hashes match.
			if len(warnings) != 0 {
				t.Errorf("warnings: %v", warnings)
			}
			checkBundle(t, got, want)
		})
	}
}

// zipFile returns one file of an archive.
func zipFile(t *testing.T, data []byte, name string) string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if f.Name == name {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			return string(b)
		}
	}
	t.Fatalf("%s not in the archive", name)
	return ""
}

// Write's output is pinned byte for byte, so a change to the files it
// produces is a deliberate one.
func TestWriteProducesExactFiles(t *testing.T) {
	data := write(t, v1Fixture())
	if got := zipFile(t, data, "bundle.json"); got != writtenBundleJSON {
		t.Errorf("bundle.json:\n%s\nwant\n%s", got, writtenBundleJSON)
	}
	if got := zipFile(t, data, "items/two-sum-0193b2f0/item.json"); got != writtenTwoSumItemJSON {
		t.Errorf("item.json:\n%s\nwant\n%s", got, writtenTwoSumItemJSON)
	}
	if got := zipFile(t, write(t, v2Fixture()), "items/add-two-numbers-0193b2f0/item.json"); got != writtenAddItemJSON {
		t.Errorf("version 2 item.json:\n%s\nwant\n%s", got, writtenAddItemJSON)
	}

	// What Write produces reads back as the same bundle, in its own
	// directories.
	for name, want := range map[string]*Bundle{"v1": v1Fixture(), "v2": v2Fixture()} {
		got, warnings, err := Read(write(t, want), lim)
		if err != nil || len(warnings) != 0 {
			t.Fatalf("%s: %v %v", name, err, warnings)
		}
		for i := range want.Items {
			want.Items[i].Dir = got.Items[i].Dir
		}
		checkBundle(t, got, want)
	}
}

const writtenBundleJSON = `{
  "format": "codeatrophy.bundle",
  "formatVersion": 1,
  "name": "Hand-written v1",
  "description": "Written by hand from docs/bundle-format.md.",
  "author": "tests",
  "createdAt": "2026-01-31T12:00:00Z",
  "generator": {
    "name": "hand",
    "version": "1.0"
  },
  "includes": {
    "solutions": true,
    "hiddenTests": true
  },
  "items": [
    {
      "id": "0193b2f0-1111-7000-8000-000000000001",
      "path": "items/two-sum-0193b2f0",
      "type": "problem",
      "title": "Two Sum",
      "contentHash": "` + fxTwoSumHash + `"
    },
    {
      "id": "0193b2f4-1111-7000-8000-000000000002",
      "path": "items/cap-theorem-notes-0193b2f4",
      "type": "reading",
      "title": "CAP theorem notes",
      "contentHash": "` + fxCapHash + `"
    }
  ],
  "collections": [
    {
      "id": "0193b2f1-1111-7000-8000-000000000001",
      "name": "Dynamic Programming",
      "description": "Bottom-up first.",
      "parentId": null,
      "position": 0,
      "itemIds": [
        "0193b2f0-1111-7000-8000-000000000001"
      ]
    },
    {
      "id": "0193b2f1-1111-7000-8000-000000000002",
      "name": "Warm-up",
      "description": "",
      "parentId": "0193b2f1-1111-7000-8000-000000000001",
      "position": 1,
      "itemIds": [
        "0193b2f4-1111-7000-8000-000000000002",
        "0193b2f0-1111-7000-8000-000000000001"
      ]
    }
  ]
}
`

const writtenTwoSumItemJSON = `{
  "id": "0193b2f0-1111-7000-8000-000000000001",
  "type": "problem",
  "title": "Two Sum",
  "summary": "Find two indices whose values add up to a target.",
  "difficulty": "easy",
  "tags": [
    "array",
    "hash-map"
  ],
  "source": {
    "url": "https://example.com/two-sum",
    "note": null
  },
  "variantOf": null,
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-02T03:04:05Z",
  "problem": {
    "timeLimitMs": 2000,
    "memoryLimitKb": 262144,
    "compare": "exact",
    "starter": {
      "cpp": "starter/cpp.cpp",
      "python": "starter/python.py"
    }
  }
}
`

const writtenAddItemJSON = `{
  "id": "0193b2f0-2222-7000-8000-000000000001",
  "type": "problem",
  "title": "Add two numbers",
  "summary": "",
  "difficulty": "medium",
  "tags": [
    "math"
  ],
  "source": {
    "url": null,
    "note": null
  },
  "variantOf": null,
  "createdAt": "2026-02-01T00:00:00Z",
  "updatedAt": "2026-02-01T00:00:00Z",
  "problem": {
    "timeLimitMs": 1000,
    "memoryLimitKb": 65536,
    "compare": "tokens",
    "starter": {
      "python": "starter/python.py"
    },
    "interface": "function",
    "harness": {
      "python": {
        "prefix": "harness/python-prefix.py",
        "suffix": "harness/python-suffix.py"
      }
    }
  }
}
`
