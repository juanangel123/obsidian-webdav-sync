# WebDAV Vault Sync

**Sync your Obsidian vault with your own WebDAV server, end-to-end encrypted.** Desktop and Android, two-way,
no account, no third party: the server only ever stores opaque file names and ciphertext.

A small plugin on purpose: one kind of server, one way of syncing, and a sync engine built around one rule —
**never lose a note**.

## Features

- **Two-way sync** between every device and your server: edits, new files, deletions, renames, attachments.
- **End-to-end encryption.** Every file is encrypted on the device with AES-256-GCM before it leaves. **File names and
  folders are hidden too**: the server sees a flat folder of `<random>.bin` files.
- **Nothing is ever lost.**
  - The same note changed on two devices keeps both: yours stays at its path, the other version is saved beside it as
    `Note (conflict 2026-11-24 1012).md`.
  - An edit always beats a deletion made on another device.
  - Deleted files go to a trash on both sides (the vault's `.trash`, the server's `.trash/<time>/`), never straight away.
  - A note you are editing while a sync runs is never overwritten.
  - Two devices syncing at the same moment can't overwrite each other.
  - An old copy of the server put back (a backup restore) never rolls a note back.
- **A guard against accidents.** A sync that would delete more than 5 files and over a third of the vault stops and
  shows you the list first. Pointing the plugin at another server, or an empty folder, never deletes anything.
- **Automatic**: on startup, when you come back to Obsidian (the phone app reopened, the window focused), every few minutes, and shortly after you stop typing. Also from the ribbon icon and the
  *Sync now* command.
- **Secrets stay out of the vault**: the password and the passphrase live in Obsidian's secret storage.
- **In your language**: English and Spanish, following Obsidian's language setting.
- **Light**: no background process, about 50 kB of code, and only changed files go over the network.

## Install

The plugin is not in Obsidian's community store yet. Two ways:

- **With [BRAT](https://github.com/TfTHacker/obsidian42-brat)**, which also keeps it updated:
  1. Install *BRAT* from the community plugins.
  2. *BRAT → Add beta plugin* → `juanangel123/obsidian-webdav-sync`.
  3. Enable *WebDAV Vault Sync* in *Settings → Community plugins*.
- **By hand**: download `main.js` and `manifest.json` from the
  [latest release](https://github.com/juanangel123/obsidian-webdav-sync/releases/latest), put them in
  `<vault>/.obsidian/plugins/webdav-vault-sync/`, and enable the plugin.

Requires Obsidian 1.11.4 or later.

## Set up

### First device

1. *Settings → WebDAV Vault Sync*:
   - **Server**: the `https://` address of an **empty folder** on your WebDAV server, one folder per vault.
   - **Username** and **Password** for that server.
   - **Encryption passphrase**: a long one. Write it down somewhere safe: without it, the notes on the server
     can't be read by anyone, including you.
2. Press **Check** (or **Sync**). This sets the vault up on the server with that passphrase.

### Every other device

1. Start from an **empty vault**. A vault with files works too, but any note that exists on both sides with different
   content becomes a conflict copy. A brand-new vault may hold Obsidian's *Welcome* note: delete it first.
2. Install the plugin and enter the same server, username, password and passphrase.
3. Press **Sync**. A wrong passphrase is refused before anything is written.

### Settings

| Setting | Default | |
|---|---|---|
| Sync every (minutes) | 5 | 0 turns it off |
| Sync on startup and on return | on | 3 seconds after Obsidian opens, and whenever you come back to it (not twice within 30 seconds) |
| Sync after editing | on | 20 seconds after your last change |
| Largest file (MB) | 50 | bigger files are left out, never deleted |

Hidden files and folders (those starting with `.`, such as `.obsidian` with your settings and plugins) are not synced.

## The server

Any WebDAV server with HTTPS works. The plugin keeps three things in its folder: `sync.json` (the salt and a
passphrase check, no secret), the `*.bin` files, and `.trash/`. Nothing else in the folder is touched.

A minimal one with [rclone](https://rclone.org), behind a reverse proxy or a tunnel that adds HTTPS:

```sh
rclone serve webdav /srv/notes --addr 127.0.0.1:8080 --user notes --pass '…' \
  --etag-hash MD5 --dir-cache-time 0s
```

`--etag-hash MD5` gives exact change detection; `--dir-cache-time 0s` lets rclone see files changed on its disk
directly (a restore, a cleanup). The server's `.trash/` is never emptied by the plugin: prune old entries with a cron
job if you like (for example, folders older than 30 days).

Plain `http://` is refused except for `localhost`: the password travels with every request.

## How it works

Each sync compares three things for every file: what this device has, what the server has, and what both had after
the last sync. That tells an edit from a deletion on either side:

| This device | Server | Result |
|---|---|---|
| changed | unchanged | uploaded |
| unchanged | changed | downloaded |
| changed | changed | both kept (a conflict copy) when they differ |
| deleted | unchanged | moved to the server's trash |
| unchanged | deleted | moved to this vault's trash |
| deleted | changed | downloaded again (the edit wins) |
| changed | deleted | uploaded again (the edit wins) |

Every change is checked again right before it is made (the server's ETag before writing, the local file before
overwriting), so another device or your typing in between turns it into a comparison instead of an overwrite.

**Encryption.** Your passphrase and a random salt (stored in `sync.json`) go through PBKDF2-SHA-256 (600,000 rounds),
then HKDF gives two keys: AES-256-GCM for contents and HMAC-SHA-256 for names. A file's server name is the HMAC of its
path; the path itself is sealed inside with the content and a version number. The server learns how many files there
are, their approximate sizes and when they change — not their names, folders or contents.

## MCP server (optional): your notes in Claude or another AI app

`mcp/` is a small server that lets an MCP client — such as a custom connector in Claude — search, read and add to
your notes. It runs next to your WebDAV server and behaves like one more device: it reads and writes the encrypted
files the same way the plugin does, keeps nothing on disk, and your devices pick its changes up on their next sync.

- **Tools**: `search_notes` (case and accents ignored), `list_notes`, `read_note`, `create_note`, `append_to_note`.
  It never deletes, moves or renames anything. A note it appends to that you also changed on a device before syncing
  keeps both versions, as with any two devices.
- **The trade-off**: the server needs your encryption passphrase, so whoever controls the machine it runs on can read
  your notes. Without it, the server only ever holds ciphertext. Anything the AI app reads also goes to its provider.
- **Login**: OAuth 2.1 for one person (dynamic client registration, PKCE), with a password of its own; tokens are
  signed, nothing is stored. Only the redirect addresses in `MCP_REDIRECTS` (Claude's by default) and ones back to your own machine (`http://localhost:<port>/…`, for local clients such as Claude Code) can register.
  Changing the password or `MCP_SECRET` logs every client out. Five wrong passwords pause logins for 15 minutes.
- **Run it**: `bun run mcp:build` gives `dist/notes-mcp.js` (~25 kB), run with `bun dist/notes-mcp.js` behind HTTPS;
  settings from the environment, listed at the top of `mcp/main.ts`. About 35 MB of memory.
- **Connect**: in Claude, *Settings → Connectors → Add custom connector*, the address `https://<your server>/mcp`,
  then log in with the password.

## Recovering without Obsidian

From a copy of the server's folder (a backup), with [Bun](https://bun.sh) and a clone of this repository:

```sh
bun install
bun run decrypt <copy of the server folder> <output folder>
```

It asks for the passphrase and writes every note back under its real name. Files from the server's trash come back
under `<output>/.trash/<time>/`.

## Commands

- **Sync now** (also the ribbon icon).
- **Forget sync state**: the next sync compares every file and deletes nothing. Useful after restoring the server
  from a backup.

## Develop

[Bun](https://bun.sh) only.

```sh
bun install
bun run check   # types, tests, build → main.js
bun run e2e     # the plugin in two real Obsidian instances (Windows)
```

The tests need [rclone](https://rclone.org) on the `PATH` (or `RCLONE=<path>`): they sync simulated devices
through a real `rclone serve webdav` — races, interrupted runs, restores, corrupt files, case-insensitive disks.
Without rclone those tests are skipped.

## License

[MIT](LICENSE)
