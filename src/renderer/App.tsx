import { useEffect, useState } from 'react';
import NewOutreach from './pages/NewOutreach';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import Home from './pages/Home';
import Analytics from './pages/Analytics';
import Playbook from './pages/Playbook';
import Audit from './pages/Audit';
import Health from './pages/Health';
import OutreachDetailView from './pages/OutreachDetail';
import Accounts from './pages/Accounts';
import SendQueue from './pages/SendQueue';
import HeaderBanner from './components/HeaderBanner';
import ToastHost from './components/Toast';
import OnboardingOverlay from './components/Onboarding';
import ShortcutsOverlay, { useShortcutsOverlay } from './components/Shortcuts';
import CommandPalette, { useCommandPalette } from './components/CommandPalette';
import ErrorBoundary from './components/ErrorBoundary';

type View = 'home' | 'new' | 'activity' | 'queue' | 'accounts' | 'analytics' | 'playbook' | 'audit' | 'health' | 'settings';

const NAV: Array<{ id: View; label: string; icon: string; key: string }> = [
  { id: 'home', label: 'Home', icon: '◐', key: '1' },
  { id: 'new', label: 'New Outreach', icon: '✦', key: '2' },
  { id: 'activity', label: 'Activity', icon: '≡', key: '3' },
  { id: 'queue', label: 'Send Queue', icon: '⊜', key: '4' },
  { id: 'accounts', label: 'Accounts', icon: '◇', key: '5' },
  { id: 'analytics', label: 'Analytics', icon: '⌬', key: '6' },
  { id: 'playbook', label: 'Playbook', icon: '☰', key: '7' },
  { id: 'audit', label: 'Audit', icon: '◍', key: '8' },
  { id: 'health', label: 'Health', icon: '✚', key: '9' },
  { id: 'settings', label: 'Settings', icon: '⚙', key: '0' }
];

export default function App() {
  const [view, setView] = useState<View>('home');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [user, setUser] = useState<{ display_name: string; email: string } | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = (typeof window !== 'undefined' && localStorage.getItem('theme')) as 'dark' | 'light' | null;
    return stored ?? 'dark';
  });
  const shortcuts = useShortcutsOverlay();
  const palette = useCommandPalette();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    void window.api.getCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (meta && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        const id = NAV.find((n) => n.key === e.key)?.id;
        if (id) {
          setView(id);
          setDetailId(null);
        }
        return;
      }
      if (meta && (e.key === 'n' || e.key === 'N') && !isInput) {
        e.preventDefault();
        setView('new');
        setDetailId(null);
        return;
      }
      if (e.key === 'Escape' && detailId !== null) {
        setDetailId(null);
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailId]);

  const goTo = (v: View) => { setView(v); setDetailId(null); };

  return (
    <div className="h-full flex">
      <aside className="w-56 shrink-0 border-r border-white/5 bg-ink-900 flex flex-col">
        <div className="p-4 border-b border-white/5">
          <div className="text-sm font-semibold tracking-tight">LinkedIn Copilot</div>
          <div className="text-xs text-ink-200/50 mt-0.5">Testsigma BDR · {user?.display_name ?? '...'}</div>
        </div>
        <nav className="p-2 flex-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => goTo(n.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 transition-colors ${
                view === n.id && detailId === null ? 'bg-white/10 text-white' : 'text-ink-200/80 hover:bg-white/5'
              }`}
            >
              <span className="text-ink-200/60 w-4 text-center">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              <span className="text-[10px] text-ink-200/30 font-mono">⌘{n.key}</span>
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-white/5 flex items-center justify-between text-[10px] text-ink-200/40">
          <button onClick={() => palette.setOpen(true)} className="hover:text-ink-200 font-mono" title="Command palette (Cmd+K)">⌘ K</button>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="hover:text-ink-200"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <span>v0.1.0</span>
          <button onClick={() => shortcuts.setOpen(true)} className="hover:text-ink-200 font-mono" title="Keyboard shortcuts (Cmd+/)">⌘ /</button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col overflow-hidden">
        <HeaderBanner />
        <div className="flex-1 overflow-y-auto">
          {detailId !== null ? (
            <ErrorBoundary pageName="OutreachDetail">
              <OutreachDetailView outreachId={detailId} onClose={() => setDetailId(null)} />
            </ErrorBoundary>
          ) : (
            <>
              {view === 'home' && (
                <ErrorBoundary pageName="Home">
                  <Home
                    onStart={() => setView('new')}
                    onOpenDetail={(id) => setDetailId(id)}
                    onOpenActivity={() => setView('activity')}
                  />
                </ErrorBoundary>
              )}
              {view === 'new' && (
                <ErrorBoundary pageName="New Outreach">
                  <NewOutreach onDone={() => setView('activity')} />
                </ErrorBoundary>
              )}
              {view === 'activity' && (
                <ErrorBoundary pageName="Activity">
                  <Activity onOpen={() => setView('audit')} onOpenDetail={(id) => setDetailId(id)} />
                </ErrorBoundary>
              )}
              {view === 'queue' && (
                <ErrorBoundary pageName="Send Queue">
                  <SendQueue onOpenDetail={(id) => setDetailId(id)} />
                </ErrorBoundary>
              )}
              {view === 'accounts' && (
                <ErrorBoundary pageName="Accounts">
                  <Accounts onOpenOutreach={(id) => setDetailId(id)} />
                </ErrorBoundary>
              )}
              {view === 'analytics' && (
                <ErrorBoundary pageName="Analytics">
                  <Analytics />
                </ErrorBoundary>
              )}
              {view === 'playbook' && (
                <ErrorBoundary pageName="Playbook">
                  <Playbook />
                </ErrorBoundary>
              )}
              {view === 'audit' && (
                <ErrorBoundary pageName="Audit">
                  <Audit />
                </ErrorBoundary>
              )}
              {view === 'health' && (
                <ErrorBoundary pageName="Health">
                  <Health />
                </ErrorBoundary>
              )}
              {view === 'settings' && (
                <ErrorBoundary pageName="Settings">
                  <Settings />
                </ErrorBoundary>
              )}
            </>
          )}
        </div>
      </main>
      <ToastHost />
      <OnboardingOverlay />
      <ShortcutsOverlay open={shortcuts.open} onClose={() => shortcuts.setOpen(false)} />
      <CommandPalette
        open={palette.open}
        onClose={() => palette.setOpen(false)}
        handlers={{
          onNav: (id) => goTo(id as View),
          onOpenOutreach: (id) => setDetailId(id),
          onOpenAccount: () => goTo('accounts')
        }}
      />
    </div>
  );
}
