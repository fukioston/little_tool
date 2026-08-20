# Local SQLite boundary

`client.ts` is the browser-facing API. It owns one module worker, maps the
product aliases `career` and `vocab` to `zhiji.sqlite3` and `shici.sqlite3`, and
serializes database operations through that worker.

The worker requires OPFS. It intentionally refuses to fall back to an in-memory
database because a silent fallback would look durable until the page closes.
The page serving it must include these headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Vite configuration must also exclude `@sqlite.org/sqlite-wasm` from
dependency optimization, as required by the package.

`init()` only opens a database and applies connection PRAGMAs. Product feature
stores own their namespaced tables and seeds. The broader SQL models in
`../schemas` are reference schemas for migration/backup tests and are never
imported or executed by this runtime.

Queries accept positional or named parameters. `batch()` is transactional by
default. `import()` validates the SQLite header, integrity, and foreign keys,
and restores the previous bytes if replacement fails. `reset()` replaces only
the selected database with a valid empty SQLite file.
