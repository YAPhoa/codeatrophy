package postgres

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

const itemColumns = `i.seq, i.id, i.type, i.title, i.summary, i.body, i.difficulty, i.status, i.favorite, i.notes,
	i.raw_input, i.source_url, i.source_note, i.variant_of, i.revision, i.time_limit_ms, i.memory_limit_kb,
	i.compare_mode, i.starter_code, i.problem_interface, i.harness, i.created_at, i.updated_at`

type itemRow struct {
	seq  int64
	item domain.Item
}

func scanItem(sc interface{ Scan(...any) error }) (itemRow, error) {
	var (
		r                                     itemRow
		it                                    = &r.item
		difficulty, rawInput, srcURL, srcNote sql.NullString
		variantOf, compareMode, starter       sql.NullString
		iface, harness                        sql.NullString
		timeLimit, memLimit                   sql.NullInt64
		created, updated                      int64
	)
	err := sc.Scan(&r.seq, &it.ID, &it.Type, &it.Title, &it.Summary, &it.Body, &difficulty, &it.Status, &it.Favorite,
		&it.Notes, &rawInput, &srcURL, &srcNote, &variantOf, &it.Revision, &timeLimit, &memLimit, &compareMode,
		&starter, &iface, &harness, &created, &updated)
	if err != nil {
		return r, err
	}
	if difficulty.Valid {
		d := domain.Difficulty(difficulty.String)
		it.Difficulty = &d
	}
	it.RawInput = strPtr(rawInput)
	it.Source = domain.Source{URL: strPtr(srcURL), Note: strPtr(srcNote)}
	it.VariantOf = strPtr(variantOf)
	it.CreatedAt = fromUnix(created)
	it.UpdatedAt = fromUnix(updated)
	if it.Type == domain.TypeProblem {
		p := &domain.ProblemSpec{
			TimeLimitMs:   int(timeLimit.Int64),
			MemoryLimitKb: int(memLimit.Int64),
			Compare:       domain.CompareMode(compareMode.String),
			StarterCode:   map[string]string{},
			Interface:     domain.ProblemInterface(iface.String),
			Harness:       map[string]domain.HarnessCode{},
		}
		if starter.Valid && starter.String != "" {
			if err := json.Unmarshal([]byte(starter.String), &p.StarterCode); err != nil {
				return r, fmt.Errorf("item %s: starter code: %w", it.ID, err)
			}
		}
		if harness.Valid && harness.String != "" {
			if err := json.Unmarshal([]byte(harness.String), &p.Harness); err != nil {
				return r, fmt.Errorf("item %s: harness: %w", it.ID, err)
			}
		}
		it.Problem = p
	}
	it.Normalize()
	return r, nil
}

func (t *tx) GetItem(id string) (domain.Item, error) {
	r, err := scanItem(t.queryRow(`SELECT `+itemColumns+` FROM items i WHERE i.id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Item{}, store.ErrNotFound
	}
	if err != nil {
		return domain.Item{}, err
	}
	sums := []*domain.ItemSummary{&r.item.ItemSummary}
	if err := t.hydrate(sums); err != nil {
		return domain.Item{}, err
	}
	if r.item.Problem != nil {
		sols, err := t.ListSolutions(id)
		if err != nil {
			return domain.Item{}, err
		}
		r.item.Problem.ReferenceSolution = domain.RefOf(sols)
	}
	return r.item, nil
}

func (t *tx) AllItemIDs() ([]string, error) {
	rows, err := t.query(`SELECT id FROM items ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return scanStrings(rows)
}

func scanStrings(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (t *tx) ExistingItemIDs(ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := t.query(`SELECT id FROM items WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	found, err := scanStrings(rows)
	if err != nil {
		return nil, err
	}
	for _, id := range found {
		out[id] = true
	}
	return out, nil
}

// itemArgs are the values of every item column after id, in table order.
func itemArgs(it *domain.Item) []any {
	var difficulty, timeLimit, memLimit, compareMode, starter, iface, harness any
	if it.Difficulty != nil {
		difficulty = string(*it.Difficulty)
	}
	if p := it.Problem; p != nil {
		timeLimit, memLimit, compareMode = p.TimeLimitMs, p.MemoryLimitKb, string(p.Compare)
		sc := p.StarterCode
		if sc == nil {
			sc = map[string]string{}
		}
		b, _ := json.Marshal(sc)
		starter = string(b)
		iface = string(p.Interface)
		if p.Interface == "" {
			iface = string(domain.InterfaceProgram)
		}
		h := p.Harness
		if h == nil {
			h = map[string]domain.HarnessCode{}
		}
		b, _ = json.Marshal(h)
		harness = string(b)
	}
	return []any{
		string(it.Type), it.Title, text(it.Summary), text(it.Body), difficulty, string(it.Status), it.Favorite,
		text(it.Notes), nullText(it.RawInput), nullStr(it.Source.URL), nullText(it.Source.Note), nullStr(it.VariantOf),
		it.Revision, timeLimit, memLimit, compareMode, starter, toUnix(it.CreatedAt), toUnix(it.UpdatedAt), iface, harness,
	}
}

func (t *tx) InsertItem(it *domain.Item) error {
	args := append([]any{it.ID}, itemArgs(it)...)
	var seq int64
	err := t.queryRow(`INSERT INTO items (id, type, title, summary, body, difficulty, status, favorite, notes,
		raw_input, source_url, source_note, variant_of, revision, time_limit_ms, memory_limit_kb, compare_mode,
		starter_code, created_at, updated_at, problem_interface, harness)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
		RETURNING seq`, args...).Scan(&seq)
	if err != nil {
		return err
	}
	if err := t.writeTags(it.ID, it.Tags); err != nil {
		return err
	}
	return t.index(seq, it.Title, it.Summary, it.Body, it.Tags)
}

func (t *tx) UpdateItem(it *domain.Item) error {
	args := append(itemArgs(it)[1:], it.ID) // type is immutable
	var seq int64
	err := t.queryRow(`UPDATE items SET title = $1, summary = $2, body = $3, difficulty = $4, status = $5,
		favorite = $6, notes = $7, raw_input = $8, source_url = $9, source_note = $10, variant_of = $11,
		revision = $12, time_limit_ms = $13, memory_limit_kb = $14, compare_mode = $15, starter_code = $16,
		created_at = $17, updated_at = $18, problem_interface = $19, harness = $20 WHERE id = $21 RETURNING seq`, args...).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := t.exec(`DELETE FROM item_tags WHERE item_id = $1`, it.ID); err != nil {
		return err
	}
	if err := t.writeTags(it.ID, it.Tags); err != nil {
		return err
	}
	return t.index(seq, it.Title, it.Summary, it.Body, it.Tags)
}

func (t *tx) writeTags(itemID string, tags []string) error {
	for _, tag := range tags {
		if _, err := t.exec(`INSERT INTO item_tags (item_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`, itemID, tag); err != nil {
			return err
		}
	}
	return nil
}

// index writes the search index row of an item.
func (t *tx) index(seq int64, title, summary, body string, tags []string) error {
	cols, err := searchTexts(title, summary, body, strings.Join(tags, " "))
	if err != nil {
		return err
	}
	_, err = t.exec(`INSERT INTO items_search (seq, title, summary, body, tags) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (seq) DO UPDATE SET title = excluded.title, summary = excluded.summary, body = excluded.body,
		tags = excluded.tags`, seq, cols[0], cols[1], cols[2], cols[3])
	return err
}

func (t *tx) DeleteItem(id string) (bool, error) {
	var seq int64
	err := t.queryRow(`SELECT seq FROM items WHERE id = $1`, id).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := t.exec(`UPDATE items SET variant_of = NULL WHERE variant_of = $1`, id); err != nil {
		return false, err
	}
	// The search index row goes with the item.
	if _, err := t.exec(`DELETE FROM items WHERE id = $1`, id); err != nil {
		return false, err
	}
	return true, nil
}

func (t *tx) SetItemCollections(itemID string, collectionIDs []string) error {
	rows, err := t.query(`SELECT collection_id FROM collection_items WHERE item_id = $1`, itemID)
	if err != nil {
		return err
	}
	current, err := scanStrings(rows)
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, c := range collectionIDs {
		want[c] = true
	}
	have := map[string]bool{}
	for _, c := range current {
		have[c] = true
		if !want[c] {
			if _, err := t.RemoveCollectionItem(c, itemID); err != nil {
				return err
			}
		}
	}
	for _, c := range collectionIDs {
		if !have[c] {
			if err := t.AddCollectionItems(c, []string{itemID}); err != nil {
				return err
			}
			have[c] = true
		}
	}
	return nil
}

// hydrate fills the computed summary fields for the given items.
func (t *tx) hydrate(items []*domain.ItemSummary) error {
	if len(items) == 0 {
		return nil
	}
	byID := make(map[string]*domain.ItemSummary, len(items))
	ids := make([]string, 0, len(items))
	for _, it := range items {
		byID[it.ID] = it
		ids = append(ids, it.ID)
		it.Tags = []string{}
		it.CollectionIDs = []string{}
		it.VariantCount, it.TestCaseCount, it.SolutionCount, it.LastVerdict = 0, 0, 0, nil
	}
	if err := t.eachRow(`SELECT item_id, tag FROM item_tags WHERE item_id = ANY($1) ORDER BY tag`, []any{ids},
		func(r *sql.Rows) error {
			var id, tag string
			if err := r.Scan(&id, &tag); err != nil {
				return err
			}
			byID[id].Tags = append(byID[id].Tags, tag)
			return nil
		}); err != nil {
		return err
	}
	if err := t.eachRow(`SELECT ci.item_id, ci.collection_id FROM collection_items ci
		JOIN collections c ON c.id = ci.collection_id WHERE ci.item_id = ANY($1) ORDER BY c.seq`, []any{ids},
		func(r *sql.Rows) error {
			var id, cid string
			if err := r.Scan(&id, &cid); err != nil {
				return err
			}
			byID[id].CollectionIDs = append(byID[id].CollectionIDs, cid)
			return nil
		}); err != nil {
		return err
	}
	counts := []struct {
		q   string
		set func(*domain.ItemSummary, int)
	}{
		{`SELECT variant_of, COUNT(*) FROM items WHERE variant_of = ANY($1) GROUP BY variant_of`,
			func(s *domain.ItemSummary, n int) { s.VariantCount = n }},
		{`SELECT item_id, COUNT(*) FROM test_cases WHERE item_id = ANY($1) GROUP BY item_id`,
			func(s *domain.ItemSummary, n int) { s.TestCaseCount = n }},
		{`SELECT item_id, COUNT(*) FROM solutions WHERE item_id = ANY($1) GROUP BY item_id`,
			func(s *domain.ItemSummary, n int) { s.SolutionCount = n }},
	}
	for _, c := range counts {
		if err := t.eachRow(c.q, []any{ids}, func(r *sql.Rows) error {
			var id string
			var n int
			if err := r.Scan(&id, &n); err != nil {
				return err
			}
			c.set(byID[id], n)
			return nil
		}); err != nil {
			return err
		}
	}
	return t.eachRow(`SELECT s.item_id, s.verdict FROM submissions s WHERE s.item_id = ANY($1)
		AND s.seq = (SELECT MAX(s2.seq) FROM submissions s2 WHERE s2.item_id = s.item_id
		             AND s2.mode = 'submit' AND s2.status = 'completed')`, []any{ids},
		func(r *sql.Rows) error {
			var id string
			var v sql.NullString
			if err := r.Scan(&id, &v); err != nil {
				return err
			}
			if v.Valid {
				verdict := domain.Verdict(v.String)
				byID[id].LastVerdict = &verdict
			}
			return nil
		})
}

func (t *tx) eachRow(q string, args []any, fn func(*sql.Rows) error) error {
	rows, err := t.query(q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// searchColumns are the indexed columns with their relevance weights, as
// in the SQLite store's bm25 call.
var searchColumns = []struct{ name, weight string }{
	{"s.title", "10.0"}, {"s.summary", "4.0"}, {"s.body", "1.0"}, {"s.tags", "6.0"},
}

// matchSQL is true when the item of index row s contains the phrase ph in
// one of its columns.
func matchSQL(ph string) string {
	var ors []string
	for _, c := range searchColumns {
		ors = append(ors, `strpos(`+c.name+`, `+ph+`) > 0`)
	}
	return `(` + strings.Join(ors, ` OR `) + `)`
}

// bm25SQL computes FTS5's bm25 (k1 = 1.2, b = 0.75) with the same column
// weights and statistics as the SQLite store: for each phrase, its
// weighted number of occurrences in the item and the number of items that
// contain it, the item's token count and the average over all items. It
// returns a WITH clause for the statistics, the name to join it under, and
// the score (higher is better).
func bm25SQL(phrases []string) (with, score string) {
	tokens := func(col string) string { return `(length(` + col + `) - length(replace(` + col + `, ' ', '')) - 1)` }
	var docLen []string
	for _, c := range searchColumns {
		docLen = append(docLen, tokens(c.name))
	}
	d := `(` + strings.Join(docLen, ` + `) + `)::float8`
	stats := []string{`count(*)::float8 AS n`, `COALESCE(avg(` + d + `), 0) AS avgdl`}
	var terms []string
	for k, ph := range phrases {
		h := `h` + strconv.Itoa(k)
		stats = append(stats, `count(*) FILTER (WHERE `+matchSQL(ph)+`)::float8 AS `+h)
		var freq []string
		for _, c := range searchColumns {
			freq = append(freq, c.weight+` * ((length(`+c.name+`) - length(replace(`+c.name+`, `+ph+`, ''))) / length(`+ph+`))`)
		}
		f := `(` + strings.Join(freq, ` + `) + `)`
		idf := `ln((0.5 + st.n - st.` + h + `) / (0.5 + st.` + h + `))`
		idf = `(CASE WHEN ` + idf + ` <= 0 THEN 1e-6 ELSE ` + idf + ` END)`
		terms = append(terms, idf+` * (`+f+` * 2.2) / (`+f+` + 1.2 * (0.25 + 0.75 * `+d+` / st.avgdl))`)
	}
	return `WITH st AS (SELECT ` + strings.Join(stats, `, `) + ` FROM items_search s) `, `(` + strings.Join(terms, ` + `) + `)`
}

func (t *tx) ListItems(f store.ItemFilter) ([]domain.ItemSummary, int, error) {
	var (
		p       params
		from    = `items i`
		where   []string
		phrases []string // placeholders of the search phrases
	)
	if f.Query != "" {
		terms, err := searchTerms(f.Query)
		if err != nil {
			return nil, 0, err
		}
		if len(terms) == 0 {
			return []domain.ItemSummary{}, 0, nil
		}
		from = `items_search s JOIN items i ON i.seq = s.seq`
		for _, term := range terms {
			ph := p.add(term)
			phrases = append(phrases, ph)
			where = append(where, matchSQL(ph))
		}
	}
	if f.CollectionID != "" && !f.Recursive {
		from += ` JOIN collection_items ci ON ci.item_id = i.id AND ci.collection_id = ` + p.add(f.CollectionID)
	}
	if f.CollectionID != "" && f.Recursive {
		where = append(where, `i.id IN (SELECT item_id FROM collection_items WHERE collection_id IN (
			WITH RECURSIVE d(id) AS (SELECT `+p.add(f.CollectionID)+`::text COLLATE "C" UNION
			SELECT c.id FROM collections c JOIN d ON c.parent_id = d.id)
			SELECT id FROM d))`)
	}
	if len(f.IDs) > 0 {
		where = append(where, `i.id = ANY(`+p.add(f.IDs)+`)`)
	}
	if f.Type != "" {
		where = append(where, `i.type = `+p.add(string(f.Type)))
	}
	if len(f.Statuses) > 0 {
		var ss []string
		for _, s := range f.Statuses {
			ss = append(ss, string(s))
		}
		where = append(where, `i.status = ANY(`+p.add(ss)+`)`)
	}
	if len(f.Difficulties) > 0 {
		var ors, vals []string
		for _, d := range f.Difficulties {
			if d == "none" {
				ors = append(ors, `i.difficulty IS NULL`)
			} else {
				vals = append(vals, d)
			}
		}
		if len(vals) > 0 {
			ors = append(ors, `i.difficulty = ANY(`+p.add(vals)+`)`)
		}
		where = append(where, `(`+strings.Join(ors, ` OR `)+`)`)
	}
	for _, tag := range f.Tags {
		where = append(where, `EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = `+p.add(tag)+`)`)
	}
	if f.Uncollected {
		where = append(where, `NOT EXISTS (SELECT 1 FROM collection_items x WHERE x.item_id = i.id)`)
	}
	if f.VariantOf != "" {
		where = append(where, `i.variant_of = `+p.add(f.VariantOf))
	}
	if f.Favorite != nil {
		where = append(where, `i.favorite = `+p.add(*f.Favorite))
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = ` WHERE ` + strings.Join(where, ` AND `)
	}

	var total int
	if err := t.queryRow(`SELECT COUNT(*) FROM `+from+whereSQL, p.args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// SQLite sorts NULL before every value; so do these orderings.
	dir, nulls := `ASC`, `NULLS FIRST`
	if f.Desc {
		dir, nulls = `DESC`, `NULLS LAST`
	}
	// The title collation is "C", under which lower() folds ASCII letters
	// only: the same order as SQLite's NOCASE.
	var order, with, rowsFrom = ``, ``, from
	switch f.Sort {
	case store.SortCreated:
		order = `i.created_at ` + dir + `, i.seq ` + dir
	case store.SortTitle:
		order = `lower(i.title) ` + dir + `, i.seq ` + dir
	case store.SortDifficulty:
		order = `(i.difficulty IS NULL), CASE i.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 WHEN 'hard' THEN 3 END ` +
			dir + ` ` + nulls + `, lower(i.title), i.seq`
	case store.SortPosition:
		order = `ci.position ` + dir
	case store.SortRelevance:
		if len(phrases) == 0 {
			order = `i.seq DESC`
			break
		}
		var score string
		with, score = bm25SQL(phrases)
		rowsFrom += ` CROSS JOIN st`
		order = score + ` ` + dir + `, i.seq DESC`
	default:
		order = `i.updated_at ` + dir + `, i.seq ` + dir
	}
	q := with + `SELECT ` + itemColumns + ` FROM ` + rowsFrom + whereSQL + ` ORDER BY ` + order
	if f.Limit > 0 {
		q += ` LIMIT ` + p.add(f.Limit)
	}
	if f.Offset > 0 {
		q += ` OFFSET ` + p.add(f.Offset)
	}
	rows, err := t.query(q, p.args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var list []domain.ItemSummary
	for rows.Next() {
		r, err := scanItem(rows)
		if err != nil {
			return nil, 0, err
		}
		list = append(list, r.item.ItemSummary)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	rows.Close()
	ptrs := make([]*domain.ItemSummary, len(list))
	for i := range list {
		ptrs[i] = &list[i]
	}
	if err := t.hydrate(ptrs); err != nil {
		return nil, 0, err
	}
	if list == nil {
		list = []domain.ItemSummary{}
	}
	return list, total, nil
}

func (t *tx) ListTags() ([]domain.Tag, error) {
	rows, err := t.query(`SELECT tag, COUNT(*) FROM item_tags GROUP BY tag ORDER BY tag`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Tag{}
	for rows.Next() {
		var tg domain.Tag
		if err := rows.Scan(&tg.Name, &tg.Count); err != nil {
			return nil, err
		}
		out = append(out, tg)
	}
	return out, rows.Err()
}

func (t *tx) ItemIDsWithTag(name string) ([]string, error) {
	rows, err := t.query(`SELECT t.item_id FROM item_tags t JOIN items i ON i.id = t.item_id WHERE t.tag = $1 ORDER BY i.seq`, name)
	if err != nil {
		return nil, err
	}
	return scanStrings(rows)
}

func (t *tx) Stats() (domain.Stats, error) {
	s := domain.NewStats()
	if err := t.eachRow(`SELECT type, status, COALESCE(difficulty, 'none'), COUNT(*) FROM items GROUP BY 1, 2, 3`, nil,
		func(r *sql.Rows) error {
			var typ, status, diff string
			var n int
			if err := r.Scan(&typ, &status, &diff, &n); err != nil {
				return err
			}
			s.Items.Total += n
			s.Items.ByType[typ] += n
			s.Items.ByStatus[status] += n
			s.Items.ByDifficulty[diff] += n
			return nil
		}); err != nil {
		return s, err
	}
	if err := t.queryRow(`SELECT COUNT(*) FROM collections`).Scan(&s.Collections); err != nil {
		return s, err
	}
	if err := t.queryRow(`SELECT COUNT(DISTINCT tag) FROM item_tags`).Scan(&s.Tags); err != nil {
		return s, err
	}
	if err := t.queryRow(`SELECT COUNT(*), COUNT(*) FILTER (WHERE verdict = 'accepted' AND mode = 'submit') FROM submissions`).
		Scan(&s.Submissions.Total, &s.Submissions.Accepted); err != nil {
		return s, err
	}
	return s, nil
}

func (t *tx) GetSetting(key string) (string, bool, error) {
	var v string
	err := t.queryRow(`SELECT value FROM settings WHERE key = $1`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (t *tx) SetSetting(key, value string) error {
	_, err := t.exec(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func (t *tx) DeleteSetting(key string) error {
	_, err := t.exec(`DELETE FROM settings WHERE key = $1`, key)
	return err
}
