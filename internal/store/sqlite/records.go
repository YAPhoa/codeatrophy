package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Test cases.

const testCaseColumns = `id, item_id, position, name, stdin, expected_stdout, is_sample, origin, verified, created_at, updated_at`

func scanTestCase(sc interface{ Scan(...any) error }) (domain.TestCase, error) {
	var (
		tc               domain.TestCase
		sample, verified int
		created, updated int64
	)
	err := sc.Scan(&tc.ID, &tc.ItemID, &tc.Position, &tc.Name, &tc.Stdin, &tc.ExpectedStdout, &sample, &tc.Origin,
		&verified, &created, &updated)
	tc.IsSample, tc.Verified = sample != 0, verified != 0
	tc.CreatedAt, tc.UpdatedAt = fromUnix(created), fromUnix(updated)
	return tc, err
}

func (t *tx) ListTestCases(itemID string) ([]domain.TestCase, error) {
	rows, err := t.query(`SELECT `+testCaseColumns+` FROM test_cases WHERE item_id = ? ORDER BY position, seq`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.TestCase{}
	for rows.Next() {
		tc, err := scanTestCase(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tc)
	}
	return out, rows.Err()
}

func (t *tx) GetTestCase(id string) (domain.TestCase, error) {
	tc, err := scanTestCase(t.queryRow(`SELECT `+testCaseColumns+` FROM test_cases WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return tc, store.ErrNotFound
	}
	return tc, err
}

func (t *tx) InsertTestCase(tc *domain.TestCase) error {
	_, err := t.exec(`INSERT INTO test_cases (`+testCaseColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		tc.ID, tc.ItemID, tc.Position, tc.Name, tc.Stdin, tc.ExpectedStdout, boolInt(tc.IsSample), tc.Origin,
		boolInt(tc.Verified), toUnix(tc.CreatedAt), toUnix(tc.UpdatedAt))
	return err
}

func (t *tx) UpdateTestCase(tc *domain.TestCase) error {
	res, err := t.exec(`UPDATE test_cases SET position = ?, name = ?, stdin = ?, expected_stdout = ?, is_sample = ?,
		origin = ?, verified = ?, updated_at = ? WHERE id = ?`,
		tc.Position, tc.Name, tc.Stdin, tc.ExpectedStdout, boolInt(tc.IsSample), tc.Origin, boolInt(tc.Verified),
		toUnix(tc.UpdatedAt), tc.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteTestCase(id string) error {
	res, err := t.exec(`DELETE FROM test_cases WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteTestCases(itemID string) error {
	_, err := t.exec(`DELETE FROM test_cases WHERE item_id = ?`, itemID)
	return err
}

func (t *tx) SetTestCasePositions(itemID string, ids []string) error {
	for i, id := range ids {
		if _, err := t.exec(`UPDATE test_cases SET position = ? WHERE id = ? AND item_id = ?`, i, id, itemID); err != nil {
			return err
		}
	}
	return nil
}

// Collections.

const collectionColumns = `c.id, c.name, c.description, c.parent_id, c.position, c.created_at, c.updated_at,
	(SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id)`

func scanCollection(sc interface{ Scan(...any) error }) (domain.Collection, error) {
	var (
		c                domain.Collection
		parent           sql.NullString
		created, updated int64
	)
	err := sc.Scan(&c.ID, &c.Name, &c.Description, &parent, &c.Position, &created, &updated, &c.ItemCount)
	c.ParentID = strPtr(parent)
	c.CreatedAt, c.UpdatedAt = fromUnix(created), fromUnix(updated)
	return c, err
}

func (t *tx) ListCollections() ([]domain.Collection, error) {
	rows, err := t.query(`SELECT ` + collectionColumns + ` FROM collections c
		ORDER BY c.parent_id IS NOT NULL, c.parent_id, c.position, c.seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Collection{}
	for rows.Next() {
		c, err := scanCollection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (t *tx) GetCollection(id string) (domain.Collection, error) {
	c, err := scanCollection(t.queryRow(`SELECT `+collectionColumns+` FROM collections c WHERE c.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return c, store.ErrNotFound
	}
	return c, err
}

func (t *tx) InsertCollection(c *domain.Collection) error {
	_, err := t.exec(`INSERT INTO collections (id, name, description, parent_id, position, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, c.ID, c.Name, c.Description, nullStr(c.ParentID), c.Position,
		toUnix(c.CreatedAt), toUnix(c.UpdatedAt))
	return err
}

func (t *tx) UpdateCollection(c *domain.Collection) error {
	res, err := t.exec(`UPDATE collections SET name = ?, description = ?, parent_id = ?, position = ?, updated_at = ?
		WHERE id = ?`, c.Name, c.Description, nullStr(c.ParentID), c.Position, toUnix(c.UpdatedAt), c.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteCollection(id string) error {
	res, err := t.exec(`DELETE FROM collections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) CollectionItemIDs(id string) ([]string, error) {
	rows, err := t.query(`SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY position`, id)
	if err != nil {
		return nil, err
	}
	return scanStrings(rows)
}

func (t *tx) SetCollectionItemIDs(id string, itemIDs []string) error {
	if _, err := t.exec(`DELETE FROM collection_items WHERE collection_id = ?`, id); err != nil {
		return err
	}
	for i, item := range itemIDs {
		if _, err := t.exec(`INSERT INTO collection_items (collection_id, item_id, position) VALUES (?, ?, ?)`, id, item, i); err != nil {
			return err
		}
	}
	return nil
}

func (t *tx) AddCollectionItems(id string, itemIDs []string) error {
	var next int
	if err := t.queryRow(`SELECT COALESCE(MAX(position) + 1, 0) FROM collection_items WHERE collection_id = ?`, id).Scan(&next); err != nil {
		return err
	}
	for _, item := range itemIDs {
		res, err := t.exec(`INSERT OR IGNORE INTO collection_items (collection_id, item_id, position) VALUES (?, ?, ?)`, id, item, next)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			next++
		}
	}
	return nil
}

func (t *tx) RemoveCollectionItem(id, itemID string) (bool, error) {
	res, err := t.exec(`DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?`, id, itemID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Submissions.

const submissionColumns = `id, item_id, mode, language, source, stdin, case_ids, status, verdict, passed_count, total_count,
	time_ms, memory_kb, compile_output, error, created_at, finished_at`

func scanSubmission(sc interface{ Scan(...any) error }) (domain.Submission, error) {
	var (
		s                       domain.Submission
		stdin, verdict, errMsg  sql.NullString
		timeMs, memKb, finished sql.NullInt64
		created                 int64
		caseIDs                 string
	)
	err := sc.Scan(&s.ID, &s.ItemID, &s.Mode, &s.Language, &s.Source, &stdin, &caseIDs, &s.Status, &verdict, &s.PassedCount,
		&s.TotalCount, &timeMs, &memKb, &s.CompileOutput, &errMsg, &created, &finished)
	s.Stdin = strPtr(stdin)
	_ = json.Unmarshal([]byte(caseIDs), &s.CaseIDs)
	if verdict.Valid {
		v := domain.Verdict(verdict.String)
		s.Verdict = &v
	}
	s.TimeMs, s.MemoryKb = intPtr(timeMs), intPtr(memKb)
	s.Error = strPtr(errMsg)
	s.CreatedAt = fromUnix(created)
	if finished.Valid {
		f := fromUnix(finished.Int64)
		s.FinishedAt = &f
	}
	s.Results = []domain.SubmissionResult{}
	return s, err
}

func (t *tx) InsertSubmission(s *domain.Submission) error {
	ids := s.CaseIDs
	if ids == nil {
		ids = []string{}
	}
	caseIDs, _ := json.Marshal(ids)
	_, err := t.exec(`INSERT INTO submissions (`+submissionColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.ItemID, s.Mode, s.Language, s.Source, nullStr(s.Stdin), string(caseIDs), s.Status, verdictArg(s.Verdict), s.PassedCount,
		s.TotalCount, nullInt(s.TimeMs), nullInt(s.MemoryKb), s.CompileOutput, nullStr(s.Error), toUnix(s.CreatedAt),
		nullUnix(s.FinishedAt))
	return err
}

func verdictArg(v *domain.Verdict) any {
	if v == nil {
		return nil
	}
	return string(*v)
}

func (t *tx) GetSubmission(id string) (domain.Submission, error) {
	s, err := scanSubmission(t.queryRow(`SELECT `+submissionColumns+` FROM submissions WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, store.ErrNotFound
	}
	if err != nil {
		return s, err
	}
	err = t.eachRow(`SELECT test_case_id, name, is_sample, verdict, stdin, expected_stdout, stdout, stderr, time_ms, memory_kb
		FROM submission_results WHERE submission_id = ? ORDER BY idx`, []any{id}, func(r *sql.Rows) error {
		var (
			res            domain.SubmissionResult
			tcID, expected sql.NullString
			sample         int
			timeMs, memKb  sql.NullInt64
		)
		if err := r.Scan(&tcID, &res.Name, &sample, &res.Verdict, &res.Stdin, &expected, &res.Stdout, &res.Stderr,
			&timeMs, &memKb); err != nil {
			return err
		}
		res.TestCaseID, res.ExpectedStdout = strPtr(tcID), strPtr(expected)
		res.IsSample = sample != 0
		res.TimeMs, res.MemoryKb = intPtr(timeMs), intPtr(memKb)
		s.Results = append(s.Results, res)
		return nil
	})
	return s, err
}

func (t *tx) ListSubmissions(itemID string, mode domain.SubmissionMode, limit, offset int) ([]domain.SubmissionSummary, int, error) {
	where, args := `item_id = ?`, []any{itemID}
	if mode != "" {
		where += ` AND mode = ?`
		args = append(args, string(mode))
	}
	var total int
	if err := t.queryRow(`SELECT COUNT(*) FROM submissions WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if limit <= 0 {
		limit = -1
	}
	rows, err := t.query(`SELECT `+submissionColumns+` FROM submissions WHERE `+where+` ORDER BY seq DESC LIMIT ? OFFSET ?`,
		append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []domain.SubmissionSummary{}
	for rows.Next() {
		s, err := scanSubmission(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, s.Summary())
	}
	return out, total, rows.Err()
}

func (t *tx) UpdateSubmission(s *domain.Submission) error {
	res, err := t.exec(`UPDATE submissions SET status = ?, verdict = ?, passed_count = ?, total_count = ?, time_ms = ?,
		memory_kb = ?, compile_output = ?, error = ?, finished_at = ? WHERE id = ?`,
		s.Status, verdictArg(s.Verdict), s.PassedCount, s.TotalCount, nullInt(s.TimeMs), nullInt(s.MemoryKb),
		s.CompileOutput, nullStr(s.Error), nullUnix(s.FinishedAt), s.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) AddSubmissionResult(submissionID string, index int, r domain.SubmissionResult) error {
	_, err := t.exec(`INSERT OR REPLACE INTO submission_results (submission_id, idx, test_case_id, name, is_sample, verdict,
		stdin, expected_stdout, stdout, stderr, time_ms, memory_kb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		submissionID, index, nullStr(r.TestCaseID), r.Name, boolInt(r.IsSample), string(r.Verdict), r.Stdin,
		nullStr(r.ExpectedStdout), r.Stdout, r.Stderr, nullInt(r.TimeMs), nullInt(r.MemoryKb))
	return err
}

func (t *tx) UnfinishedSubmissionIDs() ([]string, error) {
	rows, err := t.query(`SELECT id FROM submissions WHERE status != 'completed' ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return scanStrings(rows)
}
