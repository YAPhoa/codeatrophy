package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"

	"codeatrophy/internal/config"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/dbcopy"
	"codeatrophy/internal/store/dbopen"
)

const dbUsage = `Usage: codeatrophy db <command> [flags]

Commands:
  status   Show the backend, schema version, pending migrations and row counts
  migrate  Apply pending migrations and exit (whatever CODEATROPHY_DB_AUTO_MIGRATE says)
  copy     Copy the complete contents of one database into another

A database is a SQLite file path or a postgres:// URL. Without --db, status
and migrate work on the configured database (CODEATROPHY_DATABASE_URL, or
else CODEATROPHY_DB_PATH). In copy, "configured" names the configured
database, which keeps its password out of the command line.

  codeatrophy db status [--db <database>]
  codeatrophy db migrate [--db <database>]
  codeatrophy db copy --from <database> --to <database> [--replace]

migrate lists the pending migrations first. A SQLite database is backed up
next to its file before it is migrated; a PostgreSQL one is not, so make a
pg_dump first.

copy refuses a destination that already holds library data unless --replace
is given, which deletes that data first. Stop the server before copying into
the database it uses. Stored API keys are copied encrypted: the destination
instance needs the same secret key (CODEATROPHY_SECRET_KEY or
<data dir>/secret.key) to use them.
`

func dbCommand(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, dbUsage)
		os.Exit(2)
	}
	if args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		fmt.Print(dbUsage)
		return nil
	}
	restrictUmask()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	configured := dbopen.Target{SQLitePath: cfg.DBPath, PostgresURL: cfg.DatabaseURL}
	if configured.PostgresURL != "" {
		configured.SQLitePath = ""
	}
	target := func(s string) (dbopen.Target, error) {
		if s == "" || s == "configured" {
			return configured, nil
		}
		return dbopen.ParseTarget(s)
	}

	fs := flag.NewFlagSet("db "+args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	switch args[0] {
	case "status", "migrate":
		dbFlag := fs.String("db", "", "database")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() > 0 {
			return usageError(err)
		}
		t, err := target(*dbFlag)
		if err != nil {
			return err
		}
		if args[0] == "migrate" {
			return runMigrate(ctx, os.Stdout, t, log)
		}
		st, err := dbopen.Inspect(ctx, t)
		if err != nil {
			return err
		}
		// Only the configured database is migrated by the server.
		atStart := *dbFlag == "" && cfg.DBAutoMigrate
		printStatus(os.Stdout, st, atStart)
		if *dbFlag == "" && cfg.DatabaseURL != "" && cfg.SQLiteImport {
			if _, err := os.Stat(cfg.DBPath); err == nil {
				fmt.Printf("\nA SQLite database is at %s. The server imports it at its next start if PostgreSQL "+
					"holds no library data yet, and otherwise ignores it.\n", cfg.DBPath)
			}
		}
		return nil
	case "copy":
		from := fs.String("from", "", "source database")
		to := fs.String("to", "", "destination database")
		replace := fs.Bool("replace", false, "replace the destination's data")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() > 0 || *from == "" || *to == "" {
			return usageError(err)
		}
		src, err := target(*from)
		if err != nil {
			return fmt.Errorf("--from: %w", err)
		}
		dst, err := target(*to)
		if err != nil {
			return fmt.Errorf("--to: %w", err)
		}
		if dbopen.Same(src, dst) {
			return fmt.Errorf("the source and the destination are the same database (%s)", src)
		}
		if src.SQLitePath != "" {
			if _, err := os.Stat(src.SQLitePath); err != nil {
				return fmt.Errorf("--from: %w", err)
			}
		}
		// The source is brought to this server's version first; say so.
		if st, err := dbopen.Inspect(ctx, src); err == nil && len(st.Pending) > 0 {
			fmt.Printf("The source is at schema version %d and is migrated to %d first (pending: %s).\n",
				st.Version, st.Latest, strings.Join(st.Pending, ", "))
			if src.PostgresURL != "" {
				fmt.Print(pgBackupNotice)
			}
		}
		sdb, err := dbopen.OpenTarget(ctx, src, log)
		if err != nil {
			return err
		}
		defer sdb.Close()
		if b, ok := sdb.(interface{ Backup() string }); ok && b.Backup() != "" {
			fmt.Printf("Backup of the source before migrating written to %s\n", b.Backup())
		}
		ddb, err := dbopen.OpenTarget(ctx, dst, log)
		if err != nil {
			return err
		}
		defer ddb.Close()
		counts, err := dbcopy.Copy(ctx, sdb, ddb, dbcopy.Options{Replace: *replace})
		if errors.Is(err, dbcopy.ErrNotEmpty) {
			return fmt.Errorf("%s already holds library data; nothing was copied. Add --replace to delete it "+
				"and copy anyway", dst)
		}
		if err != nil {
			return fmt.Errorf("nothing was copied: %w", err)
		}
		fmt.Printf("Copied %s\n  from %s\n  to   %s\n", dbcopy.Summary(counts), src, dst)
		return nil
	}
	return usageError(nil)
}

func usageError(err error) error {
	fmt.Fprint(os.Stderr, dbUsage)
	if err != nil {
		return err
	}
	return errors.New("bad arguments")
}

// pgBackupNotice is printed before migrating PostgreSQL, which, unlike
// SQLite, gets no automatic backup.
const pgBackupNotice = `Note: no backup is taken of a PostgreSQL database before migrating. Make one first, for example
  pg_dump --format=custom --file=codeatrophy.dump "<database URL>"
  (with Compose: docker compose exec -T db pg_dump -U codeatrophy -d codeatrophy --format=custom > codeatrophy.dump)
`

// runMigrate applies the pending migrations of the database, saying what
// they are first.
func runMigrate(ctx context.Context, w io.Writer, t dbopen.Target, log *slog.Logger) error {
	st, err := dbopen.Inspect(ctx, t)
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "%s: schema version %d, this server's version %d\n", t, st.Version, st.Latest)
	if st.Version > st.Latest {
		return fmt.Errorf("the database is newer than this server: %w", store.ErrNewerSchema)
	}
	if len(st.Pending) == 0 {
		fmt.Fprintln(w, "Nothing to do: the database is up to date.")
		return nil
	}
	fmt.Fprintf(w, "Pending: %s\n", strings.Join(st.Pending, ", "))
	if t.PostgresURL != "" {
		fmt.Fprint(w, pgBackupNotice)
	}
	db, err := dbopen.OpenTarget(ctx, t, log)
	if err != nil {
		return err
	}
	defer db.Close()
	if b, ok := db.(interface{ Backup() string }); ok && b.Backup() != "" {
		fmt.Fprintf(w, "Backup of the database at version %d written to %s\n", st.Version, b.Backup())
	}
	v, err := db.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "Applied %s. The database is at schema version %d.\n", strings.Join(st.Pending, ", "), v)
	return nil
}

// printStatus describes a database; atStart says whether the server
// migrates it when it starts.
func printStatus(w io.Writer, st store.Status, atStart bool) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "Backend:\t%s\n", st.Backend)
	fmt.Fprintf(tw, "Database:\t%s\n", st.Location)
	how := "by codeatrophy db migrate"
	if atStart {
		how = "at the next start, or by codeatrophy db migrate"
	}
	if !st.Exists {
		fmt.Fprintf(tw, "\tdoes not exist yet; it is created %s\n", how)
	}
	version := fmt.Sprint(st.Version)
	switch {
	case st.Version == 0:
		version = "none (no schema yet)"
	case st.Version > st.Latest:
		version += " (newer than this server: upgrade the server)"
	}
	fmt.Fprintf(tw, "Schema version:\t%s\n", version)
	fmt.Fprintf(tw, "Expected version:\t%d (this server)\n", st.Latest)
	pending := "none"
	if len(st.Pending) > 0 {
		pending = strings.Join(st.Pending, ", ") + " (applied " + how + ")"
	}
	fmt.Fprintf(tw, "Pending migrations:\t%s\n", pending)
	if len(st.Counts) > 0 {
		fmt.Fprintf(tw, "Rows:\t\n")
		for _, c := range st.Counts {
			fmt.Fprintf(tw, "  %s\t%d\n", c.Table, c.Rows)
		}
	}
	tw.Flush()
}
