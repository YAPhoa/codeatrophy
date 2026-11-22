package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Usage is what one generation cost, as the provider reported it. Counts
// are nil where the provider reported none.
type Usage struct {
	// LogID is the request's entry in the AI log, nil if it could not be
	// written.
	LogID            *string `json:"logId"`
	Model            string  `json:"model"`
	DurationMs       int     `json:"durationMs"`
	InputTokens      *int    `json:"inputTokens"`
	OutputTokens     *int    `json:"outputTokens"`
	ReasoningTokens  *int    `json:"reasoningTokens"`
	CacheReadTokens  *int    `json:"cacheReadTokens"`
	CacheWriteTokens *int    `json:"cacheWriteTokens"`
}

// UsageTotals sums a provider's requests over a period.
type UsageTotals struct {
	Requests     int64 `json:"requests"`
	Failed       int64 `json:"failed"`
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
}

// ProviderUsage is what an AI provider has been used for on this instance.
type ProviderUsage struct {
	Last30Days UsageTotals `json:"last30Days"`
	AllTime    UsageTotals `json:"allTime"`
	LastUsedAt *time.Time  `json:"lastUsedAt"`
}

// usageWindowDays is the length of the recent window, counting today.
const usageWindowDays = 30

// Bounds of the AI log.
const (
	// maxLogTextBytes cuts a logged request (its texts) and response.
	maxLogTextBytes = 256 << 10
	// logWriteTimeout bounds the write that ends a generation; it runs even
	// when the request was cancelled.
	logWriteTimeout = 5 * time.Second
)

// activeProvider is a provider ready for a request, with what accounting
// needs to know about it.
type activeProvider struct {
	ai.Provider
	id     string // "" for a configuration that is not saved: not accounted
	name   string
	kind   string
	secret string
	effort string // the provider's effort level, sent with every request
}

// logSubject says what a generation is about, for its log entry. The use
// callback of generate may fill in Title from the answer.
type logSubject struct {
	ItemID *string
	Title  *string
}

// generate sends one request to a provider, hands the answer to use, and
// accounts for it in one place. When the request ends — answered, failed,
// cancelled, or answered with something use cannot use — it is added to
// the provider's usage counts (as failed unless it was used) and written
// to the AI log with its content, and one line goes to the server's log
// with the figures only. A retry inside a provider adapter is part of the
// one request; its figures are those of the call that answered. A
// provider error is returned as an upstream error, an error from use as it
// is. Accounting never fails the request: a failed write is logged and the
// usage carries no log id.
func (a *App) generate(ctx context.Context, op string, p activeProvider, subject *logSubject, req ai.GenerateRequest,
	use func(raw json.RawMessage) error) (Usage, error) {
	req.Effort = p.effort
	start := time.Now()
	resp, err := p.Generate(ctx, req)
	u := Usage{Model: resp.Model, DurationMs: int(time.Since(start).Milliseconds()),
		InputTokens: resp.InputTokens, OutputTokens: resp.OutputTokens, ReasoningTokens: resp.ReasoningTokens,
		CacheReadTokens: resp.CacheReadTokens, CacheWriteTokens: resp.CacheWriteTokens}
	if u.Model == "" {
		u.Model = p.Model()
	}
	if err != nil {
		err = errUpstream(err, p.secret)
	} else if use != nil {
		err = use(resp.JSON)
	}
	status := "ok"
	switch {
	case err != nil && errors.Is(ctx.Err(), context.Canceled):
		status = "cancelled"
	case err != nil:
		status = "failed"
	}
	attrs := []any{"operation", op, "provider", p.id, "kind", p.kind, "model", u.Model, "status", status,
		"durationMs", u.DurationMs, "inputTokens", tokens(u.InputTokens), "outputTokens", tokens(u.OutputTokens),
		"reasoningTokens", tokens(u.ReasoningTokens), "cacheReadTokens", tokens(u.CacheReadTokens),
		"cacheWriteTokens", tokens(u.CacheWriteTokens)}
	if err != nil {
		attrs = append(attrs, "error", AsError(err).Message)
	}
	a.log.Info("AI generation", attrs...)
	if p.id != "" {
		u.LogID = a.account(accountOf(ctx), op, p, subject, req, resp, u, status, err)
	}
	return u, err
}

func tokens(n *int) any {
	if n == nil {
		return "unknown"
	}
	return *n
}

func sum(ns ...*int) int64 {
	var t int64
	for _, n := range ns {
		if n != nil {
			t += int64(*n)
		}
	}
	return t
}

// account writes a finished request to its provider's counts and to the AI
// log of the account it was made for, in one transaction, and returns the
// log entry's id.
func (a *App) account(userID, op string, p activeProvider, subject *logSubject, req ai.GenerateRequest, resp ai.GenerateResponse,
	u Usage, status string, failure error) *string {
	now := a.clock()
	e := store.AILogEntry{ID: newID(), UserID: userID, CreatedAt: now, Operation: op, ProviderID: p.id, ProviderName: p.name, Kind: p.kind,
		Model: u.Model, Status: status, DurationMs: u.DurationMs, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
		ReasoningTokens: u.ReasoningTokens, CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens}
	if subject != nil {
		e.ItemID, e.Title = subject.ItemID, subject.Title
	}
	if failure != nil {
		msg := AsError(failure).Message
		e.Error = &msg
	}
	body := logBody(req, p.kind)
	if resp.Text != "" {
		text := domain.Truncate(resp.Text, maxLogTextBytes)
		body.Response, body.Truncated = &text, body.Truncated || len(text) < len(resp.Text)
	}
	// The counts take every input token the service processed, cached or
	// not.
	rec := store.AIUsageRecord{ProviderID: p.id, At: now, Failed: status != "ok",
		InputTokens:  sum(u.InputTokens, u.CacheReadTokens, u.CacheWriteTokens),
		OutputTokens: sum(u.OutputTokens)}
	ctx, cancel := context.WithTimeout(context.Background(), logWriteTimeout)
	defer cancel()
	err := a.store.Write(ctx, func(tx store.Tx) error {
		// The counts belong to the provider entry; the log outlives it.
		counted := isEnvProviderID(p.id)
		if !counted {
			_, err := tx.GetAIProvider(p.id)
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				return err
			}
			counted = err == nil
		}
		if counted {
			if err := tx.RecordAIUsage(rec); err != nil {
				return err
			}
		}
		return tx.InsertAILogEntry(e, body)
	})
	if err != nil {
		a.log.Warn("could not record an AI request", "provider", p.id, "operation", op, "error", err)
		return nil
	}
	return &e.ID
}

// logRequest is the per-request part of what the log shows of a request;
// the system text is stored apart (see logBody).
type logRequest struct {
	Messages        []logMessage `json:"messages"`
	Schema          string       `json:"schema"`
	MaxOutputTokens *int         `json:"maxOutputTokens"`
	Effort          *string      `json:"effort"`
}

type logMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// logBody is what the log keeps of a request to a provider of the kind:
// what the server asked for, built from the provider-neutral request (so no
// key, header or provider envelope can get in), with its texts cut to fit.
func logBody(req ai.GenerateRequest, kind string) store.AILogBody {
	system, user := req.System, req.User
	b := store.AILogBody{}
	if budget := maxLogTextBytes; len(system)+len(user) > budget {
		b.Truncated = true
		keepSystem := min(len(system), budget/2)
		keepUser := min(len(user), budget-keepSystem)
		system, user = domain.Truncate(system, budget-keepUser), domain.Truncate(user, keepUser)
	}
	r := logRequest{Messages: []logMessage{{Role: "user", Content: user}}, Schema: req.SchemaName}
	if req.MaxOutputTokens > 0 {
		r.MaxOutputTokens = &req.MaxOutputTokens
	}
	// The effort asked for: the provider's level, except that a light
	// request to Anthropic asks for low.
	effort := req.Effort
	if req.Light && kind == ai.ProviderAnthropic {
		effort = ai.EffortLow
	}
	r.Effort = strPtrOrNil(effort)
	raw, _ := json.Marshal(r)
	b.System, b.Request = system, string(raw)
	return b
}

// providerUsage reads every provider's usage for the views.
func (a *App) providerUsage(tx store.Tx) (map[string]store.AIUsage, error) {
	return tx.AIUsage(store.UsageDay(a.clock()) - (usageWindowDays - 1))
}

func usageView(u store.AIUsage, ok bool) ProviderUsage {
	if !ok {
		return ProviderUsage{}
	}
	t := func(s store.AIUsageTotals) UsageTotals {
		return UsageTotals{Requests: s.Requests, Failed: s.Failed, InputTokens: s.InputTokens, OutputTokens: s.OutputTokens}
	}
	last := u.LastUsedAt.UTC()
	return ProviderUsage{Last30Days: t(u.Recent), AllTime: t(u.AllTime), LastUsedAt: &last}
}
