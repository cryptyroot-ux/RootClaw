# Thread attachment read access

## Intent

Let a bot read an uploaded file when that exact attachment is referenced in its conversation. The live trace showed native `read_file` rejecting the server-side attachment path as outside the bot's workspace.

## Goals and constraints

- Grant native workspace tools read-only access to exact attachment files referenced in that thread, including earlier messages in the same conversation.
- Keep workspace confinement and write restrictions intact; do not grant access to the global attachments directory or other threads' files.
- Do not copy files into bot workspaces or desktop containers. This change addresses the observed native `read_file` failure, not binary document parsing or desktop-terminal access.

## Approaches

1. Add the global attachments directory as a read root: rejected because it exposes unrelated uploads.
2. Add only exact, validated attachment paths referenced in the conversation as read-only roots: selected by the user because it fixes the observed denial with the narrowest access.
3. Copy attachments into the bot workspace or mount them into its desktop: rejected because it creates extra copies and lifecycle/security work not needed for the failing native tool.

## Design

Collect only valid standalone attachment references from messages in the current thread, validate that each path is an existing file under the attachments store, and pass those individual files to native workspace tools as read-only roots. Preserve the existing path-confinement checks for all other files and writes.

## Verification

Use an isolated RootClaw fixture with synthetic files: a referenced attachment is readable, an unreferenced attachment and an unrelated server file remain denied, and writes to a referenced attachment are refused. Do not use or inspect production attachment contents for tests.
