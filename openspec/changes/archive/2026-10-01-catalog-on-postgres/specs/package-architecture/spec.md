## MODIFIED Requirements

### Requirement: The catalog package owns the catalog schema migrations

The catalog schema migration files (`*.sql`, filename-ordered) SHALL live in
`@autologger/catalog`, which SHALL export the resolved migrations directory path for the
migrator. Until the SQLite catalog is removed (ADR 0021 slice 4e), only tests run it; the server's
catalog is the Postgres schema, migrated by the stack's migrations service. The migrator itself (`openCatalogDb` /
`applyMigrations`) SHALL live in `@autologger/storage` and SHALL remain
directory-generic. The migration behavior — filename ordering, `_migrations` tracking,
one transaction per file, full ordered set applied to a fresh database — SHALL be
unchanged by the move.

#### Scenario: Fresh database migrates identically after the move
- **WHEN** the migrator runs against a new, empty SQLite catalog file
- **THEN** the full ordered migration set applies from the catalog package's exported directory, recording the same migration **name set and application order** in `_migrations` and producing the same resulting schema as before the move (`applied_at_utc` timestamps naturally differ)

#### Scenario: Already-migrated database is untouched
- **WHEN** the migrator runs against a SQLite catalog file that was already migrated
- **THEN** no migration re-applies
