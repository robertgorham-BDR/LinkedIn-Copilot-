import { BrowserWindow, ipcMain } from 'electron';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import log from 'electron-log';
import { ensureDefaultUser, getDb } from '../db/client';
import { seedAccounts } from '../db/seed';
import { isLinkedInLoggedIn, isSalesNavLoggedIn, startLinkedInLogin, startSalesNavLogin } from '../browser/session';
import { runSingle } from '../agent/orchestrator';
import { approveAndSend, todaysSendCount } from '../agent/sending';
import { runPreflight } from '../health/preflight';
import { readLogTail } from '../health/logTail';
import { createBackup, listBackups, restoreBackup, deleteBackup } from '../db/backup';
import { installChromium, isChromiumInstalled } from '../health/playwrightInstall';
import { encryptKey, decryptKey, isEncryptionAvailable } from '../secrets';
import { checkAnthropicKey, checkApolloKey } from '../health/keyChecks';
import { classifyAndPersist, type ReplyClass } from '../agent/replyClassifier';
import { listQueue, cancelQueueRow, retryNow, requeueOutreach } from '../agent/sendQueue';
import { getStepStates, setStepStatus, resetOnboarding, isOnboardingComplete, type StepId, type StepStatus } from '../onboarding';
import { getApolloMode, setApolloMode, type ApolloMode } from '../agent/apollo';
import { sourceFromAccount, DEFAULT_ICP_TITLES } from '../agent/autoProspect';
import { openFolder, getDataFolders } from './folders';
import { buildAnalytics, buildTodaysActions } from '../agent/analytics';
import { runReplySync } from '../agent/sync';
import { getLinkedInState, setLinkedInState, getSalesNavState, setSalesNavState } from '../runtime-state';
import { TEMPLATE_HARD_CONSTRAINTS } from '../agent/drafting';
import { INMAIL_HARD_CONSTRAINTS } from '../agent/inmail';
import { scoreD2D3 } from '../agent/llm';
import { loadDemoSeeds } from '../agent/demo-seeds';
import type { ConfidenceScore, OrchestratorEvent, OrchestratorRequest, OutreachDetail } from '@shared/types';

type GetWindow = () => BrowserWindow | null;

function lastFour(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.slice(-4);
}

function rescoreD1(motion: string, body: string, subject: string | null, hook: string): { d1: number; fails: string[] } {
  const fails: string[] = [];
  let d1 = 10;
  if (motion === 'connection_request') {
    const c = TEMPLATE_HARD_CONSTRAINTS;
    if (body.length < c.minChars) { d1 -= 3; fails.push(`char_count ${body.length} < ${c.minChars}`); }
    if (body.length > c.maxChars) { d1 -= 3; fails.push(`char_count ${body.length} > ${c.maxChars}`); }
    for (const ch of c.forbiddenChars) if (body.includes(ch)) { d1 -= 4; fails.push(`forbidden char "${ch}"`); }
    for (const p of c.requiredPhrases) if (!body.includes(p)) { d1 -= 4; fails.push(`missing phrase "${p}"`); }
    if (!body.endsWith(c.signoff)) { d1 -= 4; fails.push(`signoff must end with "${c.signoff}"`); }
    if (/[.?!]/.test(hook)) { d1 -= 2; fails.push('hook must be a noun phrase'); }
    if (hook.length < 5) { d1 -= 3; fails.push('hook too short'); }
  } else {
    const c = INMAIL_HARD_CONSTRAINTS;
    if (body.length < c.bodyMinChars) { d1 -= 3; fails.push(`body too short (${body.length} < ${c.bodyMinChars})`); }
    if (body.length > c.bodyMaxChars) { d1 -= 2; fails.push(`body too long (${body.length} > ${c.bodyMaxChars})`); }
    const wc = (subject ?? '').split(/\s+/).filter(Boolean).length;
    if (wc < c.subjectMinWords) { d1 -= 3; fails.push(`subject too short (${wc} < ${c.subjectMinWords})`); }
    if (wc > c.subjectMaxWords) { d1 -= 3; fails.push(`subject too long (${wc} > ${c.subjectMaxWords})`); }
    for (const ch of c.forbiddenChars) {
      if (body.includes(ch) || (subject ?? '').includes(ch)) { d1 -= 4; fails.push(`forbidden char "${ch}"`); }
    }
    for (const p of c.requiredPhrases) {
      if (!body.includes(p)) { d1 -= 4; fails.push(`missing phrase "${p}"`); }
    }
  }
  return { d1: Math.max(0, d1), fails };
}

export function registerIpc(getWindow: GetWindow): void {
  ipcMain.handle('ping', () => 'pong');

  ipcMain.handle('user:current', () => ensureDefaultUser());

  ipcMain.handle('seed:tam', () => {
    const u = ensureDefaultUser();
    return seedAccounts(u.id);
  });

  ipcMain.handle('linkedin:login', async () => {
    const u = ensureDefaultUser();
    try {
      const already = await isLinkedInLoggedIn(u.id);
      if (already) { setLinkedInState('logged-in'); return { ok: true, alreadyLoggedIn: true }; }
      await startLinkedInLogin(u.id);
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 15000));
        if (await isLinkedInLoggedIn(u.id)) { setLinkedInState('logged-in'); return { ok: true, alreadyLoggedIn: false }; }
      }
      setLinkedInState('logged-out');
      return { ok: false, alreadyLoggedIn: false, error: 'login timed out — try again' };
    } catch (err) {
      log.error('linkedin:login failed', err);
      setLinkedInState('error');
      return { ok: false, alreadyLoggedIn: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('linkedin:status', () => getLinkedInState());

  ipcMain.handle('linkedin:probe', async () => {
    try {
      const u = ensureDefaultUser();
      const ok = await isLinkedInLoggedIn(u.id);
      setLinkedInState(ok ? 'logged-in' : 'logged-out');
      return getLinkedInState();
    } catch (err) {
      log.warn('linkedin:probe failed', err);
      setLinkedInState('error');
      return getLinkedInState();
    }
  });

  ipcMain.handle('salesnav:login', async () => {
    const u = ensureDefaultUser();
    try {
      const already = await isSalesNavLoggedIn(u.id);
      if (already) { setSalesNavState('logged-in'); return { ok: true, alreadyLoggedIn: true }; }
      await startSalesNavLogin(u.id);
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 15000));
        if (await isSalesNavLoggedIn(u.id)) { setSalesNavState('logged-in'); return { ok: true, alreadyLoggedIn: false }; }
      }
      setSalesNavState('logged-out');
      return { ok: false, alreadyLoggedIn: false, error: 'Sales Nav login timed out — try again' };
    } catch (err) {
      log.error('salesnav:login failed', err);
      setSalesNavState('error');
      return { ok: false, alreadyLoggedIn: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('salesnav:status', () => getSalesNavState());

  ipcMain.handle('salesnav:probe', async () => {
    try {
      const u = ensureDefaultUser();
      const ok = await isSalesNavLoggedIn(u.id);
      setSalesNavState(ok ? 'logged-in' : 'logged-out');
      return getSalesNavState();
    } catch (err) {
      log.warn('salesnav:probe failed', err);
      setSalesNavState('error');
      return getSalesNavState();
    }
  });

  ipcMain.handle('orch:single', async (_e, req: OrchestratorRequest) => {
    const win = getWindow();
    const emit = (e: OrchestratorEvent) => {
      try { win?.webContents.send('orch:event', e); } catch (err) { log.warn('emit failed', err); }
    };
    return await runSingle(req, emit);
  });

  ipcMain.handle('outreach:send', async (_e, outreachId: number, opts?: { overrideSoftCap?: boolean }) => {
    const u = ensureDefaultUser();
    return await approveAndSend(u.id, outreachId, opts);
  });

  ipcMain.handle('analytics:todaysSendCount', (_e, motion?: string) => {
    const u = ensureDefaultUser();
    return { count: todaysSendCount(u.id, motion) };
  });

  ipcMain.handle('health:preflight', () => runPreflight());
  ipcMain.handle('health:logTail', (_e, maxLines?: number) => readLogTail(maxLines ?? 200));

  ipcMain.handle('backup:create', async () => {
    try {
      const e = await createBackup();
      return { ok: true, entry: e };
    } catch (err) {
      log.error('backup:create failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('backup:list', () => listBackups());

  ipcMain.handle('backup:restore', (_e, name: string) => restoreBackup(name));

  ipcMain.handle('backup:delete', (_e, name: string) => deleteBackup(name));

  ipcMain.handle('playwright:status', () => isChromiumInstalled());

  ipcMain.handle('playwright:install', async () => {
    const win = getWindow();
    const r = await installChromium((line) => {
      try { win?.webContents.send('playwright:install:progress', line); } catch { /* swallow */ }
    });
    return r;
  });

  ipcMain.handle('queue:list', () => {
    const u = ensureDefaultUser();
    return listQueue(u.id);
  });

  ipcMain.handle('queue:cancel', (_e, queueId: number) => {
    const u = ensureDefaultUser();
    return cancelQueueRow(u.id, queueId);
  });

  ipcMain.handle('queue:retryNow', (_e, queueId: number) => {
    const u = ensureDefaultUser();
    return retryNow(u.id, queueId);
  });

  ipcMain.handle('queue:requeueOutreach', (_e, outreachId: number) => {
    const u = ensureDefaultUser();
    return requeueOutreach(u.id, outreachId);
  });

  ipcMain.handle('reply:reclassify', async (_e, outreachId: number) => {
    const u = ensureDefaultUser();
    return await classifyAndPersist(u.id, outreachId);
  });

  ipcMain.handle('reply:setClassification', (_e, outreachId: number, classification: ReplyClass | null, reason?: string) => {
    const u = ensureDefaultUser();
    const conn = getDb();
    // Read prior value for audit trail.
    const priorRow = conn
      .prepare('SELECT reply_classification FROM outreach WHERE id = ? AND user_id = ?')
      .get(outreachId, u.id) as { reply_classification: string | null } | undefined;
    const priorValue = priorRow?.reply_classification ?? null;
    if (priorValue !== classification) {
      conn
        .prepare(
          `INSERT INTO classification_overrides (outreach_id, user_id, prior_value, new_value, reason, source)
           VALUES (?, ?, ?, ?, ?, 'manual')`
        )
        .run(outreachId, u.id, priorValue, classification, reason ?? null);
    }
    conn
      .prepare(
        `UPDATE outreach SET reply_classification = ?, reply_classified_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      )
      .run(classification, outreachId, u.id);
    return { ok: true };
  });

  // Bulk classification override — applied across N outreach rows in one transaction.
  ipcMain.handle('reply:setClassificationBulk', (_e, outreachIds: number[], classification: ReplyClass | null, reason?: string) => {
    const u = ensureDefaultUser();
    if (!Array.isArray(outreachIds) || outreachIds.length === 0) return { ok: true, updated: 0 };
    const conn = getDb();
    const readPrior = conn.prepare('SELECT reply_classification FROM outreach WHERE id = ? AND user_id = ?');
    const writeAudit = conn.prepare(
      `INSERT INTO classification_overrides (outreach_id, user_id, prior_value, new_value, reason, source)
       VALUES (?, ?, ?, ?, ?, 'bulk')`
    );
    const writeOutreach = conn.prepare(
      `UPDATE outreach SET reply_classification = ?, reply_classified_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    );
    const tx = conn.transaction((ids: number[]) => {
      let n = 0;
      for (const id of ids) {
        const prior = readPrior.get(id, u.id) as { reply_classification: string | null } | undefined;
        const priorValue = prior?.reply_classification ?? null;
        if (priorValue !== classification) {
          writeAudit.run(id, u.id, priorValue, classification, reason ?? null);
        }
        const info = writeOutreach.run(classification, id, u.id);
        if (info.changes > 0) n++;
      }
      return n;
    });
    const updated = tx(outreachIds);
    return { ok: true, updated };
  });

  // List the audit trail of classification changes for one outreach (for the UI).
  ipcMain.handle('reply:listOverrides', (_e, outreachId: number) => {
    const u = ensureDefaultUser();
    return getDb()
      .prepare(
        `SELECT id, prior_value, new_value, reason, source, ts
         FROM classification_overrides
         WHERE outreach_id = ? AND user_id = ?
         ORDER BY ts DESC LIMIT 20`
      )
      .all(outreachId, u.id);
  });

  // Bulk auto-DNC reversal — useful when a sweep of incorrect classifications
  // triggered auto-DNC across multiple prospects.
  ipcMain.handle('dnc:reverseAutoBulk', (_e, outreachIds: number[]) => {
    const u = ensureDefaultUser();
    if (!Array.isArray(outreachIds) || outreachIds.length === 0) return { ok: true, removed: 0 };
    const conn = getDb();
    const placeholders = outreachIds.map(() => '?').join(',');
    const info = conn
      .prepare(
        `DELETE FROM dnc
         WHERE user_id = ?
           AND auto_added_from_outreach_id IN (${placeholders})
           AND auto_added_reason_kind IN ('hostile_reply', 'inc_030_burn')`
      )
      .run(u.id, ...outreachIds);
    return { ok: true, removed: info.changes };
  });

  // Reverse an auto-DNC entry (e.g., classifier was wrong). Only auto-added rows
  // can be reversed; manual DNC entries stay locked.
  ipcMain.handle('dnc:reverseAuto', (_e, outreachId: number) => {
    const u = ensureDefaultUser();
    const info = getDb()
      .prepare(
        `DELETE FROM dnc
         WHERE user_id = ?
           AND auto_added_from_outreach_id = ?
           AND auto_added_reason_kind IN ('hostile_reply', 'inc_030_burn')`
      )
      .run(u.id, outreachId);
    return { ok: info.changes > 0, removed: info.changes };
  });

  // List auto-DNC rows tied to a specific outreach (so the UI can show
  // "this prospect was auto-DNC'd from this outreach" + offer reversal).
  ipcMain.handle('dnc:listAutoForOutreach', (_e, outreachId: number) => {
    const u = ensureDefaultUser();
    return getDb()
      .prepare(
        `SELECT id, name_norm, display_name, company, reason, auto_added_reason_kind
         FROM dnc WHERE user_id = ? AND auto_added_from_outreach_id = ?`
      )
      .all(u.id, outreachId);
  });

  ipcMain.handle('onboarding:state', () => {
    const u = ensureDefaultUser();
    return { steps: getStepStates(u.id), complete: isOnboardingComplete(u.id) };
  });

  ipcMain.handle('onboarding:setStep', (_e, stepId: StepId, status: StepStatus, meta?: Record<string, unknown>) => {
    const u = ensureDefaultUser();
    setStepStatus(u.id, stepId, status, meta);
    return { ok: true };
  });

  ipcMain.handle('onboarding:reset', () => {
    const u = ensureDefaultUser();
    resetOnboarding(u.id);
    return { ok: true };
  });

  ipcMain.handle('apollo:getMode', () => getApolloMode());
  ipcMain.handle('apollo:setMode', (_e, mode: ApolloMode) => {
    setApolloMode(mode);
    return getApolloMode();
  });

  ipcMain.handle('autoprospect:icpTitles', () => DEFAULT_ICP_TITLES);

  ipcMain.handle('autoprospect:fromAccount', async (_e, args: { accountId: number; titles?: string[]; perPage?: number }) => {
    const u = ensureDefaultUser();
    return await sourceFromAccount({
      userId: u.id,
      accountId: args.accountId,
      titles: args.titles,
      perPage: args.perPage
    });
  });

  ipcMain.handle('folders:get', () => getDataFolders());
  ipcMain.handle('folders:open', (_e, kind: 'userData' | 'backups' | 'profile' | 'logs') => openFolder(kind));

  ipcMain.handle('user:update', (_e, patch: { display_name?: string; email?: string }) => {
    const u = ensureDefaultUser();
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.display_name !== undefined) { sets.push('display_name = ?'); args.push(patch.display_name); }
    if (patch.email !== undefined) { sets.push('email = ?'); args.push(patch.email); }
    if (sets.length === 0) return { ok: true };
    sets.push("updated_at = datetime('now')");
    args.push(u.id);
    getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return { ok: true };
  });

  ipcMain.handle('outreach:simulateSend', (_e, outreachId: number) => {
    const u = ensureDefaultUser();
    const info = getDb()
      .prepare(
        `UPDATE outreach SET status='sent', sent_at=datetime('now'),
         status_reason=COALESCE(status_reason,'') || ' (simulated)'
         WHERE id=? AND user_id=? AND status='draft'`
      )
      .run(outreachId, u.id);
    return { ok: info.changes === 1 };
  });

  ipcMain.handle('outreach:list', (_e, limit: number) => {
    const u = ensureDefaultUser();
    return getDb()
      .prepare(
        `SELECT o.id, p.full_name, p.company_name, o.motion, o.status, o.confidence,
                o.drafted_at, o.sent_at
         FROM outreach o JOIN prospects p ON p.id = o.prospect_id
         WHERE o.user_id = ?
         ORDER BY o.drafted_at DESC LIMIT ?`
      )
      .all(u.id, limit);
  });

  ipcMain.handle('outreach:detail', (_e, outreachId: number): OutreachDetail | null => {
    const u = ensureDefaultUser();
    const row = getDb()
      .prepare(
        `SELECT o.id, o.motion, o.status, o.draft_body, o.draft_subject, o.hook, o.dept,
                o.char_count, o.confidence, o.confidence_notes, o.status_reason, o.evidence_id,
                o.tier, o.reply_classification, o.reply_body,
                p.id AS prospect_id, p.full_name, p.first_name, p.company_name, p.title, p.linkedin_url,
                p.apollo_company, p.apollo_title, p.apollo_employment
         FROM outreach o JOIN prospects p ON p.id = o.prospect_id
         WHERE o.id = ? AND o.user_id = ?`
      )
      .get(outreachId, u.id) as Record<string, unknown> | undefined;
    if (!row) return null;
    let evidence = null;
    if (row.evidence_id) {
      const ev = getDb()
        .prepare(`SELECT * FROM evidence WHERE id = ?`)
        .get(row.evidence_id) as Record<string, unknown> | undefined;
      if (ev) {
        evidence = {
          id: ev.id as number,
          prospect_id: ev.prospect_id as number,
          captured_at: ev.captured_at as string,
          captured_via: ev.captured_via as 'public-profile' | 'sales-nav-lead-page',
          live_headline: (ev.live_headline as string) ?? null,
          live_location: (ev.live_location as string) ?? null,
          connection_degree: (ev.connection_degree as '1st' | '2nd' | '3rd' | 'OUT-OF-NETWORK') ?? null,
          follower_count: (ev.follower_count as number) ?? null,
          connection_count: (ev.connection_count as number) ?? null,
          activity_status: (ev.activity_status as 'LINKEDIN-QUIET' | 'ACTIVE') ?? null,
          activity_quotes: ev.activity_quotes ? (JSON.parse(ev.activity_quotes as string) as string[]) : [],
          evidence_quote_for_hook: (ev.evidence_quote_for_hook as string) ?? null,
          notes: (ev.notes as string) ?? null
        };
      }
    }
    return {
      id: row.id as number,
      motion: row.motion as 'connection_request' | 'sales_nav_inmail',
      status: row.status as OutreachDetail['status'],
      draft_body: row.draft_body as string,
      draft_subject: (row.draft_subject as string) ?? null,
      hook: row.hook as string,
      dept: row.dept as string,
      char_count: row.char_count as number,
      confidence: (row.confidence as number) ?? null,
      confidence_notes: row.confidence_notes ? JSON.parse(row.confidence_notes as string) : null,
      status_reason: (row.status_reason as string) ?? null,
      tier: (row.tier as 'A' | 'A+' | 'A++' | null) ?? null,
      reply_classification: (row.reply_classification as OutreachDetail['reply_classification']) ?? null,
      reply_body: (row.reply_body as string) ?? null,
      prospect: {
        id: row.prospect_id as number,
        full_name: row.full_name as string,
        first_name: row.first_name as string,
        company_name: (row.company_name as string) ?? null,
        title: (row.title as string) ?? null,
        linkedin_url: row.linkedin_url as string,
        apollo_company: (row.apollo_company as string) ?? null,
        apollo_title: (row.apollo_title as string) ?? null,
        apollo_employment: row.apollo_employment
          ? (() => {
              try {
                const parsed = JSON.parse(row.apollo_employment as string);
                return Array.isArray(parsed) ? parsed : null;
              } catch {
                return null;
              }
            })()
          : null
      },
      evidence
    };
  });

  ipcMain.handle('outreach:update', async (_e, outreachId: number, patch: { body?: string; subject?: string }) => {
    const u = ensureDefaultUser();
    const row = getDb()
      .prepare(
        `SELECT o.motion, o.draft_body, o.draft_subject, o.hook, o.confidence_notes, e.live_headline, e.evidence_quote_for_hook, e.activity_status
         FROM outreach o LEFT JOIN evidence e ON e.id = o.evidence_id
         WHERE o.id=? AND o.user_id=?`
      )
      .get(outreachId, u.id) as
      | { motion: string; draft_body: string; draft_subject: string | null; hook: string; confidence_notes: string;
          live_headline: string | null; evidence_quote_for_hook: string | null; activity_status: string | null }
      | undefined;
    if (!row) return { ok: false, char_count: 0, confidence: null };
    const newBody = patch.body ?? row.draft_body;
    const newSubject = patch.subject ?? row.draft_subject;
    const { d1, fails } = rescoreD1(row.motion, newBody, newSubject, row.hook);
    const prior = row.confidence_notes ? (JSON.parse(row.confidence_notes) as ConfidenceScore) : null;

    // Patch-and-re-QA: if D1 still passes AND we have an LLM, re-run D2/D3 too
    // (covers the case where a hook edit changes specificity / evidence trace).
    // If LLM isn't available, fall back to the prior D2/D3 values.
    let d2 = prior?.d2_evidence ?? 9;
    let d3 = prior?.d3_specificity ?? 9;
    let llmFails: string[] = [];
    let rescored = false;
    if (d1 === 10) {
      try {
        const llm = await scoreD2D3({
          draftBody: newBody,
          hook: row.hook,
          liveHeadline: row.live_headline,
          evidenceQuote: row.evidence_quote_for_hook,
          activityStatus: ((row.activity_status as string) ?? 'LINKEDIN-QUIET') as 'LINKEDIN-QUIET' | 'ACTIVE'
        });
        d2 = llm.d2_evidence;
        d3 = llm.d3_specificity;
        llmFails = llm.fail_reasons;
        rescored = llm.source === 'llm';
      } catch (err) {
        log.warn('outreach:update D2/D3 re-score failed; keeping prior values', err);
      }
    }
    const overall = Number((d1 * 0.4 + d2 * 0.35 + d3 * 0.25).toFixed(2));
    const pass = d1 === 10 && d2 >= 9 && overall >= 9.0;
    const confidence: ConfidenceScore = {
      overall, d1_formula: d1, d2_evidence: d2, d3_specificity: d3,
      fail_reasons: [...fails, ...llmFails],
      pass
    };
    getDb()
      .prepare(`UPDATE outreach SET draft_body=?, draft_subject=?, char_count=?, confidence=?, confidence_notes=?, status=CASE WHEN ?=1 THEN 'draft' ELSE status END WHERE id=?`)
      .run(newBody, newSubject, newBody.length, overall, JSON.stringify(confidence), pass ? 1 : 0, outreachId);
    return { ok: true, char_count: newBody.length, confidence, rescored };
  });

  ipcMain.handle('outreach:rescoreLLM', async (_e, outreachId: number) => {
    const u = ensureDefaultUser();
    const row = getDb()
      .prepare(
        `SELECT o.motion, o.draft_body, o.hook, o.confidence_notes, e.live_headline, e.evidence_quote_for_hook, e.activity_status
         FROM outreach o LEFT JOIN evidence e ON e.id = o.evidence_id
         WHERE o.id=? AND o.user_id=?`
      )
      .get(outreachId, u.id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, confidence: null, error: 'outreach not found' };
    try {
      const llm = await scoreD2D3({
        draftBody: row.draft_body as string,
        hook: row.hook as string,
        liveHeadline: (row.live_headline as string) ?? null,
        evidenceQuote: (row.evidence_quote_for_hook as string) ?? null,
        activityStatus: ((row.activity_status as string) ?? 'LINKEDIN-QUIET') as 'LINKEDIN-QUIET' | 'ACTIVE'
      });
      const subject = (row as { draft_subject?: string | null }).draft_subject ?? null;
      const { d1, fails } = rescoreD1(row.motion as string, row.draft_body as string, subject, row.hook as string);
      const overall = Number((d1 * 0.4 + llm.d2_evidence * 0.35 + llm.d3_specificity * 0.25).toFixed(2));
      const pass = d1 === 10 && llm.d2_evidence >= 9 && overall >= 9.0;
      const confidence: ConfidenceScore = {
        overall, d1_formula: d1, d2_evidence: llm.d2_evidence, d3_specificity: llm.d3_specificity,
        fail_reasons: [...fails, ...llm.fail_reasons], pass
      };
      getDb()
        .prepare(`UPDATE outreach SET confidence=?, confidence_notes=?, status=CASE WHEN ?=1 THEN 'draft' ELSE status END WHERE id=?`)
        .run(overall, JSON.stringify(confidence), pass ? 1 : 0, outreachId);
      return { ok: true, confidence };
    } catch (err) {
      return { ok: false, confidence: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:setAnthropicKey', (_e, key: string) => {
    const u = ensureDefaultUser();
    const trimmed = key.trim();
    const enc = trimmed ? encryptKey(trimmed) : null;
    getDb()
      .prepare("UPDATE users SET anthropic_api_key_enc = ?, anthropic_api_key = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(enc, u.id);
    return { ok: true, encrypted: isEncryptionAvailable() };
  });

  ipcMain.handle('settings:getAnthropicKey', () => {
    const u = ensureDefaultUser();
    const row = getDb()
      .prepare('SELECT anthropic_api_key, anthropic_api_key_enc FROM users WHERE id = ?')
      .get(u.id) as { anthropic_api_key: string | null; anthropic_api_key_enc: Buffer | null };
    const plain = row?.anthropic_api_key ?? decryptKey(row?.anthropic_api_key_enc);
    return { configured: !!plain, lastFour: lastFour(plain), encrypted: !!row?.anthropic_api_key_enc };
  });

  ipcMain.handle('settings:setApolloKey', (_e, key: string) => {
    const u = ensureDefaultUser();
    const trimmed = key.trim();
    const enc = trimmed ? encryptKey(trimmed) : null;
    getDb()
      .prepare("UPDATE users SET apollo_api_key_enc = ?, apollo_api_key = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(enc, u.id);
    return { ok: true, encrypted: isEncryptionAvailable() };
  });

  ipcMain.handle('settings:getApolloKey', () => {
    const u = ensureDefaultUser();
    const row = getDb()
      .prepare('SELECT apollo_api_key, apollo_api_key_enc FROM users WHERE id = ?')
      .get(u.id) as { apollo_api_key: string | null; apollo_api_key_enc: Buffer | null };
    const plain = row?.apollo_api_key ?? decryptKey(row?.apollo_api_key_enc);
    return { configured: !!plain, lastFour: lastFour(plain), encrypted: !!row?.apollo_api_key_enc };
  });

  // Health probes for the configured keys. Uses cheap upstream calls.
  ipcMain.handle('settings:checkAnthropicKey', async () => {
    const u = ensureDefaultUser();
    const row = getDb()
      .prepare('SELECT anthropic_api_key, anthropic_api_key_enc FROM users WHERE id = ?')
      .get(u.id) as { anthropic_api_key: string | null; anthropic_api_key_enc: Buffer | null };
    const plain = row?.anthropic_api_key ?? decryptKey(row?.anthropic_api_key_enc);
    return await checkAnthropicKey(plain);
  });

  ipcMain.handle('settings:checkApolloKey', async () => {
    const u = ensureDefaultUser();
    const row = getDb()
      .prepare('SELECT apollo_api_key, apollo_api_key_enc FROM users WHERE id = ?')
      .get(u.id) as { apollo_api_key: string | null; apollo_api_key_enc: Buffer | null };
    const plain = row?.apollo_api_key ?? decryptKey(row?.apollo_api_key_enc);
    return await checkApolloKey(plain);
  });

  ipcMain.handle('analytics:get', () => {
    const u = ensureDefaultUser();
    return buildAnalytics(u.id);
  });

  ipcMain.handle('analytics:todaysActions', () => {
    const u = ensureDefaultUser();
    return buildTodaysActions(u.id);
  });

  // INC-028 cooldown management. Surfaced in Health page + Settings.
  ipcMain.handle('cooldown:get', () => {
    const row = getDb()
      .prepare("SELECT value, meta, updated_at FROM app_state WHERE key = 'inc028_cooldown_until'")
      .get() as { value: string; meta: string | null; updated_at: string } | undefined;
    if (!row) return { active: false };
    const until = new Date(row.value).getTime();
    if (until <= Date.now()) return { active: false, expiredAt: row.value };
    let meta: Record<string, unknown> = {};
    try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch { /* ignore */ }
    return {
      active: true,
      until: row.value,
      hoursLeft: Number(((until - Date.now()) / 3_600_000).toFixed(1)),
      meta
    };
  });

  ipcMain.handle('cooldown:clear', () => {
    getDb().prepare("DELETE FROM app_state WHERE key = 'inc028_cooldown_until'").run();
    log.info('INC-028 cooldown cleared by user');
    return { ok: true };
  });

  // Phase 9.6 — End-of-session reconciliation. Compares app sends vs what's
  // expected. Returns a summary the user can scan + a "mark reconciled"
  // action that timestamps the run.
  ipcMain.handle('reconcile:run', () => {
    const u = ensureDefaultUser();
    const conn = getDb();
    const today = new Date().toISOString().slice(0, 10);

    // Today's sends (connection request + InMail) by status.
    const todayRows = conn
      .prepare(
        `SELECT motion, status, COUNT(*) AS c FROM outreach
         WHERE user_id = ? AND substr(sent_at, 1, 10) = ?
         GROUP BY motion, status`
      )
      .all(u.id, today) as Array<{ motion: string; status: string; c: number }>;

    // Today's drafted but not sent.
    const draftedNotSent = (conn
      .prepare(
        `SELECT COUNT(*) AS c FROM outreach
         WHERE user_id = ? AND status = 'draft' AND substr(drafted_at, 1, 10) = ?`
      )
      .get(u.id, today) as { c: number }).c;

    // Today's drops with reasons.
    const dropsByReason = conn
      .prepare(
        `SELECT
           CASE
             WHEN status_reason LIKE '%DNC%' THEN 'DNC'
             WHEN status_reason LIKE '%prior contact%' THEN 'Prior contact'
             WHEN status_reason LIKE '%TAM%' OR status_reason LIKE '%out of scope%' THEN 'Out of TAM'
             WHEN status_reason LIKE '%1st-degree%' THEN '1st-degree'
             WHEN status_reason LIKE '%near-empty%' OR status_reason LIKE '%INC-030%' THEN 'INC-030 / sparse profile'
             WHEN status_reason LIKE '%confidence%' THEN 'Low confidence'
             WHEN status_reason LIKE '%career-arc%' THEN 'Career-arc mismatch'
             WHEN status_reason LIKE '%wrong-company%' THEN 'Wrong-company'
             WHEN status_reason LIKE '%auto-drop%' THEN 'Auto-drop signal'
             ELSE 'Other'
           END AS reason,
           COUNT(*) AS count
         FROM outreach
         WHERE user_id = ? AND status = 'dropped' AND substr(drafted_at, 1, 10) = ?
         GROUP BY reason ORDER BY count DESC`
      )
      .all(u.id, today) as Array<{ reason: string; count: number }>;

    // Send-queue health snapshot.
    const queueRow = conn
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted,
           SUM(CASE WHEN status = 'done' AND substr(updated_at, 1, 10) = ? THEN 1 ELSE 0 END) AS doneToday
         FROM send_queue WHERE user_id = ?`
      )
      .get(today, u.id) as { queued: number | null; exhausted: number | null; doneToday: number | null };

    // Cooldown state.
    const cooldownRow = conn
      .prepare("SELECT value FROM app_state WHERE key = 'inc028_cooldown_until'")
      .get() as { value: string } | undefined;
    const cooldownActive = cooldownRow ? new Date(cooldownRow.value).getTime() > Date.now() : false;

    // 7-day rolling totals.
    const weekRow = conn
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('sent','accepted','replied','declined') THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status IN ('accepted','replied') THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) AS replied
         FROM outreach
         WHERE user_id = ? AND sent_at > datetime('now', '-7 days')`
      )
      .get(u.id) as { sent: number | null; accepted: number | null; replied: number | null };

    // Mark reconciliation timestamp.
    getDb()
      .prepare(
        `INSERT INTO app_state (key, value) VALUES ('last_reconciliation', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .run(new Date().toISOString());

    return {
      today,
      todayByMotionAndStatus: todayRows,
      draftedNotSent,
      dropsByReason,
      queue: {
        queued: queueRow.queued ?? 0,
        exhausted: queueRow.exhausted ?? 0,
        doneToday: queueRow.doneToday ?? 0
      },
      cooldownActive,
      week7d: {
        sent: weekRow.sent ?? 0,
        accepted: weekRow.accepted ?? 0,
        replied: weekRow.replied ?? 0,
        weeklySoftCap: 80,
        weeklyHardCap: 100
      }
    };
  });

  ipcMain.handle('reconcile:lastRun', () => {
    const row = getDb()
      .prepare("SELECT value, updated_at FROM app_state WHERE key = 'last_reconciliation'")
      .get() as { value: string; updated_at: string } | undefined;
    return row ?? null;
  });

  ipcMain.handle('accounts:list', () => {
    const u = ensureDefaultUser();
    return getDb()
      .prepare(
        `SELECT a.id, a.name, a.domain, a.tier, a.location,
          (SELECT COUNT(*) FROM prospects WHERE prospects.account_id = a.id AND prospects.user_id = a.user_id) AS prospect_count,
          (SELECT COUNT(*) FROM outreach o JOIN prospects p ON p.id = o.prospect_id WHERE p.account_id = a.id AND o.user_id = a.user_id AND o.status IN ('sent','accepted','replied','declined')) AS sent_count,
          (SELECT COUNT(*) FROM outreach o JOIN prospects p ON p.id = o.prospect_id WHERE p.account_id = a.id AND o.user_id = a.user_id AND o.status IN ('accepted','replied')) AS accepted_count
         FROM accounts a
         WHERE a.user_id = ?
         ORDER BY accepted_count DESC, sent_count DESC, a.tier, a.name COLLATE NOCASE`
      )
      .all(u.id);
  });

  ipcMain.handle('accounts:detail', (_e, accountId: number) => {
    const u = ensureDefaultUser();
    const account = getDb()
      .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
      .get(accountId, u.id) as Record<string, unknown> | undefined;
    if (!account) return null;
    const outreach = getDb()
      .prepare(
        `SELECT o.id, p.full_name, p.title, o.motion, o.status, o.confidence, o.drafted_at, o.sent_at
         FROM outreach o JOIN prospects p ON p.id = o.prospect_id
         WHERE p.account_id = ? AND o.user_id = ?
         ORDER BY o.drafted_at DESC`
      )
      .all(accountId, u.id);
    const prospects = getDb()
      .prepare(
        `SELECT id, full_name, title, linkedin_url FROM prospects
         WHERE account_id = ? AND user_id = ? ORDER BY full_name COLLATE NOCASE`
      )
      .all(accountId, u.id);
    return { account, outreach, prospects };
  });

  ipcMain.handle('sync:run', async () => {
    const u = ensureDefaultUser();
    return await runReplySync(u.id);
  });

  ipcMain.handle('demo:loadSeeds', () => {
    const u = ensureDefaultUser();
    return loadDemoSeeds(u.id);
  });

  ipcMain.handle('audit:gateLog', (_e, outreachId: number | null, limit: number) => {
    const where = outreachId ? 'WHERE g.outreach_id = ?' : '';
    const args: unknown[] = outreachId ? [outreachId, limit] : [limit];
    return getDb()
      .prepare(
        `SELECT g.id, g.outreach_id, g.prospect_id, g.phase, g.decision, g.reason, g.ts
         FROM gate_log g ${where} ORDER BY g.ts DESC LIMIT ?`
      )
      .all(...args);
  });

  ipcMain.handle('export:activity', () => {
    const u = ensureDefaultUser();
    const rows = getDb()
      .prepare(
        `SELECT o.id, p.full_name, p.first_name, p.last_name, p.linkedin_url, p.title, p.company_name,
                o.motion, o.status, o.confidence, o.hook, o.dept, o.char_count, o.draft_subject, o.draft_body,
                o.drafted_at, o.sent_at, o.accepted_at, o.replied_at, o.status_reason
         FROM outreach o JOIN prospects p ON p.id = o.prospect_id
         WHERE o.user_id = ?
         ORDER BY o.drafted_at DESC`
      )
      .all(u.id) as Array<Record<string, unknown>>;

    const headers = [
      'id',
      'full_name',
      'first_name',
      'last_name',
      'linkedin_url',
      'title',
      'company_name',
      'motion',
      'status',
      'confidence',
      'hook',
      'dept',
      'char_count',
      'draft_subject',
      'draft_body',
      'drafted_at',
      'sent_at',
      'accepted_at',
      'replied_at',
      'status_reason'
    ];
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(headers.map((h) => escape(r[h])).join(','));
    }
    return { csv: lines.join('\n'), rows: rows.length };
  });

  ipcMain.handle('skills:list', () => {
    const candidates = [
      resolve(process.cwd(), 'data', 'seed'),
      resolve(process.resourcesPath || '', 'seed'),
      resolve(__dirname, '..', '..', 'data', 'seed')
    ];
    const seedRoot = candidates.find((p) => existsSync(p));
    if (!seedRoot) return { skills: [], playbooks: [] };

    const readDir = (dir: string) => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const full = resolve(dir, f);
          const content = readFileSync(full, 'utf8');
          const titleMatch = content.match(/^#\s+(.+)$/m);
          return {
            id: f.replace(/\.md$/, ''),
            title: titleMatch?.[1] ?? f,
            content,
            byteSize: content.length
          };
        });
    };

    return {
      skills: readDir(resolve(seedRoot, 'skills')),
      playbooks: readDir(resolve(seedRoot, 'playbooks'))
    };
  });

  ipcMain.handle('evidence:get', (_e, evidenceId: number) => {
    const ev = getDb().prepare(`SELECT * FROM evidence WHERE id = ?`).get(evidenceId) as Record<string, unknown> | undefined;
    if (!ev) return null;
    return {
      id: ev.id,
      prospect_id: ev.prospect_id,
      captured_at: ev.captured_at,
      captured_via: ev.captured_via,
      live_headline: ev.live_headline,
      live_location: ev.live_location,
      connection_degree: ev.connection_degree,
      follower_count: ev.follower_count,
      connection_count: ev.connection_count,
      activity_status: ev.activity_status,
      activity_quotes: ev.activity_quotes ? JSON.parse(ev.activity_quotes as string) : [],
      evidence_quote_for_hook: ev.evidence_quote_for_hook,
      notes: ev.notes
    };
  });
}
