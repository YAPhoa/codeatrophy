package sqlite

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"codeatrophy/internal/store"
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
		edited                                int
	)
	dest := append([]any{&d.ID, &created, &updated, &d.Kind, &variantOf, &d.Title, &clientTitle, &d.Revision, &edited,
		&jobID, &errMsg, &d.GenerationSeq, &d.BasedOn, &d.UserID}, extra...)
	if err := sc.Scan(dest...); err != nil {
		return d, err
	}
	d.CreatedAt, d.UpdatedAt, d.Edited = fromUnix(created), fromUnix(updated), edited != 0
	d.VariantOf, d.ClientTitle, d.JobID, d.Error = strPtr(variantOf), strPtr(clientTitle), strPtr(jobID), strPtr(errMsg)
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
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, toUnix(d.CreatedAt), toUnix(d.UpdatedAt), d.Kind, nullStr(d.VariantOf), d.Title, nullStr(d.ClientTitle),
		d.Revision, boolInt(d.Edited), nullStr(d.JobID), nullStr(d.Error), d.GenerationSeq, d.BasedOn,
		d.UserID, compressedOrNil(d.Request), compressedOrNil(d.Generation), compressedOrNil(d.Content))
	return err
}

func (t *tx) GetDraft(id string) (store.Draft, error) {
	var req, gen, content []byte
	d, err := scanDraft(t.queryRow(`SELECT `+draftColumns+`, request, generation, content FROM drafts WHERE id = ?`, id),
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
	where := []string{"user_id = ?"}
	args := []any{f.UserID}
	if f.Kind != "" {
		where, args = append(where, "kind = ?"), append(args, f.Kind)
	}
	if f.VariantOf != "" {
		where, args = append(where, "variant_of = ?"), append(args, f.VariantOf)
	}
	out := []store.Draft{}
	err := t.eachRow(`SELECT `+draftColumns+` FROM drafts WHERE `+strings.Join(where, " AND ")+
		` ORDER BY updated_at DESC, id DESC`, args, func(rows *sql.Rows) error {
		d, err := scanDraft(rows)
		out = append(out, d)
		return err
	})
	return out, err
}

func (t *tx) UpdateDraft(d *store.Draft) error {
	res, err := t.exec(`UPDATE drafts SET updated_at = ?, variant_of = ?, title = ?, client_title = ?, revision = ?,
		edited = ?, request = ?, job_id = ?, error = ?, generation = ?, generation_seq = ?, content = ?, based_on = ?
		WHERE id = ?`,
		toUnix(d.UpdatedAt), nullStr(d.VariantOf), d.Title, nullStr(d.ClientTitle), d.Revision, boolInt(d.Edited),
		compressedOrNil(d.Request), nullStr(d.JobID), nullStr(d.Error), compressedOrNil(d.Generation), d.GenerationSeq,
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
	res, err := t.exec(`DELETE FROM drafts WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
