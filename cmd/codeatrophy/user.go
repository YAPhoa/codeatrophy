package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"

	"golang.org/x/term"

	"codeatrophy/internal/app"
	"codeatrophy/internal/config"
	"codeatrophy/internal/store/dbopen"
)

const userUsage = `Usage: codeatrophy user <command> [email]

Commands:
  list               List the accounts that may sign in
  add <email>        Add an account
  password <email>   Set an account's password and sign it out everywhere
  delete <email>     Remove an account and sign it out everywhere

These work on the configured database (CODEATROPHY_DATABASE_URL, or else
CODEATROPHY_DB_PATH). add and password ask for the password twice on a
terminal; otherwise they read it from the first line of standard input.
Every account sees the same library. With Compose:

  docker compose exec app codeatrophy user password you@example.com

The first account is normally created in the web UI with the setup code the
server logs at startup; "add" creates it without one.
`

func userCommand(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, userUsage)
		os.Exit(2)
	}
	cmd := args[0]
	if cmd == "help" || cmd == "-h" || cmd == "--help" {
		fmt.Print(userUsage)
		return nil
	}
	var email string
	switch cmd {
	case "list":
		if len(args) != 1 {
			return errors.New("user list takes no arguments")
		}
	case "add", "password", "delete":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return fmt.Errorf("usage: codeatrophy user %s <email>", cmd)
		}
		email = args[1]
	default:
		fmt.Fprint(os.Stderr, userUsage)
		os.Exit(2)
	}

	restrictUmask()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	if cfg.DatabaseURL == "" {
		if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
			return fmt.Errorf("data directory: %w", err)
		}
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	db, err := dbopen.Open(ctx, dbopen.Config{DatabaseURL: cfg.DatabaseURL, SQLitePath: cfg.DBPath,
		ManualMigration: !cfg.DBAutoMigrate, Logger: log})
	if err != nil {
		return err
	}
	defer db.Close()
	a := app.New(app.Options{Store: db, Auth: app.AuthOptions{Enabled: cfg.Auth}})

	switch cmd {
	case "list":
		users, err := a.ListUsers(ctx)
		if err != nil {
			return err
		}
		if len(users) == 0 {
			fmt.Println("No accounts yet.")
			return nil
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "EMAIL\tCREATED")
		for _, u := range users {
			fmt.Fprintf(tw, "%s\t%s\n", u.Email, u.CreatedAt.Format("2006-01-02 15:04 MST"))
		}
		return tw.Flush()
	case "add":
		pw, err := readNewPassword(os.Stdin)
		if err != nil {
			return err
		}
		u, err := a.CreateUser(ctx, email, pw)
		if err != nil {
			return userError(err)
		}
		fmt.Printf("Added %s.\n", u.Email)
	case "password":
		pw, err := readNewPassword(os.Stdin)
		if err != nil {
			return err
		}
		if err := a.SetUserPassword(ctx, email, pw); err != nil {
			return userError(err)
		}
		fmt.Printf("Changed the password of %s and signed it out everywhere.\n", strings.ToLower(strings.TrimSpace(email)))
	case "delete":
		if err := a.DeleteUser(ctx, email); err != nil {
			return userError(err)
		}
		fmt.Printf("Removed %s.\n", strings.ToLower(strings.TrimSpace(email)))
	}
	return nil
}

// userError words a service error for the command line, naming the field
// of a validation error.
func userError(err error) error {
	ae := app.AsError(err)
	if ae.Code == app.CodeInternal {
		return err
	}
	for field, msg := range ae.Fields {
		return fmt.Errorf("%s %v", field, msg)
	}
	return errors.New(ae.Message)
}

// readNewPassword asks for a password twice on a terminal, or reads the
// first line of a pipe.
func readNewPassword(in *os.File) (string, error) {
	fd := int(in.Fd())
	if !term.IsTerminal(fd) {
		line, err := bufio.NewReader(in).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		pw := strings.TrimRight(line, "\r\n")
		if pw == "" {
			return "", errors.New("no password on standard input")
		}
		return pw, nil
	}
	fmt.Fprint(os.Stderr, "Password: ")
	a, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "Repeat it: ")
	b, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if string(a) != string(b) {
		return "", errors.New("the passwords differ")
	}
	return string(a), nil
}
