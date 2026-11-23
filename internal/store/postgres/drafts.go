package postgres

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/internal/sqlrow"
)

// Drafts: one row each in drafts, the request, the generation and the
// content compressed.

const draftColumns = `id, created_at, updated_at, kind, variant_of, title, client_title, revision, edited, job_id, error,
	generation_seq, based_on, user_id`

func scanDraft(sc interface{ Scan(...any) error }, extra ...any) (store.Draft, error) {
	var (
		d                                     store.Draft
		variantOf, clientTitle, jobID, errMsg sql.NullString
		created, updated                      int64
	)
	dest := append([]any{&d.ID, &created, &updated, &d.Kind, &variantOf, &d.Title, &clientTitle, &d.Revision, &d.Edited,
		&jobID, &errMsg, &d.GenerationSeq, &d.BasedOn, &d.UserID}, extra...)
	if err := sc.Scan(dest...); err != nil {
		return d, err
	}
	d.CreatedAt, d.UpdatedAt = sqlrow.FromUnix(created), sqlrow.FromUnix(updated)
	d.VariantOf, d.ClientTitle, d.JobID, d.Error = sqlrow.StrPtr(variantOf), sqlrow.StrPtr(clientTitle), sqlrow.StrPtr(jobID), sqlrow.StrPtr(errMsg)
	return d, nil
}

func decompressedOrNil(b []byte, id, what string) (*string, error) {
	if b == nil {
		return nil, nil
	}
	s, err := store.DecompressText(b)
	if err != nil {
		return nil, fmt.Errorf("draft %s: %s: %w", id, what, err)
	}
	return &s, nil
}

func (t *tx) InsertDraft(d *store.Draft) error {
	_, err := t.exec(`INSERT INTO drafts (`+draftColumns+`, request, generation, content)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
		d.ID, sqlrow.ToUnix(d.CreatedAt), sqlrow.ToUnix(d.UpdatedAt), d.Kind, sqlrow.NullStr(d.VariantOf), text(d.Title), nullText(d.ClientTitle),
		d.Revision, d.Edited, sqlrow.NullStr(d.JobID), nullText(d.Error), d.GenerationSeq, d.BasedOn,
		d.UserID, compressedOrNil(d.Request), compressedOrNil(d.Generation), compressedOrNil(d.Content))
	return err
}

func (t *tx) GetDraft(id string) (store.Draft, error) {
	var req, gen, content []byte
	d, err := scanDraft(t.queryRow(`SELECT `+draftColumns+`, request, generation, content FROM drafts WHERE id = $1`, id),
		&req, &gen, &content)
	if errors.Is(err, sql.ErrNoRows) {
		return d, store.ErrNotFound
	}
	if err != nil {
		return d, err
	}
	if d.Request, err = decompressedOrNil(req, id, "request"); err != nil {
		return d, err
	}
	if d.Generation, err = decompressedOrNil(gen, id, "generation"); err != nil {
		return d, err
	}
	d.Content, err = decompressedOrNil(content, id, "content")
	return d, err
}

func (t *tx) ListDrafts(f store.DraftFilter) ([]store.Draft, error) {
	var p params
	where := []string{"user_id = " + p.add(f.UserID)}
	if f.Kind != "" {
		where = append(where, "kind = "+p.add(f.Kind))
	}
	if f.VariantOf != "" {
		where = append(where, "variant_of = "+p.add(f.VariantOf))
	}
	out := []store.Draft{}
	err := t.eachRow(`SELECT `+draftColumns+` FROM drafts WHERE `+strings.Join(where, " AND ")+
		` ORDER BY updated_at DESC, id DESC`, p.args, func(rows *sql.Rows) error {
		d, err := scanDraft(rows)
		out = append(out, d)
		return err
	})
	return out, err
}

func (t *tx) UpdateDraft(d *store.Draft) error {
	res, err := t.exec(`UPDATE drafts SET updated_at = $1, variant_of = $2, title = $3, client_title = $4, revision = $5,
		edited = $6, request = $7, job_id = $8, error = $9, generation = $10, generation_seq = $11, content = $12,
		based_on = $13 WHERE id = $14`,
		sqlrow.ToUnix(d.UpdatedAt), sqlrow.NullStr(d.VariantOf), text(d.Title), nullText(d.ClientTitle), d.Revision, d.Edited,
		compressedOrNil(d.Request), sqlrow.NullStr(d.JobID), nullText(d.Error), compressedOrNil(d.Generation), d.GenerationSeq,
		compressedOrNil(d.Content), d.BasedOn, d.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteDraft(id string) (bool, error) {
	res, err := t.exec(`DELETE FROM drafts WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
