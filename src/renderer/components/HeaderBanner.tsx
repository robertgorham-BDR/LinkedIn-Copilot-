import { useEffect, useState } from 'react';

interface HealthState {
  linkedin: 'unknown' | 'logged-in' | 'logged-out' | 'checking' | 'error';
  salesnav: 'unknown' | 'logged-in' | 'logged-out' | 'checking' | 'error';
  anthropic: { configured: boolean; lastFour: string | null };
  apollo: { configured: boolean; lastFour: string | null };
  sendsToday: number;
}

const initialState: HealthState = {
  linkedin: 'unknown',
  salesnav: 'unknown',
  anthropic: { configured: false, lastFour: null },
  apollo: { configured: false, lastFour: null },
  sendsToday: 0
};

const INC_028_SOFT_CAP = 10;

export default function HeaderBanner() {
  const [state, setState] = useState<HealthState>(initialState);

  async function refresh() {
    const [a, p, l, sn, s] = await Promise.all([
      window.api.getAnthropicKeyStatus(),
      window.api.getApolloKeyStatus(),
      window.api.getLinkedInStatus(),
      window.api.getSalesNavStatus(),
      window.api.todaysSendCount('connection_request')
    ]);
    setState((prev) => ({ ...prev, anthropic: a, apollo: p, linkedin: l.state, salesnav: sn.state, sendsToday: s.count }));
  }

  async function probeAndRefresh() {
    // Probe runs the no-tab cookie+fetch check and updates runtime state.
    await Promise.all([window.api.probeLinkedIn(), window.api.probeSalesNav()]);
    await refresh();
  }

  useEffect(() => {
    void probeAndRefresh();
    // Light refresh every 8s reads cached state; full probe every 60s re-verifies sessions.
    const fast = setInterval(refresh, 8_000);
    const slow = setInterval(probeAndRefresh, 60_000);
    return () => { clearInterval(fast); clearInterval(slow); };
  }, []);

  return (
    <div className="border-b border-white/5 bg-ink-900/80 backdrop-blur px-4 py-2 flex items-center gap-2 text-xs">
      <Pill
        label="LinkedIn"
        state={state.linkedin === 'logged-in' ? 'ok' : state.linkedin === 'logged-out' || state.linkedin === 'error' ? 'bad' : 'idle'}
        detail={
          state.linkedin === 'logged-in'
            ? 'connected'
            : state.linkedin === 'logged-out' || state.linkedin === 'error'
              ? 'sign in via Settings'
              : 'not checked'
        }
      />
      <Pill
        label="Sales Nav"
        state={state.salesnav === 'logged-in' ? 'ok' : state.salesnav === 'logged-out' || state.salesnav === 'error' ? 'bad' : 'idle'}
        detail={
          state.salesnav === 'logged-in'
            ? 'connected'
            : state.salesnav === 'logged-out' || state.salesnav === 'error'
              ? 'required for InMail'
              : 'not checked'
        }
      />
      <Pill
        label="Anthropic"
        state={state.anthropic.configured ? 'ok' : 'warn'}
        detail={state.anthropic.configured ? `…${state.anthropic.lastFour}` : 'heuristic fallback'}
      />
      <Pill
        label="Apollo"
        state={state.apollo.configured ? 'ok' : 'warn'}
        detail={state.apollo.configured ? `…${state.apollo.lastFour}` : 'local dedup only'}
      />
      <Pill
        label="Sends today"
        state={state.sendsToday >= INC_028_SOFT_CAP ? 'bad' : state.sendsToday >= INC_028_SOFT_CAP - 2 ? 'warn' : 'ok'}
        detail={`${state.sendsToday} / ${INC_028_SOFT_CAP} (INC-028)`}
      />
      <div className="ml-auto text-ink-200/40">v0.1.0</div>
    </div>
  );
}

function Pill({ label, state, detail }: { label: string; state: 'ok' | 'warn' | 'bad' | 'idle'; detail: string }) {
  const color =
    state === 'ok'
      ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30'
      : state === 'warn'
        ? 'bg-yellow-500/15 text-yellow-200 border-yellow-500/30'
        : state === 'bad'
          ? 'bg-red-500/15 text-red-200 border-red-500/30'
          : 'bg-white/5 text-ink-200/60 border-white/10';
  const dot =
    state === 'ok'
      ? 'bg-emerald-400'
      : state === 'warn'
        ? 'bg-yellow-400'
        : state === 'bad'
          ? 'bg-red-400'
          : 'bg-ink-200/40';
  return (
    <span className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full border ${color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="font-medium">{label}</span>
      <span className="opacity-70">· {detail}</span>
    </span>
  );
}
