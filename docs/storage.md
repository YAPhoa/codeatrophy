# Storage

This document covers where the library is kept, upgrading, the database
commands, switching between PostgreSQL and SQLite, and backups.

The Compose stack keeps the library in PostgreSQL, in its own `db` service
(`postgres:18.7-alpine`, volume `codeatrophy-db`), reachable only from the app and
never published to the host. The `codeatrophy-data` volume is still needed:
it holds `secret.key`, which encrypts stored API keys.

**SQLite instead.** Set `CODEATROPHY_DATABASE_URL=` (empty) in `.env` and the
app keeps the library in `/data/codeatrophy.db` in the `codeatrophy-data`
volume. The `db` container then has nothing to do; start the stack with
`docker compose up -d --scale db=0` to leave it out. A server binary run on
its own uses SQLite unless `CODEATROPHY_DATABASE_URL` is set.

Both backends behave the same, search included (same matching rules, same
relevance order). Searching PostgreSQL reads every item's index entry, which
is quick for a personal library of thousands of items.

## Upgrading

1. **Back up first** (see [Backup and restore](#backup-and-restore)):
   `pg_dump` for PostgreSQL, or the `codeatrophy-data` volume for SQLite.
2. Bring the checkout to the new release: `git pull` on `main`, which is
   always the latest release, or `git fetch --tags` and
   `git checkout v1.2.0` for a given one. Its `compose.yaml` names that
   release's image. Read its notes below before going on.
3. `docker compose pull`, then `docker compose up -d`. (If you build from
   source, `docker compose up -d --build` instead.) By default the server
   applies pending schema migrations at startup and logs each one. Before
   migrating a SQLite database it also writes a copy next to it, named
   after the version it was at (`codeatrophy.db.backup-v5-<time>`), and
   keeps the three newest; PostgreSQL gets no automatic backup.

**From before 1.0.0.** A release after 1.0.0 migrates only a database that
Codeatrophy 1.0.0 or later has already brought to its schema. Upgrade an
older install to 1.0.0 first (`git checkout v1.0.0`, then step 3), let it
start once, and then go on to the newer release. A newer release refuses
an older database, says so and changes nothing; `db status` shows it as
"from before Codeatrophy 1.0.0".

**Published images.** Releases now come as a published image,
`ghcr.io/yaphoa/codeatrophy`, which `docker compose pull` fetches. The
image an install built before, `codeatrophy:0.1.0`, is no longer used;
remove it with `docker image rm codeatrophy:0.1.0`.

**Default port 8484.** The default port changed from 8080 to 8484. To keep
reaching an existing install on 8080, set `CODEATROPHY_HOST_PORT=8080` in
`.env`. The port inside the container changes either way, which is harmless.

**Judge0's database on PostgreSQL 18.** Judge0's database moved to a new
volume, `judge0-db-18`, and starts empty (it holds nothing the app needs).
The old `judge0-db` volume is no longer used; remove it with
`docker volume rm codeatrophy_judge0-db`.

**Migrating by hand.** With `CODEATROPHY_DB_AUTO_MIGRATE=off` the server
never changes the schema: on a database behind its version (or without a
schema) it stops with a message naming both versions. Then run

```sh
docker compose pull app
docker compose stop app
docker compose run --rm app db migrate   # lists what is pending, then applies it
docker compose up -d
```

`db migrate` always migrates, whatever the setting, and says "nothing to do"
when the database is current. In this mode the automatic SQLite import below
does not run either: the server stops and says to run `db copy` instead.

**Rehearsing.** Try the upgrade on a copy first. While the old version still
runs, copy the library with the old binary, then migrate the copy with the
new one. With SQLite the copy is a file next to the database:

```sh
docker compose exec app codeatrophy db copy --from configured --to /data/rehearsal.db
docker compose pull app
docker compose run --rm app db migrate --db /data/rehearsal.db
docker compose run --rm app db status --db /data/rehearsal.db
```

With PostgreSQL, rehearse on a scratch database in the same server
(`createdb -U codeatrophy rehearsal` in the `db` service, then use
`postgres://codeatrophy:<password>@db:5432/rehearsal?sslmode=disable` in place
of `/data/rehearsal.db`, and `dropdb` it afterwards). The copy has to be made
by the old version, because `db copy` first brings its source to its own
binary's schema; the new version would migrate your real database. Remove
the rehearsal copy when done.

**Forward only.** The schema only moves forward. A server older than the
database refuses to start ("this database was last used by a newer
Codeatrophy; upgrade the server") and changes nothing. To roll back, restore
the backup from step 1 and start the old version.

**Coming from SQLite.** Installs from before PostgreSQL have their library
in `codeatrophy.db` in the `codeatrophy-data` volume. On the first start
after the upgrade, the server finds the new PostgreSQL database empty,
copies the SQLite database into it, checks every table's row count, and
renames the file to `codeatrophy.db.migrated-<UTC time>`, which stays as a
backup. The log says what was imported. If the import fails, nothing is
imported, the file stays where it is, and the server stops with the reason;
set `CODEATROPHY_DATABASE_URL=` to keep running on SQLite meanwhile. Once
PostgreSQL holds a library, a SQLite file is never imported over it (the log
says so). `CODEATROPHY_SQLITE_IMPORT=off` turns the import off.

## Database commands

The server binary also inspects, migrates and copies databases, without the
server having to run: `docker compose run --rm app db …` runs it in a one-off
container with the app's configuration and volumes. A database is a SQLite
file path or a `postgres://` URL; `configured` (in `copy`) and the default
(in `status` and `migrate`) mean the configured one, which keeps its password
off the command line.

```sh
docker compose run --rm app db status     # backend, schema version, pending migrations, row counts
docker compose run --rm app db migrate    # list and apply pending migrations, then exit
docker compose run --rm app db copy --from <database> --to <database> [--replace]
```

`db copy` copies everything (settings, AI providers, style presets, items,
collections, test cases, solutions, submissions) with ids, timestamps and
order unchanged, in one transaction, in either direction. It refuses a
destination that already holds a library unless `--replace` is given, which
deletes that library first, and it refuses to copy a database onto itself.
Stop the app (`docker compose stop app`) before copying into the database
it uses. Stored API keys are copied encrypted, so the destination needs the
same `secret.key` (or `CODEATROPHY_SECRET_KEY`).

## Switching backends

- *SQLite to PostgreSQL:* point `CODEATROPHY_DATABASE_URL` at an empty
  PostgreSQL database and start; the import above does the rest.
- *PostgreSQL to SQLite:* copy the library into a file, then switch:

  ```sh
  docker compose run --rm app db copy --from configured --to /data/codeatrophy.db --replace
  # then set CODEATROPHY_DATABASE_URL= in .env and
  docker compose up -d
  ```

  (`--replace` overwrites a SQLite file that is already there. If the
  PostgreSQL database still holds the library, a later switch back to it
  ignores the file and keeps the PostgreSQL data.)

## Backup and restore

Back up the database and the secret key: `secret.key` in the
`codeatrophy-data` volume, unless you set `CODEATROPHY_SECRET_KEY`. Without
it, stored API keys cannot be decrypted and must be entered again;
everything else is readable without it.

**PostgreSQL** (the Compose default):

```sh
# Back up the database, and the data volume for secret.key
docker compose exec -T db pg_dump -U codeatrophy -d codeatrophy --format=custom > codeatrophy.dump
docker run --rm -v codeatrophy_codeatrophy-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/codeatrophy-data.tgz -C /data .

# Restore the database (into the running db service; the app is stopped)
docker compose stop app
docker compose exec -T db pg_restore -U codeatrophy -d codeatrophy --clean --if-exists < codeatrophy.dump
docker compose start app
```

**SQLite:** all state is in the `codeatrophy-data` volume (`codeatrophy.db`
with its `-wal`/`-shm` files, and `secret.key`).

```sh
# Back up (stop the app so the database files are consistent)
docker compose stop app
docker run --rm -v codeatrophy_codeatrophy-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/codeatrophy-backup.tgz -C /data .
docker compose start app

# Restore
docker compose stop app
docker run --rm -v codeatrophy_codeatrophy-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/codeatrophy-backup.tgz -C /data'
docker compose start app
```

`codeatrophy db copy` into a SQLite file is a backend-neutral backup too.
For moving content between instances, use bundles (Settings → Export / Import)
instead; they carry content only, not your progress, notes or settings. A
bundle that holds a solution-only problem uses bundle format version 2,
which an older Codeatrophy refuses to import; upgrade it first.
