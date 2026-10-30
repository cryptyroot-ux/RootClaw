# Preset bots

What it covers: presets in **New bot** (from imported files and from the
organization's shelf), **Include my New bot defaults as a preset** in Share
team, **Share as preset…** (a preset file: skills and presets, no team), and
adding a preset file back through **Templates → Import**. The product
behaviour is described in [../presets.md](../presets.md).

## HTTP round trip

```sh
pnpm exec vitest run server/presets.e2e.test.ts --silent=false
```

This launches and cleans its own fake-engine fixture through
`launchVerificationServer` (no live URL, no user data). Through the public API
it saves New bot defaults that carry things a preset must never hold (Auto
approval, connected apps, a command allowlist, a routine) plus a password in
the standing instructions, then checks:

- `POST /api/teams/export` with `kind: "library"`: a dry run counts one
  preset and one skill and writes no `published-library.json`; saving writes
  `support-agent-1.0.0.rootclaw.json` with the preset (name, look, picture,
  standing instructions, skill, starter notes), reports the redacted
  instructions, contains no password, approval, connected-app, model or
  routine field, and the next save suggests `1.0.1`;
- a team export includes the defaults preset only with
  `includeDefaultsPreset: true`;
- importing the preset file (the body claims organization trust) adds a
  file preset and no bot or team, and `GET /api/bot-presets` lists it with
  `skillsEnabled: false`;
- `POST /api/bots` with that `preset` adds its skill switched off, its
  starter notes and the `installedPackage.presetKey` stamp, at the default
  Full access level; with the
  saved defaults applied too, the preset's skill wins over the defaults';
- an organization preset (written into `org-library/presets.json` as the
  organization library stores one) is listed first under its publisher and
  its skill is added switched on under the organization's own source;
  writing `org-library/state.json` under the running app does not change
  what New bot offers (the organization library's own state decides; the
  second test withdraws a release through the library);
- an unknown or malformed preset, and a file with skills but no presets, are
  refused without creating anything; an imported preset can be removed, an
  organization's cannot (`409`).

The printed JSON line names the fixture's data directory and server log.

## Units

```sh
pnpm exec vitest run server/presets.test.ts server/routes/bot-presets.test.ts server/package-import.test.ts server/package-export.test.ts shared/package-format.test.ts
```

- `server/presets.test.ts` imports into a real store, skill store and memory
  in a throwaway home: team and library files store their presets (once per
  identical file), a failure after the presets were stored removes them, an
  organization library is added once and keeps its provenance, organization
  presets come first and withdrawn or removed installs are hidden, a
  hand-edited row cannot add an approval level or model and a row with a
  daily log is refused; bots made from file and organization presets get
  their skills off and on respectively, and only the organization preset's
  skill carries the install's stamp (release, `r` and `w` hashes of the
  stored `SKILL.md`, `via: "preset"`); the defaults preset keeps only the
  allowlist; a team file's preset never pushes out a team skill of the same
  name; the preset file round-trips.
- `server/routes/bot-presets.test.ts` drives the two routes through the
  route table.

## Renderer

```sh
pnpm exec vitest run src/lib/bot-presets.test.ts src/components/SharePresetDialog.test.ts src/lib/team-import.test.ts src/lib/team-share.test.ts src/components/ShareTeamDialog.test.ts src/components/NewBotDialog.test.ts src/lib/create-configured-bot.test.ts
ROOTCLAW_UI_E2E=1 pnpm exec vitest run scripts/testing/presets-ui.e2e.test.ts --silent=false
```

The first command covers the Starting role grouping, the draft fields a preset
fills (never the model, computer, approval or connected apps), the picture,
the summary lines, creation passing the preset and leaving its skills and
notes to the server, the share request, part names, the preset file's
contents list and its import preview. The second owns a disposable
`control-rootclaw ui` app: **Settings → Share as preset…** shows the counts and
saves `sky-1.0.0.rootclaw.json` (captured in the page); **Templates →
Import** of that file shows "Preset bots and skills · no team" and **Add
presets** adds it; **Share team** shows no preset until **Include my New bot
defaults as a preset** is ticked; then the review behind **Templates → Add
Scout, Researcher** lists **From Acme Partners**, **Imported presets** and
**Built-in roles** under **Starting role**, and a bot made from
the file preset gets its skill off and its notes, one made from the
organization preset its skill on. Screenshots go to
`.rootclaw-scratch/verify-evidence/presets-*.png`. CI runs it in the advisory
renderer smoke job next to the Share team recipe.

## 2026-09-24: what was actually run

## 2026-09-24: review fixes (PR #1773)

Not production qualification: no real organization, Admin upload or
organization library was involved. Organization presets were written into
`org-library/presets.json` the way the organization library stores them,
and withdrawal was simulated by writing `org-library/state.json`.

## 2026-09-24: organization library seams (follow-up to PR #1773)

Two seams an integration check against the contract found. New bot's
install statuses now come from `OrgLibrary.installStatuses()` (the library's
state in memory) instead of a separate read of `org-library/state.json`, and
an organization preset's skills get the skill-state stamp (§3.2) marked
`via: "preset"`, which the library never counts toward the install.

Not production qualification: no real organization, Admin upload or
organization library was involved.
