# inbox-triage: phase 1

Reads new Gmail from the people in your two private matters, triages each message with Claude, files it into your Obsidian vault, and shows a dashboard with a suggested reply you can edit. It runs on the Mac mini.

**Phase 1 sends nothing.** Gmail access is read-only. To answer, copy the reply from the dashboard and send it from Gmail or Superhuman. The item closes on its own once your sent reply shows up in Gmail; a draft you are still writing does not close it.

| Phase | Adds |
|---|---|
| 1 (this) | Gmail read-only, triage, Obsidian notes and attachments, dashboard, setup checks |
| 2 | Send reply and acknowledgement from the dashboard, five-second Undo, double confirmation for the court and the other side, mark read and archive in Gmail |
| 3 | WhatsApp reading through a linked device (one-to-one chats plus the data center and Hydra zone groups) |
| 4 | WhatsApp sending |

## What happens to a message

1. Every minute the service asks Gmail for new mail from the senders listed in `config.json`. Each check looks back a week, so mail that reaches the inbox late (rescued from spam, restored from trash) is still found. It searches all mail, so messages Superhuman auto-archived are found too. Your own mail and Superhuman's reminder emails are ignored.
2. Rules in the config decide the matter, the sender's role (your lawyer, the court, the other side, bank, advisor) and whether replies need review. Gmail's own sender check (DMARC, DKIM, SPF) is read too: mail that fails it is marked **Unverified sender**, because the From address may be forged.
3. Claude (`claude-opus-5-5`) reads the message and up to six earlier messages in its thread. It returns:
   - a title, a summary, the urgency and the reason for it, the task, the due date and a reply-by time;
   - a suggested reply in the sender's language (English, Croatian or Swedish), ending with your sign-off;
   - a short acknowledgement.
4. Fixed rules then apply on top of what Claude returned:
   - Senders marked `alwaysUrgent` are raised to urgent.
   - The court and the other side's lawyers get no acknowledgement.
   - Mail from the court or the other side is always answered through your own lawyer: the draft is written to her, whether you are in To or only in cc.
   - An unverified sender gets no acknowledgement and is never raised to urgent.
   - Facts only you know are left as `[brackets]`.
5. The message is filed in the vault. Attachments are saved in the matter's `attachments/` folder, except files over your Obsidian Sync limit, which stay in `data/large-attachments/` and are linked from the note.
6. The dashboard lists open items, urgent first.
   - A message that needs a reply shows as **Needs reply**. One that needs something done but no reply (for example, upload documents to a portal) shows as **Action needed**; press **Mark done** when it's finished.
   - Rate each urgent item's urgency: **Yes**, or the level it should have been. Your rating replaces Claude's in the queue and in the note.
   - The phase 1 measure is the share of rated urgent flags you agreed with; unrated items don't count. The target is 90% or more.

### The notes

There is one note per email thread, for example `Projects/Sweden legal matter/2026-10-23 Draft statement.md`. A new message in the same thread is added to the end of that note.

The app changes only three things in a note:
- these frontmatter keys: `source`, `project`, `subject`, `gmail`, `from`, `status`, `urgency`, `reply_by`, `due`, `review_required`, `updated`;
- the message sections it adds at the end;
- its own task lines, which end in `^it-<message id>`.

Text and frontmatter keys you add yourself are left alone, so editing a note on your phone never conflicts with the service. Tasks use the Tasks plugin's `📅` due date and work as plain checkboxes without it.

## Set up on the Mac mini

You need macOS, Node.js 22.13 or later (`brew install node@22`), and the Obsidian app with vault B signed in to Obsidian Sync.

```sh
git clone https://github.com/alanduai/inbox-triage.git
cd inbox-triage/initial
npm ci && npm run build
npm run init          # creates config.json and the private data/ folder
```

### 1. Fill in `config.json`

- `owner.emails`: every address that is you.
- `vault.path`: the folder of vault B, the one that contains `.obsidian/`.
- `vault.syncEncryption`: in Obsidian, open **Settings → Sync** and check whether the remote vault uses end-to-end or standard encryption, then write `"end-to-end"` or `"standard"`. Everything syncs either way; the dashboard and `npm run doctor` show which one you have.
- `vault.maxSyncFileMB`: 200 for Obsidian Sync Plus, 5 for Standard.
- `projects`: the real addresses and domains for each matter. An exact address beats a domain rule.
  - Give the court and the other side's law firm `"reviewRequired": true`.
  - Give your lawyer, the court and your bank contact `"alwaysUrgent": true`.
  - Set `counsel` to your own lawyer in the Swedish matter, so drafts answering the court or the other side are addressed to her.
- `signOffs` are already set to "Best regards, Alan", "Lijep pozdrav, Alan" and "Med vänlig hälsning, Alan".

### 2. Let the app read Gmail

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Under **OAuth consent screen**, choose **Internal**. Your address is on a Google Workspace domain, and an Internal app needs no Google review and keeps working. An External app left in "Testing" loses access every 7 days.
3. Under **Credentials**, create an **OAuth client ID** of type **Desktop app**. Download the JSON file and save it as `data/google-oauth-client.json`.
4. On the Mac mini itself, run `npm run auth` and sign in. The app asks for read-only Gmail access.

### 3. Give the app your Anthropic API key

```sh
security add-generic-password -a "$USER" -s inbox-triage-anthropic -w
```

The key stays in the login Keychain, and the service reads it from there.

### 4. Check the setup

```sh
npm run doctor
```

The check covers the following, and saves the report so the dashboard can show it:
- Node.js version, and whether the vault is writable;
- that the Obsidian Sync plugin is on, and the encryption setting you recorded;
- that Obsidian is running and starts at login;
- FileVault, and whether the Mac mini sleeps;
- the Gmail sign-in and the Claude API key;
- that the private data folder is not readable by others.

Fix anything marked ✗ first.

### 5. Try it, then run it in the background

```sh
npm run poll          # one check: files new messages, prints a count
npm start             # dashboard at http://127.0.0.1:8787, checks Gmail every minute
```

When that looks right, stop it with Ctrl-C and install the background service:

```sh
deploy/install-launchd.sh      # starts at login, restarts if it stops; log in data/logs/service.log
deploy/uninstall-launchd.sh    # to remove it
```

Keep Obsidian open on the Mac mini: add it under **System Settings → General → Login Items**. Notes only reach your other devices while Obsidian runs.

### Opening the dashboard from your laptop (optional)

By default the dashboard only answers on the Mac mini itself. To reach it from your home network:
1. Run `node dist/src/cli.js token`.
2. In the config, set `dashboard.host` to `"0.0.0.0"` and `dashboard.token` to that value, then restart the service.
3. Open `http://<mac-mini-name>.local:8787/?token=<token>` once in your browser. It remembers you after that.

The connection is plain HTTP inside your home network. Don't forward the port on your router.

## Privacy and safety

- **Sent to Claude:** the text of in-scope messages, up to six earlier messages in each thread, and the senders' names and addresses. Attachments are not sent; only their names and sizes are.
- **Messages are treated as untrusted data.** The model that reads them has no tools. It is told never to follow instructions inside a message, and requests to change bank details or move money are flagged as possible fraud. The sender's display name is never placed among the trusted facts in the prompt.
- **Notes are inert.** Email text is escaped before it goes into a note, so a message cannot load images, run code or add tags in Obsidian.
- **Stored on the Mac mini:** the message store, Gmail token and logs are in `data/`, readable only by you.
  - FileVault encrypts them on disk. With FileVault on, macOS turns automatic login off, so after a power cut the service starts only once someone logs in.
  - With FileVault off, the Mac starts unattended, but legal notes and tokens sit unencrypted on disk. `npm run doctor` shows which way you have it.
- **Obsidian Sync:** with standard encryption, Obsidian's servers can read the notes, including the legal matter. You chose to sync everything either way; the dashboard shows the current setting.

## Development

```sh
npm test          # builds, then runs the unit and end-to-end tests (fake Gmail and Claude)
npm run typecheck
```

The code is in `src/`:
- `gmail/`: OAuth, reading messages, parsing, links into Gmail
- `scope.ts`: sender rules
- `triage/`: prompt, schema, Claude call
- `obsidian/`: notes and attachments
- `store/`: SQLite
- `server/`: dashboard
- `pipeline.ts`: ties the pieces together
- `doctor.ts`: setup checks
