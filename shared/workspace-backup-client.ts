// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "rootclaw-drafts",
  "rootclaw-draft-attachments",
  "rootclaw-draft-send-ids",
  "rootclaw-draft-channel-modes",
  "rootclaw-skin",
  "rootclaw-show-threads",
  "rootclaw-show-run-card",
  "rootclaw-send-key",
  "rootclaw-color-user-bubbles",
  "rootclaw-chat-width",
  "rootclaw.sidebarDensity",
  "rootclaw.sidebarToolsLayout",
  "rootclaw.sidebarCollapsedSections.v1",
  "rootclaw.sidebarSectionOrder.v1",
  "rootclaw-analytics-opt-out",
  "rootclaw.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
