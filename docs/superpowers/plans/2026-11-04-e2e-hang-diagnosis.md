# E.1 E2E Hang Diagnosis Plan

Goal: Identify e2e tests that leave open handles, using `--reporter=hanging-process`, in manageable batches.

## Batches (20 files each)

### Batch 1
```bash
npx vitest run server/active-routines-context.e2e.test.ts server/admin-activity.e2e.test.ts server/agents-bridge.e2e.test.ts server/app-events-cloud.e2e.test.ts server/app-events.e2e.test.ts server/app-events.ui.e2e.test.ts server/automation-reports.e2e.test.ts server/automations-lifecycle.e2e.test.ts server/boat-included.e2e.test.ts server/body-thread-guards.e2e.test.ts server/boot-readiness.e2e.test.ts server/bot-continuity.e2e.test.ts server/bot-deletion-write-failure.e2e.test.ts server/bot-setup.e2e.test.ts server/browser-shutdown.e2e.test.ts server/bulk-delete-tasks.e2e.test.ts server/cancelled-turn.e2e.test.ts server/chat-apps-mcp.e2e.test.ts server/chat-apps.e2e.test.ts server/chat-pages.e2e.test.ts  --reporter=hanging-process
```

### Batch 2
```bash
npx vitest run server/chat-widgets.e2e.test.ts server/chief-level-delegation.e2e.test.ts server/chief-level-every-hop.e2e.test.ts server/chief-rooms.e2e.test.ts server/cli-service-trust.e2e.test.ts server/cli-stop.e2e.test.ts server/client-notifications.e2e.test.ts server/cloud-computer-auto-sleep.e2e.test.ts server/cloud-computer-lazy.e2e.test.ts server/cloud-computer-slow-start.e2e.test.ts server/cloud-connected-apps.e2e.test.ts server/cloud-connections.e2e.test.ts server/cloud-credit.e2e.test.ts server/cloud-lending-browser.e2e.test.ts server/cloud-lending-chrome.e2e.test.ts server/cloud-lending-memory.e2e.test.ts server/cloud-onepassword.e2e.test.ts server/cloud-personal.e2e.test.ts server/cloud-routine-level.e2e.test.ts server/cloud-send-kinds.e2e.test.ts  --reporter=hanging-process
```

### Batch 3
```bash
npx vitest run server/cloud-send-move.e2e.test.ts server/cloud-send-rooms.e2e.test.ts server/cloud-send-routine-merge.e2e.test.ts server/cloud-send-store.e2e.test.ts server/cloud-send.e2e.test.ts server/cloud-sharing.e2e.test.ts server/cloud-sync.e2e.test.ts server/cloud-team-admin.e2e.test.ts server/cloud-team-bot-access.e2e.test.ts server/cloud-team-browser.e2e.test.ts server/cloud-team-connections.e2e.test.ts server/cloud-team-engine-homes.e2e.test.ts server/cloud-team-gateway-mcp.e2e.test.ts server/cloud-team-inbox.e2e.test.ts server/cloud-team-one-answer.e2e.test.ts server/cloud-team-open-reach.e2e.test.ts server/cloud-team-owners.e2e.test.ts server/cloud-team-people.e2e.test.ts server/cloud-team-phones.e2e.test.ts server/cloud-team-pictures.e2e.test.ts  --reporter=hanging-process
```

### Batch 4
```bash
npx vitest run server/cloud-team-preference.e2e.test.ts server/cloud-team-private.e2e.test.ts server/cloud-team-profile.e2e.test.ts server/cloud-team-requests.e2e.test.ts server/cloud-team-setup-request.e2e.test.ts server/cloud-team.e2e.test.ts server/computer-engine-removal.e2e.test.ts server/computer-take-control.e2e.test.ts server/connected-app-tools.e2e.test.ts server/context-compaction.e2e.test.ts server/create-bot-model.e2e.test.ts server/decider-included.e2e.test.ts server/decider-rooms.e2e.test.ts server/default-bot.e2e.test.ts server/delete-bot-memory.e2e.test.ts server/delta-context.e2e.test.ts server/desktop-computer.e2e.test.ts server/desktop-updates.e2e.test.ts server/devs-reports.e2e.test.ts server/digest-control.e2e.test.ts  --reporter=hanging-process
```

### Batch 5
```bash
npx vitest run server/direct-coordination.e2e.test.ts server/engine-status-reads.e2e.test.ts server/escalations.e2e.test.ts server/external-runtime-busy.e2e.test.ts server/external-runtime-timeout.e2e.test.ts server/external-runtime.e2e.test.ts server/first-hour.e2e.test.ts server/first-reply-rescue.e2e.test.ts server/folder-pages.e2e.test.ts server/full-access-workflows.e2e.test.ts server/group-goal-run-one-on-one.e2e.test.ts server/group-goal-run.e2e.test.ts server/group-goal-wait-cap.e2e.test.ts server/group-local-vm.e2e.test.ts server/group-thread-usage.e2e.test.ts server/handoff-in-my-folder.e2e.test.ts server/headless-cli.e2e.test.ts server/helper-model.e2e.test.ts server/highlevel.e2e.test.ts server/hooks.e2e.test.ts  --reporter=hanging-process
```

### Batch 6
```bash
npx vitest run server/host-lazy-claim.e2e.test.ts server/hosted-desktop.e2e.test.ts server/incidents.e2e.test.ts server/key-rejected.e2e.test.ts server/late-question-source.e2e.test.ts server/late-question-today.e2e.test.ts server/lent-folders.e2e.test.ts server/limit-reset.e2e.test.ts server/live-approval.e2e.test.ts server/live-config-auth.e2e.test.ts server/long-running-chief.e2e.test.ts server/loop-guard.e2e.test.ts server/main-thread.e2e.test.ts server/mascot-face-color.e2e.test.ts server/mcp-own-servers.e2e.test.ts server/mcp-selection.e2e.test.ts server/memory-capture-restart.e2e.test.ts server/memory-layer.e2e.test.ts server/memory-room-capture.e2e.test.ts server/memory-room-prompt.e2e.test.ts  --reporter=hanging-process
```

### Batch 7
```bash
npx vitest run server/message-search.e2e.test.ts server/model-variant-return.e2e.test.ts server/native-engine-smoke.e2e.test.ts server/native-replay.e2e.test.ts server/new-bot-defaults.e2e.test.ts server/no-rootclaw-cards.e2e.test.ts server/notification-read.e2e.test.ts server/onboarding-model-default.e2e.test.ts server/one-home-keep.e2e.test.ts server/one-home-outdated.e2e.test.ts server/one-home-retry.e2e.test.ts server/one-home-session.e2e.test.ts server/one-home-trial-key.e2e.test.ts server/one-home-two-desks.e2e.test.ts server/one-home.e2e.test.ts server/openai-boat.e2e.test.ts server/openai-compat-vm.e2e.test.ts server/openai-tools.e2e.test.ts server/own-file-reads.e2e.test.ts server/own-home.e2e.test.ts  --reporter=hanging-process
```

### Batch 8
```bash
npx vitest run server/peer-allowlist.e2e.test.ts server/peer-approval.e2e.test.ts server/person-first.e2e.test.ts server/phone-claim.e2e.test.ts server/phones-member-routine.e2e.test.ts server/phones.e2e.test.ts server/place-view.e2e.test.ts server/places-elsewhere.e2e.test.ts server/postiz.e2e.test.ts server/presets.e2e.test.ts server/proactive-routines.e2e.test.ts server/profile-card-lifecycle.e2e.test.ts server/published-pages.e2e.test.ts server/question-cards.e2e.test.ts server/question-routing.e2e.test.ts server/quota-switch.e2e.test.ts server/reactions.e2e.test.ts server/recent-work.e2e.test.ts server/replay-tool-history.e2e.test.ts server/reply-behaviour.e2e.test.ts  --reporter=hanging-process
```

### Batch 9
```bash
npx vitest run server/request-auth.e2e.test.ts server/room-chat-wait.e2e.test.ts server/room-context.e2e.test.ts server/room-coordination.e2e.test.ts server/room-holds.e2e.test.ts server/room-missing-folder.e2e.test.ts server/room-parallel-threads.e2e.test.ts server/room-question-tasks.e2e.test.ts server/room-queue.e2e.test.ts server/room-recovery.e2e.test.ts server/room-roots.e2e.test.ts server/routine-continuity.e2e.test.ts server/routine-cron.e2e.test.ts server/routine-delegation.e2e.test.ts server/routine-recovery.e2e.test.ts server/routine-results.e2e.test.ts server/routine-unanswered-wait.e2e.test.ts server/routine-unattended-approval.e2e.test.ts server/runtime-coordination.e2e.test.ts server/runtime-paths.e2e.test.ts  --reporter=hanging-process
```

### Batch 10
```bash
npx vitest run server/runtime-roots.e2e.test.ts server/safety-floor.e2e.test.ts server/saved-login.e2e.test.ts server/secret-requests.e2e.test.ts server/setup-connect-card.e2e.test.ts server/setup-import.e2e.test.ts server/shared-computers.e2e.test.ts server/shared-user-profile.e2e.test.ts server/sign-in-code.e2e.test.ts server/sign-in-request.e2e.test.ts server/skill-review.e2e.test.ts server/skills-library-config.e2e.test.ts server/spend-cap-goal.e2e.test.ts server/steer-unattended.e2e.test.ts server/surface-pins.e2e.test.ts server/talk-server.e2e.test.ts server/team-lifecycle.e2e.test.ts server/team-memory-integrity.e2e.test.ts server/team-move.e2e.test.ts server/team-package-skills.e2e.test.ts  --reporter=hanging-process
```

### Batch 11
```bash
npx vitest run server/team-personal-mcp-broker.e2e.test.ts server/team-setup.e2e.test.ts server/team-share.e2e.test.ts server/teammate-follow-ups.e2e.test.ts server/tested-ai.e2e.test.ts server/thread-model-follow.e2e.test.ts server/thread-page-frames.e2e.test.ts server/thread-title-regenerate.e2e.test.ts server/tool-results.e2e.test.ts server/tool-scope.e2e.test.ts server/triggers.e2e.test.ts server/trust-controls.e2e.test.ts server/turn-clock.e2e.test.ts server/two-places.e2e.test.ts server/update-apply.e2e.test.ts server/usage-traces.e2e.test.ts server/use-my-mac.e2e.test.ts server/verification-fixture.e2e.test.ts server/voice-notes.e2e.test.ts server/waits.e2e.test.ts  --reporter=hanging-process
```

### Batch 12
```bash
npx vitest run server/webhook-address.e2e.test.ts server/webhook-post-thread.e2e.test.ts server/webhook-restart.e2e.test.ts server/webhook-room-post.e2e.test.ts server/workspace-banner.e2e.test.ts server/x-research.e2e.test.ts  --reporter=hanging-process
```
