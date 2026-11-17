package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"

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
		favorite                              int
		created, updated                      int64
	)
	err := sc.Scan(&r.seq, &it.ID, &it.Type, &it.Title, &it.Summary, &it.Body, &difficulty, &it.Status, &favorite,
		&it.Notes, &rawInput, &srcURL, &srcNote, &variantOf, &it.Revision, &timeLimit, &memLimit, &compareMode,
		&starter, &iface, &harness, &created, &updated)
	if err != nil {
		return r, err
	}
	if difficulty.Valid {
		d := domain.Difficulty(difficulty.String)
		it.Difficulty = &d
	}
	it.Favorite = favorite != 0
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
	r, err := scanItem(t.queryRow(`SELECT `+itemColumns+` FROM items i WHERE i.id = ?`, id))
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
	for _, ch := range chunks(ids, 500) {
		rows, err := t.query(`SELECT id FROM items WHERE id IN (`+placeholders(len(ch))+`)`, anyArgs(ch)...)
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
	}
	return out, nil
}

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
		it.Type, it.Title, it.Summary, it.Body, difficulty, it.Status, boolInt(it.Favorite), it.Notes,
		nullStr(it.RawInput), nullStr(it.Source.URL), nullStr(it.Source.Note), nullStr(it.VariantOf), it.Revision,
		timeLimit, memLimit, compareMode, starter, toUnix(it.CreatedAt), toUnix(it.UpdatedAt), iface, harness,
	}
}

func (t *tx) InsertItem(it *domain.Item) error {
	args := append([]any{it.ID}, itemArgs(it)...)
	res, err := t.exec(`INSERT INTO items (id, type, title, summary, body, difficulty, status, favorite, notes,
		raw_input, source_url, source_note, variant_of, revision, time_limit_ms, memory_limit_kb, compare_mode,
		starter_code, created_at, updated_at, problem_interface, harness)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args...)
	if err != nil {
		return err
	}
	seq, err := res.LastInsertId()
	if err != nil {
		return err
	}
	if err := t.writeTags(it.ID, it.Tags); err != nil {
		return err
	}
	return t.index(seq, it)
}

func (t *tx) UpdateItem(it *domain.Item) error {
	args := append(itemArgs(it)[1:], it.ID) // type is immutable
	res, err := t.exec(`UPDATE items SET title = ?, summary = ?, body = ?, difficulty = ?, status = ?, favorite = ?,
		notes = ?, raw_input = ?, source_url = ?, source_note = ?, variant_of = ?, revision = ?, time_limit_ms = ?,
		memory_limit_kb = ?, compare_mode = ?, starter_code = ?, created_at = ?, updated_at = ?, problem_interface = ?,
		harness = ? WHERE id = ?`, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	if _, err := t.exec(`DELETE FROM item_tags WHERE item_id = ?`, it.ID); err != nil {
		return err
	}
	if err := t.writeTags(it.ID, it.Tags); err != nil {
		return err
	}
	var seq int64
	if err := t.queryRow(`SELECT seq FROM items WHERE id = ?`, it.ID).Scan(&seq); err != nil {
		return err
	}
	return t.index(seq, it)
}

func (t *tx) writeTags(itemID string, tags []string) error {
	for _, tag := range tags {
		if _, err := t.exec(`INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)`, itemID, tag); err != nil {
			return err
		}
	}
	return nil
}

func (t *tx) index(seq int64, it *domain.Item) error {
	if _, err := t.exec(`DELETE FROM items_fts WHERE rowid = ?`, seq); err != nil {
		return err
	}
	_, err := t.exec(`INSERT INTO items_fts (rowid, title, summary, body, tags) VALUES (?, ?, ?, ?, ?)`,
		seq, it.Title, it.Summary, it.Body, strings.Join(it.Tags, " "))
	return err
}

func (t *tx) DeleteItem(id string) (bool, error) {
	var seq int64
	err := t.queryRow(`SELECT seq FROM items WHERE id = ?`, id).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := t.exec(`DELETE FROM items_fts WHERE rowid = ?`, seq); err != nil {
		return false, err
	}
	if _, err := t.exec(`UPDATE items SET variant_of = NULL WHERE variant_of = ?`, id); err != nil {
		return false, err
	}
	if _, err := t.exec(`DELETE FROM items WHERE id = ?`, id); err != nil {
		return false, err
	}
	return true, nil
}

func (t *tx) SetItemCollections(itemID string, collectionIDs []string) error {
	rows, err := t.query(`SELECT collection_id FROM collection_items WHERE item_id = ?`, itemID)
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
	for _, ch := range chunks(ids, 500) {
		ph, args := placeholders(len(ch)), anyArgs(ch)
		if err := t.eachRow(`SELECT item_id, tag FROM item_tags WHERE item_id IN (`+ph+`) ORDER BY tag`, args,
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
			JOIN collections c ON c.id = ci.collection_id WHERE ci.item_id IN (`+ph+`) ORDER BY c.seq`, args,
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
		if err := t.eachRow(`SELECT variant_of, COUNT(*) FROM items WHERE variant_of IN (`+ph+`) GROUP BY variant_of`, args,
			func(r *sql.Rows) error {
				var id string
				var n int
				if err := r.Scan(&id, &n); err != nil {
					return err
				}
				byID[id].VariantCount = n
				return nil
			}); err != nil {
			return err
		}
		if err := t.eachRow(`SELECT item_id, COUNT(*) FROM test_cases WHERE item_id IN (`+ph+`) GROUP BY item_id`, args,
			func(r *sql.Rows) error {
				var id string
				var n int
				if err := r.Scan(&id, &n); err != nil {
					return err
				}
				byID[id].TestCaseCount = n
				return nil
			}); err != nil {
			return err
		}
		if err := t.eachRow(`SELECT item_id, COUNT(*) FROM solutions WHERE item_id IN (`+ph+`) GROUP BY item_id`, args,
			func(r *sql.Rows) error {
				var id string
				var n int
				if err := r.Scan(&id, &n); err != nil {
					return err
				}
				byID[id].SolutionCount = n
				return nil
			}); err != nil {
			return err
		}
		if err := t.eachRow(`SELECT s.item_id, s.verdict FROM submissions s WHERE s.item_id IN (`+ph+`)
			AND s.seq = (SELECT MAX(s2.seq) FROM submissions s2 WHERE s2.item_id = s.item_id
			             AND s2.mode = 'submit' AND s2.status = 'completed')`, args,
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
			}); err != nil {
			return err
		}
	}
	return nil
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

// ftsQuery turns free text into an FTS5 query: every whitespace-separated
// word becomes a quoted prefix term, and all terms must match.
func ftsQuery(q string) string {
	var terms []string
	for _, w := range strings.FieldsFunc(q, unicode.IsSpace) {
		w = strings.ReplaceAll(w, `"`, `""`)
		// Skip words that consist only of punctuation; the tokenizer would
		// produce no tokens for them.
		if strings.IndexFunc(w, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) < 0 {
			continue
		}
		terms = append(terms, `"`+w+`"*`)
	}
	return strings.Join(terms, " ")
}

func (t *tx) ListItems(f store.ItemFilter) ([]domain.ItemSummary, int, error) {
	var (
		from     = `items i`
		where    []string
		joinArgs []any // arguments of the FROM clause
		args     []any // arguments of the WHERE clause
	)
	if f.Query != "" {
		fq := ftsQuery(f.Query)
		if fq == "" {
			return []domain.ItemSummary{}, 0, nil
		}
		from = `items_fts JOIN items i ON i.seq = items_fts.rowid`
		where = append(where, `items_fts MATCH ?`)
		args = append(args, fq)
	}
	if f.CollectionID != "" && !f.Recursive {
		from += ` JOIN collection_items ci ON ci.item_id = i.id AND ci.collection_id = ?`
		joinArgs = append(joinArgs, f.CollectionID)
	}
	if f.CollectionID != "" && f.Recursive {
		where = append(where, `i.id IN (SELECT item_id FROM collection_items WHERE collection_id IN (
			WITH RECURSIVE d(id) AS (SELECT ? UNION SELECT c.id FROM collections c JOIN d ON c.parent_id = d.id)
			SELECT id FROM d))`)
		args = append(args, f.CollectionID)
	}
	if len(f.IDs) > 0 {
		where = append(where, `i.id IN (`+placeholders(len(f.IDs))+`)`)
		args = append(args, anyArgs(f.IDs)...)
	}
	if f.Type != "" {
		where = append(where, `i.type = ?`)
		args = append(args, string(f.Type))
	}
	if len(f.Statuses) > 0 {
		where = append(where, `i.status IN (`+placeholders(len(f.Statuses))+`)`)
		for _, s := range f.Statuses {
			args = append(args, string(s))
		}
	}
	if len(f.Difficulties) > 0 {
		var ors []string
		var vals []any
		for _, d := range f.Difficulties {
			if d == "none" {
				ors = append(ors, `i.difficulty IS NULL`)
			} else {
				vals = append(vals, d)
			}
		}
		if len(vals) > 0 {
			ors = append(ors, `i.difficulty IN (`+placeholders(len(vals))+`)`)
			args = append(args, vals...)
		}
		where = append(where, `(`+strings.Join(ors, ` OR `)+`)`)
	}
	for _, tag := range f.Tags {
		where = append(where, `EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)`)
		args = append(args, tag)
	}
	if f.Uncollected {
		where = append(where, `NOT EXISTS (SELECT 1 FROM collection_items x WHERE x.item_id = i.id)`)
	}
	if f.VariantOf != "" {
		where = append(where, `i.variant_of = ?`)
		args = append(args, f.VariantOf)
	}
	if f.Favorite != nil {
		where = append(where, `i.favorite = ?`)
		args = append(args, boolInt(*f.Favorite))
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = ` WHERE ` + strings.Join(where, ` AND `)
	}

	args = append(joinArgs, args...)
	var total int
	if err := t.queryRow(`SELECT COUNT(*) FROM `+from+whereSQL, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	dir := `ASC`
	if f.Desc {
		dir = `DESC`
	}
	var order string
	switch f.Sort {
	case store.SortCreated:
		order = `i.created_at ` + dir + `, i.seq ` + dir
	case store.SortTitle:
		order = `i.title COLLATE NOCASE ` + dir + `, i.seq ` + dir
	case store.SortDifficulty:
		order = `(i.difficulty IS NULL), CASE i.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 WHEN 'hard' THEN 3 END ` +
			dir + `, i.title COLLATE NOCASE, i.seq`
	case store.SortPosition:
		order = `ci.position ` + dir
	case store.SortRelevance:
		// bm25 is lower for better matches, so descending relevance is
		// ascending bm25.
		rdir := `DESC`
		if f.Desc {
			rdir = `ASC`
		}
		order = `bm25(items_fts, 10.0, 4.0, 1.0, 6.0) ` + rdir + `, i.seq DESC`
	default:
		order = `i.updated_at ` + dir + `, i.seq ` + dir
	}
	q := `SELECT ` + itemColumns + ` FROM ` + from + whereSQL + ` ORDER BY ` + order
	pageArgs := append([]any{}, args...)
	if f.Limit > 0 {
		q += ` LIMIT ? OFFSET ?`
		pageArgs = append(pageArgs, f.Limit, f.Offset)
	} else if f.Offset > 0 {
		q += ` LIMIT -1 OFFSET ?`
		pageArgs = append(pageArgs, f.Offset)
	}
	rows, err := t.query(q, pageArgs...)
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
	rows, err := t.query(`SELECT t.item_id FROM item_tags t JOIN items i ON i.id = t.item_id WHERE t.tag = ? ORDER BY i.seq`, name)
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
	// The conditions ListItems applies for its Favorite and Uncollected filters.
	if err := t.queryRow(`SELECT COALESCE(SUM(i.favorite = 1), 0),
		COALESCE(SUM(NOT EXISTS (SELECT 1 FROM collection_items x WHERE x.item_id = i.id)), 0) FROM items i`).
		Scan(&s.Items.Favorites, &s.Items.Uncollected); err != nil {
		return s, err
	}
	if err := t.queryRow(`SELECT COUNT(*) FROM collections`).Scan(&s.Collections); err != nil {
		return s, err
	}
	if err := t.queryRow(`SELECT COUNT(DISTINCT tag) FROM item_tags`).Scan(&s.Tags); err != nil {
		return s, err
	}
	if err := t.queryRow(`SELECT COUNT(*), COALESCE(SUM(verdict = 'accepted' AND mode = 'submit'), 0) FROM submissions`).
		Scan(&s.Submissions.Total, &s.Submissions.Accepted); err != nil {
		return s, err
	}
	return s, nil
}

func (t *tx) GetSetting(key string) (string, bool, error) {
	var v string
	err := t.queryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (t *tx) SetSetting(key, value string) error {
	_, err := t.exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func (t *tx) DeleteSetting(key string) error {
	_, err := t.exec(`DELETE FROM settings WHERE key = ?`, key)
	return err
}
