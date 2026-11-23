package postgres

import (
	"database/sql"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/internal/sqlrow"
)

const aiProviderColumns = `id, name, kind, model, base_url, api_key, api_key_origin, effort, created_at, updated_at`

func scanAIProvider(sc interface{ Scan(...any) error }) (store.AIProvider, error) {
	var (
		p                store.AIProvider
		effort           sql.NullString
		created, updated int64
	)
	err := sc.Scan(&p.ID, &p.Name, &p.Kind, &p.Model, &p.BaseURL, &p.APIKey, &p.APIKeyOrigin, &effort, &created, &updated)
	p.Effort, p.CreatedAt, p.UpdatedAt = effort.String, sqlrow.FromUnix(created), sqlrow.FromUnix(updated)
	return p, err
}

func (t *tx) ListAIProviders() ([]store.AIProvider, error) {
	rows, err := t.query(`SELECT ` + aiProviderColumns + ` FROM ai_providers ORDER BY name_key, seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.AIProvider{}
	for rows.Next() {
		p, err := scanAIProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (t *tx) GetAIProvider(id string) (store.AIProvider, error) {
	p, err := scanAIProvider(t.queryRow(`SELECT `+aiProviderColumns+` FROM ai_providers WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, store.ErrNotFound
	}
	return p, err
}

func (t *tx) InsertAIProvider(p *store.AIProvider) error {
	_, err := t.exec(`INSERT INTO ai_providers (id, name, name_key, kind, model, base_url, api_key, api_key_origin,
		effort, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, p.ID, p.Name,
		domain.AIProviderNameKey(p.Name), p.Kind, p.Model, p.BaseURL, p.APIKey, p.APIKeyOrigin, sqlrow.EffortArg(p.Effort),
		sqlrow.ToUnix(p.CreatedAt), sqlrow.ToUnix(p.UpdatedAt))
	return err
}

func (t *tx) UpdateAIProvider(p *store.AIProvider) error {
	res, err := t.exec(`UPDATE ai_providers SET name = $1, name_key = $2, model = $3, base_url = $4, api_key = $5,
		api_key_origin = $6, effort = $7, updated_at = $8 WHERE id = $9`, p.Name, domain.AIProviderNameKey(p.Name), p.Model,
		p.BaseURL, p.APIKey, p.APIKeyOrigin, sqlrow.EffortArg(p.Effort), sqlrow.ToUnix(p.UpdatedAt), p.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteAIProvider(id string) error {
	res, err := t.exec(`DELETE FROM ai_providers WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// RecordAIUsage adds one request to its provider's day in a single upsert,
// so concurrent requests add up.
func (t *tx) RecordAIUsage(r store.AIUsageRecord) error {
	failed := 0
	if r.Failed {
		failed = 1
	}
	_, err := t.exec(`INSERT INTO ai_usage (provider_id, day, requests, failed, input_tokens, output_tokens, last_used_at)
		VALUES ($1, $2, 1, $3, $4, $5, $6)
		ON CONFLICT (provider_id, day) DO UPDATE SET requests = ai_usage.requests + 1,
		failed = ai_usage.failed + excluded.failed, input_tokens = ai_usage.input_tokens + excluded.input_tokens,
		output_tokens = ai_usage.output_tokens + excluded.output_tokens,
		last_used_at = GREATEST(ai_usage.last_used_at, excluded.last_used_at)`,
		r.ProviderID, store.UsageDay(r.At), failed, max(r.InputTokens, 0), max(r.OutputTokens, 0), sqlrow.ToUnix(r.At))
	return err
}

func (t *tx) AIUsage(since int64) (map[string]store.AIUsage, error) {
	out := map[string]store.AIUsage{}
	err := t.eachRow(`SELECT provider_id,
		SUM(CASE WHEN day >= $1 THEN requests ELSE 0 END)::bigint, SUM(CASE WHEN day >= $1 THEN failed ELSE 0 END)::bigint,
		SUM(CASE WHEN day >= $1 THEN input_tokens ELSE 0 END)::bigint, SUM(CASE WHEN day >= $1 THEN output_tokens ELSE 0 END)::bigint,
		SUM(requests)::bigint, SUM(failed)::bigint, SUM(input_tokens)::bigint, SUM(output_tokens)::bigint, MAX(last_used_at)
		FROM ai_usage GROUP BY provider_id`, []any{since}, func(rows *sql.Rows) error {
		var (
			id   string
			u    store.AIUsage
			last int64
		)
		if err := rows.Scan(&id, &u.Recent.Requests, &u.Recent.Failed, &u.Recent.InputTokens, &u.Recent.OutputTokens,
			&u.AllTime.Requests, &u.AllTime.Failed, &u.AllTime.InputTokens, &u.AllTime.OutputTokens, &last); err != nil {
			return err
		}
		u.LastUsedAt = sqlrow.FromUnix(last)
		out[id] = u
		return nil
	})
	return out, err
}

func (t *tx) DeleteAIUsage(providerID string) error {
	_, err := t.exec(`DELETE FROM ai_usage WHERE provider_id = $1`, providerID)
	return err
}
