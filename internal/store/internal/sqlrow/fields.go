package sqlrow

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Column values of the domain's optional and composite fields, which both
// stores store the same way.

// SourceArgs are the via, client and model columns of a change source, all
// NULL for an unknown one.
func SourceArgs(c *domain.ChangeSource) []any {
	if c == nil {
		return []any{nil, nil, nil}
	}
	return []any{c.Via, NullStr(c.Client), NullStr(c.Model)}
}

// ChangeSource reads a change source from its columns: nil when via is
// NULL, whatever the others hold.
func ChangeSource(via, client, model sql.NullString) *domain.ChangeSource {
	if !via.Valid {
		return nil
	}
	return &domain.ChangeSource{Via: via.String, Client: StrPtr(client), Model: StrPtr(model)}
}

// GeneratorOf reads a test case's generator columns.
func GeneratorOf(lang, src sql.NullString) *domain.GeneratorSpec {
	if !lang.Valid || !src.Valid {
		return nil
	}
	return &domain.GeneratorSpec{Language: lang.String, Source: src.String}
}

// LastRunArgs are the values of the last_run_* columns, in column order.
func LastRunArgs(r *domain.SolutionRun) []any {
	if r == nil {
		return []any{nil, nil, nil, nil, nil}
	}
	return []any{r.Passed, r.Total, NullInt(r.TimeMs), NullInt(r.MemoryKb), ToUnix(r.RanAt)}
}

// HarnessArg is the column value of a submission's harness: JSON, or NULL.
func HarnessArg(h *domain.HarnessCode) any {
	if h == nil {
		return nil
	}
	b, _ := json.Marshal(h)
	return string(b)
}

// VerdictArg is the column value of an optional verdict.
func VerdictArg(v *domain.Verdict) any {
	if v == nil {
		return nil
	}
	return string(*v)
}

// EffortArg stores the model's default effort, "", as NULL.
func EffortArg(effort string) any {
	if effort == "" {
		return nil
	}
	return effort
}

// CompressedOrNil is the column value of optional text kept compressed.
func CompressedOrNil(p *string) any {
	if p == nil {
		return nil
	}
	return store.CompressText(*p)
}

// DecompressedOrNil reads optional compressed text of draft id; what names
// the column in an error.
func DecompressedOrNil(b []byte, id, what string) (*string, error) {
	if b == nil {
		return nil, nil
	}
	s, err := store.DecompressText(b)
	if err != nil {
		return nil, fmt.Errorf("draft %s: %s: %w", id, what, err)
	}
	return &s, nil
}
