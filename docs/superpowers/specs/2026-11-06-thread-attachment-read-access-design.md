# Thread attachment read access

## Intent

Let a bot read an uploaded file when that exact attachment is referenced in its conversation. The live trace showed native `read_file` rejecting the server-side attachment path as outside the bot's workspace.

## Goals and constraints

- Grant native workspace tools read-only access to exact attachment files referenced in that thread, including earlier messages in the same conversation.
- Keep workspace confinement and write restrictions intact; do not grant access to the global attachments directory or other threads' files.
- Do not copy files into bot workspaces or desktop containers. This change addresses the observed native `read_file` failure, not binary document parsing or desktop-terminal access.

## Approaches

1. Add the global attachments directory as a read root: rejected because it exposes unrelated uploads.
2. Add typed exact-file grants for validated attachments referenced in the conversation: selected because it fixes the observed denial with the narrowest access while retaining path-based tools.
3. Copy attachments into the bot workspace or mount them into its desktop: rejected because it creates extra copies and lifecycle/security work not needed for the failing native tool.

## Design

Collect only valid standalone attachment references from messages in the current thread, validate that each path is an existing file under the attachments store, and pass typed exact-file grants to native workspace tools. Preserve the existing path-confinement checks for all other files and writes.

## Security hardening proposal

Keep the existing native tools available, including `read_file`, `grep`, and `shell`; do not replace them with an attachment-only reader. Keep attachments read-only, as in the approved design. Represent each attachment authorization as a typed exact-file grant containing both the path written in the message and the canonical file path validated for that turn. Keep these grants separate from directory read roots such as skill folders.

Each tool must match the requested lexical path exactly and verify that its opened or mounted target still matches the pinned canonical path. Exact-file grants must not authorize descendants, directory listing, or recursive search. `read_file` and file-scoped `grep` may read the attachment; shell may read only a read-only bind of that file, never a bind of its parent directory. On Linux, open the validated attachment in the server, verify the opened descriptor still resolves to the pinned canonical path and is a regular file, then pass that descriptor to bubblewrap and mount it with `--ro-bind-fd` at the lexical message path. Keep the descriptor open until the sandbox process exits; do not pass the canonical source pathname to bubblewrap or fall back to pathname binding when descriptor binding is unavailable. If a path is missing, replaced by a link to another target, or replaced by a directory, the grant fails closed. Direct and room turns use the same rule. No attachment is copied into a workspace.

On macOS, the `sandbox-exec` profile must constrain reads as well as writes. It must keep the existing shell tool usable by allowing reads from system/toolchain paths, the current writable workspace roots, configured directory read roots, and exact pinned attachment files; all other host reads are denied. The attachment is never allowed by granting its parent directory. Preserve the existing network behavior and write allowlist. The operator's explicit `ROOTCLAW_SHELL_SANDBOX=off` and global workspace-unrestricted settings remain opt-outs from normal confinement.

The alternative is a dedicated attachment-reading tool backed by an opened file, which further separates attachments from generic workspace access but removes the existing path-based tool workflow. The selected direction for this follow-up is typed exact-file grants because the user wants the full existing tool set while retaining the per-thread boundary.

## Additional verification

After calculating a grant, change a symlinked attachment-store parent and separately replace the granted file with an external symlink and with a directory. The changed path and any descendants must be denied. Confirm the unchanged grant still works through the original symlinked store path, and that shell, `read_file`, and file-scoped `grep` can read only the exact file without writing it. For Linux shell, deterministically replace the canonical source pathname after the server opens the grant but before bubblewrap mounts it; the shell must still see only the descriptor-pinned original file, never the replacement target. Verify the generated macOS sandbox profile allows the exact attachment and normal toolchain/workspace paths but denies an unreferenced sibling and an outside host file; execute the profile on macOS CI when available.

## Verification

Use an isolated RootClaw fixture with synthetic files: a referenced attachment is readable, an unreferenced attachment and an unrelated server file remain denied, and writes to a referenced attachment are refused. Do not use or inspect production attachment contents for tests.
