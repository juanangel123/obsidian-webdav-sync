# CLAUDE.md

All project knowledge lives in this repo (this file, `README.md`), never in Claude's global memory. **Public repo**:
no personal data, hostnames, passwords, passphrases, nor mentions of the owner's other projects or servers — those
live in `CLAUDE.local.md` (gitignored).

## What this is

The owner's own Obsidian sync plugin (2026-11-24): WebDAV, end-to-end encrypted, desktop and Android (iOS untested).
Written because Remotely Save, the usual plugin for this, has had no release since 2024-10. `README.md` is the
user-facing doc (features, setup, server, how it works); this file is the engineering side.

## Code

| File | Role |
|---|---|
| `src/plan.ts` | the decision, pure: local × remote × last-sync state → actions; the deletion guard (`needsConfirmation`, `GUARD_MIN`); conflict names |
| `src/sync.ts` | one run (`Run`): list both sides, map remote names to paths, carry the plan out with a re-check before every change; `openVault` (sets a vault up only when asked, never over existing notes) |
| `src/crypto.ts` | keys (PBKDF2 → HKDF → AES-GCM + HMAC), names, seal/open (path + version sealed inside, name checked on open), `sync.json`, `validPath` |
| `src/webdav.ts` | WebDAV over an injected HTTP function; a regex PROPFIND parser (no DOMParser, so it runs under Bun) |
| `src/main.ts` | Obsidian glue: `requestUrl` with a timeout, the vault as `LocalFs`, secrets in `app.secretStorage`, triggers, pausing, the confirmation modal, settings |
| `src/i18n.ts` | every user-facing string, per language (`en` the source, the rest typed against it), picked from Obsidian's `getLanguage()` on load; `errorText` turns the engine's errors (their `kind`, a WebDAV status) into a message in that language |
| `mcp/notes.ts` | the MCP server's vault: a device with no disk — name → path map and note texts in memory (refreshed by ETag), search (accents folded), create (only where nothing is, any case), append (re-checks the ETag, re-reads on a change); never deletes |
| `mcp/oauth.ts` | OAuth 2.1 for one person with no storage: signed client ids, codes, tokens (key from secret + password); login page; lockout |
| `mcp/server.ts`, `mcp/main.ts` | the MCP endpoint (Streamable HTTP, stateless JSON, tools) and the process (settings from the environment) |
| `scripts/decrypt.ts` | recovery from a server copy without Obsidian |
| `scripts/version.ts` | `bun run version x.y.z`: package.json, manifest.json, versions.json |

`src/` is type-checked without Bun's or Node's types (`tsconfig.json`): it runs on phones. Tests, scripts and `mcp/`
(Bun) use `tsconfig.test.json`.

Languages: English and Spanish. No user-facing string in `main.ts`: it goes in `src/i18n.ts`, in every language.
The engine (`sync.ts`, `crypto.ts`, `webdav.ts`) and the logs stay in English; an engine error the user may see
carries a `kind` that `errorText` translates. A new language: a dictionary `xx: Strings` and its entry in
`languages` (`tests/i18n.test.ts` checks keys, arity and empty strings).

## Invariants

- Never overwrite a side's change without keeping it: a conflict copy, or the action is skipped and the next run
  decides again. Every write re-checks first: `put` stats the server's ETag, `LocalFs.write`/`trash` compare the file
  with the listing (`LocalChanged`).
- Deletions only to a trash (the vault's `.trash`, the server's `.trash/<time>/`), and past the guard only with the
  user's confirmation of those exact files. Automatic runs never ask: they pause.
- A path's state is written only after both sides hold the same content. Change detection: local mtime + size,
  remote ETag; a note's version (sealed inside) only grows, so an older blob reappearing is a conflict, not an update.
- The state belongs to one server vault (`url` + `username` + `sync.json`'s `id`); another one starts a fresh state,
  which can only compare and add, never delete.
- A vault is set up only by a manual action (Check, Sync now) on a folder with no notes.
- The blob format (`WDS1`, header JSON `{p, v}`), the name scheme and `sync.json` are on every server copy: change
  them only with a migration.

## Checks and release

- `bun run check`: both type-checks, NN tests (pure logic, the translations; the MCP server and its OAuth; devices synced through a real `rclone serve webdav` —
  races, interrupted runs, restores, corrupt or swapped blobs, case-insensitive disks, the recovery script), build.
  The rclone tests are skipped when rclone is missing: never release on a run that skipped them.
- `bun run e2e` (Windows): the built plugin in two real Obsidian instances with their own profiles and throwaway
  vaults, over the DevTools protocol — loading, secrets, sync both ways, sync after editing, no sync loop, conflict,
  trash, wrong passphrase (told in English and in Spanish), switching servers. Run it before every release.
- Release: `bun run version x.y.z`, `bun run check`, `bun run e2e`, commit, tag `x.y.z` (no `v`),
  `gh release create x.y.z main.js manifest.json` under the owner's account (`CLAUDE.local.md`); BRAT picks it up.
