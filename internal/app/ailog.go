package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"time"

	"codeatrophy/internal/store"
)

// AILogUsage is the token counts of an AI log entry, nil where the
// provider reported none.
type AILogUsage struct {
	InputTokens      *int `json:"inputTokens"`
	OutputTokens     *int `json:"outputTokens"`
	ReasoningTokens  *int `json:"reasoningTokens"`
	CacheReadTokens  *int `json:"cacheReadTokens"`
	CacheWriteTokens *int `json:"cacheWriteTokens"`
}

// AILogEntry is one request in the AI activity log.
type AILogEntry struct {
	ID           string     `json:"id"`
	CreatedAt    time.Time  `json:"createdAt"`
	Operation    string     `json:"operation"`
	ItemID       *string    `json:"itemId"`
	Title        *string    `json:"title"`
	ProviderID   string     `json:"providerId"`
	ProviderName string     `json:"providerName"`
	Kind         string     `json:"kind"`
	Model        string     `json:"model"`
	Status       string     `json:"status"`
	Error        *string    `json:"error"`
	DurationMs   int        `json:"durationMs"`
	Usage        AILogUsage `json:"usage"`
}

// AILogDetail is an entry with what was sent and what came back.
type AILogDetail struct {
	AILogEntry
	Request   json.RawMessage `json:"request"`
	Response  *string         `json:"response"`
	Truncated bool            `json:"truncated"`
}

// AILogQuery filters and pages the AI log.
type AILogQuery struct {
	ProviderID, Operation, Status string
	// Before is a cursor from an earlier page's Next.
	Before string
	Limit  *int
}

// AILogPage is one page of the AI log, newest first.
type AILogPage struct {
	Items []AILogEntry `json:"items"`
	// Next is the cursor of the following page, nil at the end.
	Next  *string `json:"next"`
	Total int     `json:"total"`
}

var (
	logOperations = []string{"draft", "variant", "testcases", "code", "test"}
	logStatuses   = []string{"ok", "failed", "cancelled"}
)

func logEntryView(e store.AILogEntry) AILogEntry {
	return AILogEntry{ID: e.ID, CreatedAt: e.CreatedAt, Operation: e.Operation, ItemID: e.ItemID, Title: e.Title,
		ProviderID: e.ProviderID, ProviderName: e.ProviderName, Kind: e.Kind, Model: e.Model, Status: e.Status,
		Error: e.Error, DurationMs: e.DurationMs, Usage: AILogUsage{InputTokens: e.InputTokens, OutputTokens: e.OutputTokens,
			ReasoningTokens: e.ReasoningTokens, CacheReadTokens: e.CacheReadTokens, CacheWriteTokens: e.CacheWriteTokens}}
}

// A cursor is the position of the last entry of a page, (created time, id),
// encoded so that clients treat it as opaque.
func encodeLogCursor(e store.AILogEntry) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(e.CreatedAt.Unix(), 10) + "." + e.ID))
}

func decodeLogCursor(s string) (*store.AILogCursor, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, false
	}
	sec, id, ok := strings.Cut(string(raw), ".")
	n, err := strconv.ParseInt(sec, 10, 64)
	if !ok || err != nil || id == "" || n < 0 {
		return nil, false
	}
	return &store.AILogCursor{CreatedAt: time.Unix(n, 0).UTC(), ID: id}, true
}

// ListAILog returns a page of the AI log, newest first, without bodies.
func (a *App) ListAILog(ctx context.Context, q AILogQuery) (AILogPage, error) {
	f := store.AILogFilter{ProviderID: q.ProviderID, Operation: q.Operation, Status: q.Status}
	if f.Operation != "" && !slices.Contains(logOperations, f.Operation) {
		return AILogPage{}, errBadRequest("operation must be one of %s", strings.Join(logOperations, ", "))
	}
	if f.Status != "" && !slices.Contains(logStatuses, f.Status) {
		return AILogPage{}, errBadRequest("status must be one of %s", strings.Join(logStatuses, ", "))
	}
	if q.Before != "" {
		c, ok := decodeLogCursor(q.Before)
		if !ok {
			return AILogPage{}, errBadRequest("before is not a cursor from this log")
		}
		f.Before = c
	}
	limit, _, err := pageBounds(q.Limit, 0)
	if err != nil {
		return AILogPage{}, err
	}
	// One more than a page says whether there is a next one.
	f.Limit = limit + 1
	out := AILogPage{Items: []AILogEntry{}}
	err = a.store.Read(ctx, func(tx store.Tx) error {
		entries, total, err := tx.ListAILog(f)
		if err != nil {
			return err
		}
		out.Total = total
		if len(entries) > limit {
			entries = entries[:limit]
			next := encodeLogCursor(entries[limit-1])
			out.Next = &next
		}
		for _, e := range entries {
			out.Items = append(out.Items, logEntryView(e))
		}
		return nil
	})
	return out, err
}

// GetAILogEntry returns one entry with its request and response.
func (a *App) GetAILogEntry(ctx context.Context, id string) (AILogDetail, error) {
	var out AILogDetail
	err := a.store.Read(ctx, func(tx store.Tx) error {
		e, b, err := tx.GetAILogEntry(id)
		if err != nil {
			return notFoundAs(err, "AI log entry")
		}
		var r logRequest
		_ = json.Unmarshal([]byte(b.Request), &r)
		full, _ := json.Marshal(struct {
			System string `json:"system"`
			logRequest
		}{b.System, r})
		out = AILogDetail{AILogEntry: logEntryView(e), Request: full, Response: b.Response, Truncated: b.Truncated}
		return nil
	})
	return out, err
}

// DeleteAILog removes every entry of the AI log, or those created before a
// timestamp (RFC 3339). Provider usage counts are not affected.
func (a *App) DeleteAILog(ctx context.Context, before string) error {
	var at *time.Time
	if before != "" {
		t, err := time.Parse(time.RFC3339, before)
		if err != nil {
			return errBadRequest("before must be an RFC 3339 timestamp")
		}
		at = &t
	}
	return a.store.Write(ctx, func(tx store.Tx) error { return tx.DeleteAILog(at) })
}
