package sqlite

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"codeatrophy/internal/store"
)

// The AI activity log: the index row in ai_log, the compressed request and
// response in ai_log_bodies, and each distinct system text once in
// ai_log_texts.

const aiLogColumns = `id, created_at, operation, item_id, title, provider_id, provider_name, kind, model, status, error,
	duration_ms, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens`

func scanAILogEntry(sc interface{ Scan(...any) error }) (store.AILogEntry, error) {
	var (
		e                                  store.AILogEntry
		itemID, title, errMsg              sql.NullString
		in, out, reasoning, cacheR, cacheW sql.NullInt64
		created                            int64
	)
	if err := sc.Scan(&e.ID, &created, &e.Operation, &itemID, &title, &e.ProviderID, &e.ProviderName, &e.Kind, &e.Model,
		&e.Status, &errMsg, &e.DurationMs, &in, &out, &reasoning, &cacheR, &cacheW); err != nil {
		return e, err
	}
	e.CreatedAt = fromUnix(created)
	e.ItemID, e.Title, e.Error = strPtr(itemID), strPtr(title), strPtr(errMsg)
	e.InputTokens, e.OutputTokens, e.ReasoningTokens = intPtr(in), intPtr(out), intPtr(reasoning)
	e.CacheReadTokens, e.CacheWriteTokens = intPtr(cacheR), intPtr(cacheW)
	return e, nil
}

func (t *tx) InsertAILogEntry(e store.AILogEntry, b store.AILogBody) error {
	if _, err := t.exec(`INSERT INTO ai_log (`+aiLogColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, toUnix(e.CreatedAt), e.Operation, nullStr(e.ItemID), nullStr(e.Title), e.ProviderID, e.ProviderName, e.Kind,
		e.Model, e.Status, nullStr(e.Error), e.DurationMs, nullInt(e.InputTokens), nullInt(e.OutputTokens),
		nullInt(e.ReasoningTokens), nullInt(e.CacheReadTokens), nullInt(e.CacheWriteTokens)); err != nil {
		return err
	}
	var hash any
	if b.System != "" {
		h := store.TextHash(b.System)
		if _, err := t.exec(`INSERT INTO ai_log_texts (hash, text) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING`,
			h, store.CompressText(b.System)); err != nil {
			return err
		}
		hash = h
	}
	var response any
	if b.Response != nil {
		response = store.CompressText(*b.Response)
	}
	_, err := t.exec(`INSERT INTO ai_log_bodies (entry_id, system_hash, request, response, truncated) VALUES (?, ?, ?, ?, ?)`,
		e.ID, hash, store.CompressText(b.Request), response, boolInt(b.Truncated))
	return err
}

func (t *tx) ListAILog(f store.AILogFilter) ([]store.AILogEntry, int, error) {
	where := []string{"TRUE"}
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "?"
	}
	if f.ProviderID != "" {
		where = append(where, "provider_id = "+arg(f.ProviderID))
	}
	if f.Operation != "" {
		where = append(where, "operation = "+arg(f.Operation))
	}
	if f.Status != "" {
		where = append(where, "status = "+arg(f.Status))
	}
	var total int
	if err := t.queryRow(`SELECT COUNT(*) FROM ai_log WHERE `+strings.Join(where, " AND "), args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if c := f.Before; c != nil {
		at := toUnix(c.CreatedAt)
		where = append(where, "(created_at < "+arg(at)+" OR (created_at = "+arg(at)+" AND id < "+arg(c.ID)+"))")
	}
	q := `SELECT ` + aiLogColumns + ` FROM ai_log WHERE ` + strings.Join(where, " AND ") + ` ORDER BY created_at DESC, id DESC`
	if f.Limit > 0 {
		q += " LIMIT " + arg(f.Limit)
	}
	out := []store.AILogEntry{}
	err := t.eachRow(q, args, func(rows *sql.Rows) error {
		e, err := scanAILogEntry(rows)
		out = append(out, e)
		return err
	})
	return out, total, err
}

func (t *tx) GetAILogEntry(id string) (store.AILogEntry, store.AILogBody, error) {
	e, err := scanAILogEntry(t.queryRow(`SELECT `+aiLogColumns+` FROM ai_log WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return e, store.AILogBody{}, store.ErrNotFound
	}
	if err != nil {
		return e, store.AILogBody{}, err
	}
	var (
		b                 store.AILogBody
		system, req, resp []byte
		truncated         int
	)
	err = t.queryRow(`SELECT t.text, b.request, b.response, b.truncated FROM ai_log_bodies b
		LEFT JOIN ai_log_texts t ON t.hash = b.system_hash WHERE b.entry_id = ?`, id).Scan(&system, &req, &resp, &truncated)
	if errors.Is(err, sql.ErrNoRows) {
		return e, b, nil
	}
	if err != nil {
		return e, b, err
	}
	b.Truncated = truncated != 0
	if system != nil {
		if b.System, err = store.DecompressText(system); err != nil {
			return e, b, fmt.Errorf("ai log %s: system text: %w", id, err)
		}
	}
	if b.Request, err = store.DecompressText(req); err != nil {
		return e, b, fmt.Errorf("ai log %s: request: %w", id, err)
	}
	if resp != nil {
		s, err := store.DecompressText(resp)
		if err != nil {
			return e, b, fmt.Errorf("ai log %s: response: %w", id, err)
		}
		b.Response = &s
	}
	return e, b, nil
}

func (t *tx) DeleteAILog(before *time.Time) error {
	cond, args := ``, []any{}
	if before != nil {
		cond, args = ` WHERE created_at < ?`, []any{toUnix(*before)}
	}
	if _, err := t.exec(`DELETE FROM ai_log_bodies WHERE entry_id IN (SELECT id FROM ai_log`+cond+`)`, args...); err != nil {
		return err
	}
	if _, err := t.exec(`DELETE FROM ai_log`+cond, args...); err != nil {
		return err
	}
	_, err := t.exec(`DELETE FROM ai_log_texts WHERE hash NOT IN
		(SELECT system_hash FROM ai_log_bodies WHERE system_hash IS NOT NULL)`)
	return err
}
