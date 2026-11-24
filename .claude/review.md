# WebDAV Vault Sync's review: range, dimensions, checks

Read by the owner's shared `full-review` skill (its path: `CLAUDE.local.md`). Only what is this
project's own lives here.

## Range

By default the commits on `main` since the last commit whose message starts with `fix(…): review`
(`git log --oneline -1 -E --grep='^fix\(.*\): review'`); with none, everything after the first commit (0.1.0 was
reviewed before it). The owner may name another range.

## Dimensions

1. **Never lose a note** (`src/plan.ts`, `src/sync.ts`): every combination of local × remote × last-sync state, and
   what each action does when it fails half way (the state written only after both sides agree?); an edit never
   overwritten without a conflict copy; deletions only to a trash; the deletion guard; a file edited *during* a run;
   renames, case-only renames on Windows/Android (case-insensitive) against a case-sensitive server; paths with
   unicode, spaces, `#`, `%`, `?`; empty files; a remote file that can't be decrypted; a second device's first sync;
   a lost state (reinstall); two devices syncing at once.
2. **Security and cryptography** (`src/crypto.ts`): AES-GCM IV uniqueness, key derivation (salt, iterations),
   key separation (AES vs HMAC), what the server learns (names, sizes, counts, timings), `sync.json` (can a tampered
   one make a device encrypt under an attacker's key, or downgrade?), a wrong passphrase never writes anything,
   secrets (password, passphrase) where they are stored and whether they can leak into logs, notices or the repo;
   basic auth only over HTTPS.
3. **Obsidian and mobile** (`src/main.ts`): the API used as documented (`requestUrl`, `vault.*`, `adapter.stat`,
   `trash`, events, `onLayoutReady`, `registerInterval`), Android and iOS (no Node or Electron APIs, WebCrypto there,
   memory with big attachments), sync loops caused by the plugin's own writes, overlapping runs, unload cleaning up,
   the settings tab, the status bar, notices that say what happened.
4. **Performance and cost**: requests per run (one PROPFIND, one GET per unknown name, one stat per upload…), work
   repeated on every run (HMAC of every path, key derivation), battery on the phone (interval, debounce), the server
   side (the server's trash growth).
5. **Refactoring and structure**: duplication, dead code, stale comments, names, functions grown too long, the pure
   core (`plan`, `crypto`, `webdav`, `sync`) free of Obsidian imports; the file layout (`src/`, `tests/`, `scripts/`).
6. **Tests**: every decision of `plan` covered; the sync runs against a real WebDAV server; failures (network down,
   a 5xx, a corrupt blob) tested; nothing hits the owner's server.
7. **Documentation**: `README.md` (user-facing, public: no personal data, hostnames, secrets), `CLAUDE.md`, header
   comments, against the code as it is now — stale numbers (iterations, debounce, interval, guard thresholds),
   missing settings, wrong claims. English in the repo.
8. **UX** (owner 2026-11-24): the owner's shared UX dimension (its path: `CLAUDE.local.md`), on what a user meets: the settings tab, the notices, the status bar and the commands (`src/main.ts`), read from the code and, when possible, in Obsidian on desktop and phone. Can each setting be understood without the README, does a notice say what happened and what to do, is anything said twice. Public plugin: wording in English.

## Checks

`bun run check` (both type-checks, tests against `rclone serve webdav` — not skipped —, build) and `bun run e2e` (the
plugin in two real Obsidian instances).
