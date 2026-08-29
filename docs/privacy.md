# Privacy and data safety

## Local data

The server stores memory in one local SQLite file. It sends no telemetry and calls no hosted service.

The data can still contain private text. Protect the database with normal filesystem permissions and device encryption.

## Scopes

Scopes organize records and affect ranking. They are not access-control boundaries.

Search can cover the full store. Graph links can cross scopes. Statistics and exports can describe the full store.

Use a separate database for each security boundary.

## Snapshots

JSONL snapshots contain plaintext records, edges, feedback, sources, and scope names.

The MCP export tool writes only inside `MULTI_AGENT_MEMORY_EXPORT_DIR`. It rejects directory traversal.

The portability CLI accepts an explicit path because a person starts that command directly.

Do not commit snapshots. Do not attach them to public issues. Delete temporary copies after a transfer.

## Live SQLite files

Do not synchronize a live SQLite file through Dropbox, Google Drive, OneDrive, iCloud, or a network share.

Use a JSONL snapshot to move memory between machines.

## Origins and source fields

The default snapshot origin is `local`. The server does not use the hostname by default.

Source fields can contain paths or names that you supply. Review a snapshot before you share it.
