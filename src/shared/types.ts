// Cross-process type definitions. Imported by both main and renderer.

export type Motion = 'connection_request' | 'sales_nav_inmail';
export type Mode = 'single' | 'batch';
export type AccountTier = 'TAM' | 'Factor' | 'G2' | 'Other';
export type ConnectionDegree = '1st' | '2nd' | '3rd' | 'OUT-OF-NETWORK';
export type ActivityStatus = 'LINKEDIN-QUIET' | 'ACTIVE';
export type Dept = 'QA leaders' | 'engineering leaders' | 'automation leaders' | 'QE leaders';
export type OutreachStatus =
  | 'draft'
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'replied'
  | 'declined'
  | 'failed'
  | 'dropped';

export interface Account {
  id: number;
  user_id: number;
  name: string;
  domain: string | null;
  linkedin_url: string | null;
  location: string | null;
  tier: AccountTier;
}

export interface Prospect {
  id: number;
  user_id: number;
  account_id: number | null;
  full_name: string;
  first_name: string;
  last_name: string | null;
  linkedin_url: string;
  linkedin_slug: string | null;
  apollo_id: string | null;
  title: string | null;
  company_name: string | null;
}

export interface Evidence {
  id: number;
  prospect_id: number;
  captured_at: string;
  captured_via: 'public-profile' | 'sales-nav-lead-page';
  live_headline: string | null;
  live_location: string | null;
  connection_degree: ConnectionDegree | null;
  follower_count: number | null;
  connection_count: number | null;
  activity_status: ActivityStatus | null;
  activity_quotes: string[];
  evidence_quote_for_hook: string | null;
  notes: string | null;
}

export interface ConfidenceScore {
  overall: number;            // 0.0 - 10.0, must be >= 9.0 to pass
  d1_formula: number;         // formula compliance, 0-10 (deterministic)
  d2_evidence: number;        // evidence traceability, 0-10
  d3_specificity: number;     // recipient-specific anchoring, 0-10
  fail_reasons: string[];
  pass: boolean;
}

export interface Draft {
  motion: Motion;
  body: string;
  subject?: string;           // InMail only
  hook: string;
  dept: Dept;
  char_count: number;
  confidence?: ConfidenceScore;
}

export interface GateDecision {
  phase: '0.5' | '0.6' | '0.7' | '0.7.5' | '1.5' | '3' | '7.5';
  decision: 'pass' | 'drop' | 'warn';
  reason?: string;
  meta?: Record<string, unknown>;
}

export interface OrchestratorRequest {
  user_id: number;
  motion: Motion;
  source:
    | { kind: 'linkedin_url'; url: string }
    | { kind: 'sales_nav_url'; url: string };
}

export interface OrchestratorEvent {
  kind:
    | 'phase_started'
    | 'phase_finished'
    | 'gate_decision'
    | 'evidence_captured'
    | 'draft_ready'
    | 'qa_finished'
    | 'sent'
    | 'error'
    | 'log'
    | 'auth_required';
  phase?: string;
  message?: string;
  payload?: unknown;
  ts: string;
}

export interface OrchestratorResult {
  success: boolean;
  outreach_id?: number;
  prospect_id?: number;
  draft?: Draft;
  evidence_id?: number;
  drop_reason?: string;
  events: OrchestratorEvent[];
}

export interface AnalyticsRollup {
  totals: { drafted: number; sent: number; accepted: number; replied: number; declined: number; dropped: number };
  byMotion: Array<{ motion: Motion; sent: number; accepted: number; replied: number; acceptRate: number; replyRate: number }>;
  recentSends: Array<{ day: string; sent: number; accepted: number; replied: number }>;
  dropReasons: Array<{ reason: string; count: number }>;
}

export interface TodaysActionsData {
  pendingReplies: Array<{ id: number; full_name: string; company_name: string | null; replied_at: string; reply_classification: string | null }>;
  newAccepts: Array<{ id: number; full_name: string; company_name: string | null; accepted_at: string }>;
  draftsAwaitingReview: Array<{ id: number; full_name: string; company_name: string | null; confidence: number | null; tier: string | null }>;
  sendsToday: number;
  sendsCapSoft: number;
  sendsCapHard: number;
  recentDrops: Array<{ id: number; full_name: string; company_name: string | null; reason: string | null }>;
  reEngagement: Array<{ id: number; full_name: string; company_name: string | null; status: string; lastTouch: string }>;
  dropRate24h: { drafted: number; dropped: number; rate: number; severity: 'ok' | 'warn' | 'alert' };
}

export interface SyncResult {
  ok: boolean;
  newAccepts: number;
  newReplies: number;
  scanned: number;
  error?: string;
}

// Renderer <-> main IPC contract. Single object exposed via contextBridge.
export interface IpcApi {
  ping: () => Promise<'pong'>;
  getCurrentUser: () => Promise<{ id: number; email: string; display_name: string } | null>;
  importTam: () => Promise<{ inserted: number; total: number }>;
  loginLinkedIn: () => Promise<{ ok: boolean; alreadyLoggedIn: boolean; error?: string }>;
  // Single-prospect orchestrator. Streams events back via onOrchestratorEvent.
  runSingle: (req: OrchestratorRequest) => Promise<OrchestratorResult>;
  onOrchestratorEvent: (cb: (e: OrchestratorEvent) => void) => () => void;
  approveAndSend: (outreach_id: number, opts?: { overrideSoftCap?: boolean }) => Promise<{ ok: boolean; error?: string; throttle?: { dailyCount: number; cap: number } }>;
  todaysSendCount: (motion?: Motion) => Promise<{ count: number }>;
  listOutreach: (limit?: number) => Promise<Array<{
    id: number;
    full_name: string;
    company_name: string | null;
    motion: Motion;
    status: OutreachStatus;
    confidence: number | null;
    drafted_at: string;
    sent_at: string | null;
  }>>;
  // Settings — API keys.
  setAnthropicKey: (key: string) => Promise<{ ok: boolean }>;
  getAnthropicKeyStatus: () => Promise<{ configured: boolean; lastFour: string | null }>;
  setApolloKey: (key: string) => Promise<{ ok: boolean }>;
  getApolloKeyStatus: () => Promise<{ configured: boolean; lastFour: string | null }>;
  checkAnthropicKey: () => Promise<{ ok: boolean; status: 'valid' | 'invalid' | 'rate-limited' | 'network-error' | 'not-configured'; detail: string; httpStatus?: number }>;
  checkApolloKey: () => Promise<{ ok: boolean; status: 'valid' | 'invalid' | 'rate-limited' | 'network-error' | 'not-configured'; detail: string; httpStatus?: number }>;
  // Analytics + reply sync.
  getAnalytics: () => Promise<AnalyticsRollup>;
  getTodaysActions: () => Promise<TodaysActionsData>;
  runSync: () => Promise<SyncResult>;
  // Health.
  getLinkedInStatus: () => Promise<{ state: 'unknown' | 'logged-in' | 'logged-out' | 'error'; lastObservedAt: string | null }>;
  probeLinkedIn: () => Promise<{ state: 'unknown' | 'logged-in' | 'logged-out' | 'error'; lastObservedAt: string | null }>;
  getSalesNavStatus: () => Promise<{ state: 'unknown' | 'logged-in' | 'logged-out' | 'error'; lastObservedAt: string | null }>;
  probeSalesNav: () => Promise<{ state: 'unknown' | 'logged-in' | 'logged-out' | 'error'; lastObservedAt: string | null }>;
  loginSalesNav: () => Promise<{ ok: boolean; alreadyLoggedIn: boolean; error?: string }>;
  // Draft editing.
  updateDraft: (outreach_id: number, patch: { body?: string; subject?: string }) => Promise<{ ok: boolean; char_count: number; confidence: ConfidenceScore | null; rescored?: boolean }>;
  rescoreLLM: (outreach_id: number) => Promise<{ ok: boolean; confidence: ConfidenceScore | null; error?: string }>;
  // Demo + dry-run.
  loadDemoSeeds: () => Promise<{ inserted: number }>;
  simulateSend: (outreach_id: number) => Promise<{ ok: boolean }>;
  // Audit + evidence.
  getGateLog: (outreach_id?: number, limit?: number) => Promise<Array<{ id: number; outreach_id: number | null; prospect_id: number | null; phase: string; decision: string; reason: string | null; ts: string }>>;
  getEvidence: (evidence_id: number) => Promise<Evidence | null>;
  getOutreachDetail: (outreach_id: number) => Promise<OutreachDetail | null>;
  // Skills + playbooks (BDR-sourced, ported into data/seed/).
  listSkills: () => Promise<{
    skills: Array<{ id: string; title: string; content: string; byteSize: number }>;
    playbooks: Array<{ id: string; title: string; content: string; byteSize: number }>;
  }>;
  // Export.
  exportActivity: () => Promise<{ csv: string; rows: number }>;
  // Backup + restore.
  createBackup: () => Promise<{ ok: boolean; entry?: { name: string; path: string; size: number; createdAt: string }; error?: string }>;
  listBackups: () => Promise<Array<{ name: string; path: string; size: number; createdAt: string }>>;
  restoreBackup: (name: string) => Promise<{ ok: boolean; error?: string; preRestoreBackup?: string }>;
  deleteBackup: (name: string) => Promise<{ ok: boolean; error?: string }>;
  // Playwright Chromium install.
  getChromiumStatus: () => Promise<{ ok: boolean; path: string | null; error?: string }>;
  installChromium: () => Promise<{ ok: boolean; error?: string }>;
  onChromiumInstallProgress: (cb: (line: string) => void) => () => void;
  // Persistent send queue.
  listSendQueue: () => Promise<Array<{
    id: number;
    outreach_id: number;
    user_id: number;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    next_attempt_at: string;
    status: 'queued' | 'running' | 'exhausted' | 'done' | 'cancelled';
    full_name?: string;
    company_name?: string | null;
    motion?: 'connection_request' | 'sales_nav_inmail';
  }>>;
  cancelSendQueue: (queueId: number) => Promise<{ ok: boolean }>;
  retrySendQueueNow: (queueId: number) => Promise<{ ok: boolean; error?: string }>;
  requeueOutreach: (outreachId: number) => Promise<{ ok: boolean; queueId?: number; error?: string }>;
  reclassifyReply: (outreachId: number) => Promise<{ classification: 'P0_warm' | 'P1_engaged' | 'P2_decline' | 'P3_auto_reply' | 'P4_hostile'; confidence: number; reasoning: string; shouldDnc: boolean; source: 'llm' | 'heuristic' } | null>;
  setReplyClassification: (outreachId: number, classification: 'P0_warm' | 'P1_engaged' | 'P2_decline' | 'P3_auto_reply' | 'P4_hostile' | null, reason?: string) => Promise<{ ok: boolean }>;
  listClassificationOverrides: (outreachId: number) => Promise<Array<{ id: number; prior_value: string | null; new_value: string | null; reason: string | null; source: string; ts: string }>>;
  reverseAutoDnc: (outreachId: number) => Promise<{ ok: boolean; removed: number }>;
  reverseAutoDncBulk: (outreachIds: number[]) => Promise<{ ok: boolean; removed: number }>;
  setReplyClassificationBulk: (outreachIds: number[], classification: 'P0_warm' | 'P1_engaged' | 'P2_decline' | 'P3_auto_reply' | 'P4_hostile' | null, reason?: string) => Promise<{ ok: boolean; updated: number }>;
  listAutoDncForOutreach: (outreachId: number) => Promise<Array<{ id: number; name_norm: string; display_name: string; company: string | null; reason: string | null; auto_added_reason_kind: string | null }>>;
  // Onboarding (per-step DB tracking).
  getOnboardingState: () => Promise<{
    steps: Array<{
      step_id: 'welcome' | 'linkedin' | 'salesnav' | 'anthropic' | 'apollo' | 'tam' | 'demo' | 'done';
      status: 'pending' | 'completed' | 'skipped';
      completed_at: string | null;
      meta: Record<string, unknown> | null;
    }>;
    complete: boolean;
  }>;
  setOnboardingStep: (
    stepId: 'welcome' | 'linkedin' | 'salesnav' | 'anthropic' | 'apollo' | 'tam' | 'demo' | 'done',
    status: 'pending' | 'completed' | 'skipped',
    meta?: Record<string, unknown>
  ) => Promise<{ ok: boolean }>;
  resetOnboarding: () => Promise<{ ok: boolean }>;
  // Apollo provider mode.
  getApolloMode: () => Promise<{ preference: 'auto' | 'api' | 'ui' | 'off'; resolved: 'api' | 'ui' | 'none'; reason: string }>;
  setApolloMode: (mode: 'auto' | 'api' | 'ui' | 'off') => Promise<{ preference: 'auto' | 'api' | 'ui' | 'off'; resolved: 'api' | 'ui' | 'none'; reason: string }>;
  // Auto-prospect-enroll (TAM account → Apollo search → ranked candidates).
  getIcpTitles: () => Promise<string[]>;
  sourceFromAccount: (args: { accountId: number; titles?: string[]; perPage?: number }) => Promise<{
    ok: boolean;
    candidates: Array<{
      apolloId: string;
      name: string;
      firstName: string;
      lastName: string;
      title: string | null;
      company: string | null;
      linkedinUrl: string | null;
      email?: string;
      preScreen: { pass: boolean; reasons: string[] };
    }>;
    account: { id: number; name: string; tier: string };
    total: number;
    error?: string;
  }>;
  // Folders.
  getDataFolders: () => Promise<{ userData: string; backups: string; profile: string; logs: string; logsDir: string }>;
  openFolder: (kind: 'userData' | 'backups' | 'profile' | 'logs') => Promise<{ ok: boolean; path: string; error?: string }>;
  // Account profile editing.
  updateUser: (patch: { display_name?: string; email?: string }) => Promise<{ ok: boolean }>;
  // INC-028 cooldown management.
  getCooldown: () => Promise<{ active: boolean; until?: string; hoursLeft?: number; meta?: Record<string, unknown>; expiredAt?: string }>;
  clearCooldown: () => Promise<{ ok: boolean }>;
  // Phase 9.6 — End-of-session reconciliation.
  runReconciliation: () => Promise<{
    today: string;
    todayByMotionAndStatus: Array<{ motion: string; status: string; c: number }>;
    draftedNotSent: number;
    dropsByReason: Array<{ reason: string; count: number }>;
    queue: { queued: number; exhausted: number; doneToday: number };
    cooldownActive: boolean;
    week7d: { sent: number; accepted: number; replied: number; weeklySoftCap: number; weeklyHardCap: number };
  }>;
  getLastReconciliation: () => Promise<{ value: string; updated_at: string } | null>;
  // Health diagnostics.
  runPreflight: () => Promise<{
    ts: string;
    overall: 'ok' | 'warn' | 'error' | 'info';
    checks: Array<{
      id: string;
      label: string;
      status: 'ok' | 'warn' | 'error' | 'info';
      detail: string;
      fixHint?: string;
      meta?: Record<string, unknown>;
    }>;
  }>;
  getLogTail: (maxLines?: number) => Promise<{
    path: string | null;
    size: number;
    entries: Array<{ ts: string | null; level: string | null; text: string; raw: string }>;
  }>;
  // Accounts.
  listAccounts: () => Promise<Array<{
    id: number;
    name: string;
    domain: string | null;
    tier: AccountTier;
    location: string | null;
    prospect_count: number;
    sent_count: number;
    accepted_count: number;
  }>>;
  getAccountDetail: (accountId: number) => Promise<{
    account: Account;
    prospects: Array<{ id: number; full_name: string; title: string | null; linkedin_url: string }>;
    outreach: Array<{
      id: number;
      full_name: string;
      title: string | null;
      motion: Motion;
      status: OutreachStatus;
      confidence: number | null;
      drafted_at: string;
      sent_at: string | null;
    }>;
  } | null>;
}

export interface OutreachDetail {
  id: number;
  motion: Motion;
  status: OutreachStatus;
  draft_body: string;
  draft_subject: string | null;
  hook: string;
  dept: string;
  char_count: number;
  confidence: number | null;
  confidence_notes: ConfidenceScore | null;
  status_reason: string | null;
  tier: 'A' | 'A+' | 'A++' | null;
  reply_classification: 'P0_warm' | 'P1_engaged' | 'P2_decline' | 'P3_auto_reply' | 'P4_hostile' | null;
  reply_body: string | null;
  prospect: {
    id: number;
    full_name: string;
    first_name: string;
    company_name: string | null;
    title: string | null;
    linkedin_url: string;
    apollo_company: string | null;
    apollo_title: string | null;
    apollo_employment: Array<{
      organization_name?: string;
      title?: string;
      current?: boolean;
      start_date?: string;
      end_date?: string;
    }> | null;
  };
  evidence: Evidence | null;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
