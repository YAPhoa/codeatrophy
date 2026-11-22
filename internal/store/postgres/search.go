package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"

	_ "modernc.org/sqlite" // FTS5 tokenizer

	"codeatrophy/internal/store"
)

// Search follows the SQLite store's FTS5 rules exactly: the text of each
// column is split into tokens by FTS5's unicode61 tokenizer with
// remove_diacritics 2 (the SQLite store's tokenizer, run here on a private
// in-memory SQLite database, so both backends split and fold text
// identically), and every whitespace-separated word of a query is a phrase
// of its tokens whose last token is a prefix; an item matches when every
// phrase occurs within one of its columns.
//
// The index stores each column as its tokens separated by single spaces and
// enclosed in spaces (" two sum "), so a phrase is a substring that starts
// at a token boundary: " two su" matches, " wo sum" cannot occur. This keeps
// matching exact for any document length, which PostgreSQL's tsvector
// (positions capped at 16383, its own parser) would not.

// tokenizer is the in-memory SQLite connection that tokenizes text.
var tokenizer struct {
	once sync.Once
	mu   sync.Mutex
	conn *sql.Conn
	err  error
}

func openTokenizer() {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file::memory:")
	if err == nil {
		db.SetMaxOpenConns(1)
		tokenizer.conn, err = db.Conn(ctx)
	}
	for _, q := range []string{
		`CREATE VIRTUAL TABLE f USING fts5 (c, tokenize = 'unicode61 remove_diacritics 2')`,
		`CREATE VIRTUAL TABLE v USING fts5vocab (f, 'instance')`,
	} {
		if err == nil {
			_, err = tokenizer.conn.ExecContext(ctx, q)
		}
	}
	if err != nil {
		tokenizer.err = fmt.Errorf("search tokenizer: %w", err)
	}
}

// tokenize splits each text into its folded tokens, in order.
func tokenize(texts []string) ([][]string, error) {
	tokenizer.once.Do(openTokenizer)
	if tokenizer.err != nil {
		return nil, tokenizer.err
	}
	tokenizer.mu.Lock()
	defer tokenizer.mu.Unlock()
	ctx := context.Background()
	// The texts are indexed in a transaction that is rolled back, so the
	// table is always empty in between.
	tx, err := tokenizer.conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	out := make([][]string, len(texts))
	for i, s := range texts {
		if strings.IndexFunc(s, func(r rune) bool { return r > ' ' }) < 0 {
			continue // nothing to index
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO f (rowid, c) VALUES (?, ?)`, i+1, s); err != nil {
			return nil, err
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT doc, term FROM v ORDER BY doc, offset`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var doc int
		var term string
		if err := rows.Scan(&doc, &term); err != nil {
			return nil, err
		}
		// Terms are valid UTF-8 without NUL, which PostgreSQL text needs,
		// whatever bytes the text held.
		term = strings.ReplaceAll(strings.ToValidUTF8(term, "\uFFFD"), "\x00", "")
		out[doc-1] = append(out[doc-1], term)
	}
	return out, rows.Err()
}

// searchTexts returns the indexed form of each text.
func searchTexts(texts ...string) ([]string, error) {
	toks, err := tokenize(texts)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(texts))
	for i, t := range toks {
		out[i] = " "
		if len(t) > 0 {
			out[i] = " " + strings.Join(t, " ") + " "
		}
	}
	return out, nil
}

// searchTerms turns free text into the substrings an item must contain,
// one per word of store.SearchWords.
func searchTerms(q string) ([]string, error) {
	toks, err := tokenize(store.SearchWords(q))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, t := range toks {
		if len(t) > 0 {
			out = append(out, " "+strings.Join(t, " "))
		}
	}
	return out, nil
}
