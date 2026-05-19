import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi, OrchestratorEvent, OrchestratorRequest } from '../shared/types';

const api: IpcApi = {
  ping: () => ipcRenderer.invoke('ping'),
  getCurrentUser: () => ipcRenderer.invoke('user:current'),
  importTam: () => ipcRenderer.invoke('seed:tam'),
  loginLinkedIn: () => ipcRenderer.invoke('linkedin:login'),
  runSingle: (req: OrchestratorRequest) => ipcRenderer.invoke('orch:single', req),
  onOrchestratorEvent: (cb) => {
    const handler = (_e: unknown, payload: OrchestratorEvent) => cb(payload);
    ipcRenderer.on('orch:event', handler);
    return () => ipcRenderer.removeListener('orch:event', handler);
  },
  approveAndSend: (id: number, opts) => ipcRenderer.invoke('outreach:send', id, opts),
  todaysSendCount: (motion) => ipcRenderer.invoke('analytics:todaysSendCount', motion),
  listOutreach: (limit?: number) => ipcRenderer.invoke('outreach:list', limit ?? 50),
  setAnthropicKey: (key: string) => ipcRenderer.invoke('settings:setAnthropicKey', key),
  getAnthropicKeyStatus: () => ipcRenderer.invoke('settings:getAnthropicKey'),
  setApolloKey: (key: string) => ipcRenderer.invoke('settings:setApolloKey', key),
  getApolloKeyStatus: () => ipcRenderer.invoke('settings:getApolloKey'),
  checkAnthropicKey: () => ipcRenderer.invoke('settings:checkAnthropicKey'),
  checkApolloKey: () => ipcRenderer.invoke('settings:checkApolloKey'),
  getAnalytics: () => ipcRenderer.invoke('analytics:get'),
  getTodaysActions: () => ipcRenderer.invoke('analytics:todaysActions'),
  runSync: () => ipcRenderer.invoke('sync:run'),
  getLinkedInStatus: () => ipcRenderer.invoke('linkedin:status'),
  probeLinkedIn: () => ipcRenderer.invoke('linkedin:probe'),
  getSalesNavStatus: () => ipcRenderer.invoke('salesnav:status'),
  probeSalesNav: () => ipcRenderer.invoke('salesnav:probe'),
  loginSalesNav: () => ipcRenderer.invoke('salesnav:login'),
  updateDraft: (id, patch) => ipcRenderer.invoke('outreach:update', id, patch),
  rescoreLLM: (id) => ipcRenderer.invoke('outreach:rescoreLLM', id),
  loadDemoSeeds: () => ipcRenderer.invoke('demo:loadSeeds'),
  simulateSend: (id) => ipcRenderer.invoke('outreach:simulateSend', id),
  getGateLog: (id, limit) => ipcRenderer.invoke('audit:gateLog', id ?? null, limit ?? 200),
  getEvidence: (id) => ipcRenderer.invoke('evidence:get', id),
  getOutreachDetail: (id) => ipcRenderer.invoke('outreach:detail', id),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  exportActivity: () => ipcRenderer.invoke('export:activity'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  getAccountDetail: (id) => ipcRenderer.invoke('accounts:detail', id),
  getCooldown: () => ipcRenderer.invoke('cooldown:get'),
  clearCooldown: () => ipcRenderer.invoke('cooldown:clear'),
  runReconciliation: () => ipcRenderer.invoke('reconcile:run'),
  getLastReconciliation: () => ipcRenderer.invoke('reconcile:lastRun'),
  runPreflight: () => ipcRenderer.invoke('health:preflight'),
  getLogTail: (maxLines) => ipcRenderer.invoke('health:logTail', maxLines),
  createBackup: () => ipcRenderer.invoke('backup:create'),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  restoreBackup: (name) => ipcRenderer.invoke('backup:restore', name),
  deleteBackup: (name) => ipcRenderer.invoke('backup:delete', name),
  getChromiumStatus: () => ipcRenderer.invoke('playwright:status'),
  installChromium: () => ipcRenderer.invoke('playwright:install'),
  onChromiumInstallProgress: (cb) => {
    const handler = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on('playwright:install:progress', handler);
    return () => ipcRenderer.removeListener('playwright:install:progress', handler);
  },
  listSendQueue: () => ipcRenderer.invoke('queue:list'),
  cancelSendQueue: (id) => ipcRenderer.invoke('queue:cancel', id),
  retrySendQueueNow: (id) => ipcRenderer.invoke('queue:retryNow', id),
  requeueOutreach: (id) => ipcRenderer.invoke('queue:requeueOutreach', id),
  reclassifyReply: (id) => ipcRenderer.invoke('reply:reclassify', id),
  setReplyClassification: (id, c, reason) => ipcRenderer.invoke('reply:setClassification', id, c, reason),
  listClassificationOverrides: (id) => ipcRenderer.invoke('reply:listOverrides', id),
  reverseAutoDnc: (id) => ipcRenderer.invoke('dnc:reverseAuto', id),
  reverseAutoDncBulk: (ids) => ipcRenderer.invoke('dnc:reverseAutoBulk', ids),
  setReplyClassificationBulk: (ids, c, reason) => ipcRenderer.invoke('reply:setClassificationBulk', ids, c, reason),
  listAutoDncForOutreach: (id) => ipcRenderer.invoke('dnc:listAutoForOutreach', id),
  getOnboardingState: () => ipcRenderer.invoke('onboarding:state'),
  setOnboardingStep: (stepId, status, meta) => ipcRenderer.invoke('onboarding:setStep', stepId, status, meta),
  resetOnboarding: () => ipcRenderer.invoke('onboarding:reset'),
  getApolloMode: () => ipcRenderer.invoke('apollo:getMode'),
  setApolloMode: (mode) => ipcRenderer.invoke('apollo:setMode', mode),
  getIcpTitles: () => ipcRenderer.invoke('autoprospect:icpTitles'),
  sourceFromAccount: (args) => ipcRenderer.invoke('autoprospect:fromAccount', args),
  getDataFolders: () => ipcRenderer.invoke('folders:get'),
  openFolder: (kind) => ipcRenderer.invoke('folders:open', kind),
  updateUser: (patch) => ipcRenderer.invoke('user:update', patch)
};

contextBridge.exposeInMainWorld('api', api);
