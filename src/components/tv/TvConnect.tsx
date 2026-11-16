/**
 * Android TV thin client: find the PC, pair with its PIN, and wait for it when it's off.
 *
 * - No pairing yet: the PCs that answered the discovery broadcast (or an IP typed with the
 *   on-screen keyboard), then the 6-digit PIN shown in the PC's Settings → Linked Devices.
 * - Paired but the PC isn't answering: "Connecting to your PC…", retried every few seconds.
 */
import { m } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { pairedServer, pairWithServer, pingServer, savePairedServer, tvNative, type PairedServer } from "../../services/platform";
import { focusFirst } from "../../lib/spatialNav";
import wordmark from "../../assets/omnia-wordmark.png";

const PORT = 8765;
type Found = { host: string; port: number; name: string };

function Card({ children }: { children: React.ReactNode }) {
  return (
    <m.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="glass-panel glass-strong w-[min(560px,calc(100vw-32px))] px-10 py-9 text-center">
      <img src={wordmark} alt="Omnia" draggable={false} className="mx-auto mb-6 h-12 w-auto" />
      {children}
    </m.div>
  );
}

/** Paired PC unreachable: retries until it answers. */
export function TvConnecting({ server, onReady, onForget }: { server: PairedServer; onReady: () => void; onForget: () => void }) {
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let stop = false;
    const attempt = async () => {
      const ping = await pingServer(server.host, server.port, server.token);
      if (stop) return;
      if (ping?.paired) onReady();
      else if (ping && !ping.paired) onForget(); // revoked on the PC
      else {
        setTries((t) => t + 1);
        setTimeout(attempt, 3000);
      }
    };
    void attempt();
    return () => {
      stop = true;
    };
  }, [server, onReady, onForget]);
  useEffect(() => focusFirst(), []);

  return (
    <div className="flex h-full items-center justify-center">
      <Card>
        <div className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
        <h1 className="text-[26px] font-bold">Connecting to your PC…</h1>
        <p className="mt-2 text-label-secondary">
          Waiting for Omnia on <b>{server.name}</b> ({server.host}). Make sure it's running and on the same Wi-Fi.
        </p>
        {tries > 2 && <p className="mt-2 text-[13px] text-label-tertiary">Still trying ({tries} attempts)…</p>}
        <button className="glass-button mt-7" onClick={onForget}>
          Pair with a different PC
        </button>
      </Card>
    </div>
  );
}

/** First run (or after a revoke): discovery → PIN → paired. */
export function TvPairing({ onPaired }: { onPaired: () => void }) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [target, setTarget] = useState<Found | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setFound(await tvNative.discover());
    } catch {
      setFound([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);
  useEffect(() => {
    const t = setTimeout(() => focusFirst(), 50);
    return () => clearTimeout(t);
  }, [found, manual, target]);

  const checkAddress = async () => {
    const host = address.trim().replace(/^https?:\/\//, "").replace(/:\d+\/?$/, "").replace(/\/$/, "");
    if (!host) return;
    setBusy(true);
    setError(null);
    const ping = await pingServer(host, PORT);
    setBusy(false);
    if (!ping) {
      setError(`No Omnia found at ${host}. On the PC, turn on Settings → Linked Devices.`);
      return;
    }
    setTarget({ host, port: PORT, name: ping.name });
  };

  const pair = async () => {
    if (!target || pin.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await pairWithServer(target.host, target.port, pin, target.name);
      onPaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  if (target) {
    return (
      <div className="flex h-full items-center justify-center">
        <Card>
          <h1 className="text-[26px] font-bold">Enter the PIN</h1>
          <p className="mt-2 text-label-secondary">
            On <b>{target.name}</b>, open Omnia → Settings → Linked Devices and type the 6-digit PIN shown there.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void pair();
            }}
          >
            <input
              autoFocus
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-label="Pairing PIN"
              placeholder="••••••"
              className="glass-input mt-6 text-center font-mono text-[34px] tracking-[0.4em]"
            />
            {error && <p className="mt-3 text-[14px] text-[#ff6961]">{error}</p>}
            <div className="mt-6 flex justify-center gap-3">
              <button type="button" className="glass-button" onClick={() => setTarget(null)}>
                Back
              </button>
              <button type="submit" className="glass-button-primary" disabled={busy || pin.length !== 6}>
                {busy ? "Pairing…" : "Pair"}
              </button>
            </div>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Card>
        <h1 className="text-[26px] font-bold">Connect to Omnia on your PC</h1>
        <p className="mt-2 text-label-secondary">Your profiles, history and recommendations live on your PC. This TV shows them over your Wi-Fi.</p>
        {!manual ? (
          <>
            <div className="mt-6 flex flex-col gap-2">
              {scanning && <p className="text-label-tertiary">Looking for PCs on this network…</p>}
              {!scanning && found?.length === 0 && <p className="text-label-tertiary">No PC found. On the PC, turn on Settings → Linked Devices.</p>}
              {found?.map((f) => (
                <button key={f.host} className="glass-button w-full justify-between" onClick={() => setTarget(f)}>
                  <span className="font-semibold">{f.name}</span>
                  <span className="text-label-tertiary">{f.host}</span>
                </button>
              ))}
            </div>
            <div className="mt-6 flex justify-center gap-3">
              <button className="glass-button" onClick={() => void scan()} disabled={scanning}>
                Search again
              </button>
              <button className="glass-button" onClick={() => setManual(true)}>
                Enter IP address
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void checkAddress();
            }}
          >
            <input
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.1.5"
              aria-label="PC address"
              className="glass-input mt-6 text-center text-[22px]"
            />
            {error && <p className="mt-3 text-[14px] text-[#ff6961]">{error}</p>}
            <div className="mt-6 flex justify-center gap-3">
              <button type="button" className="glass-button" onClick={() => setManual(false)}>
                Back
              </button>
              <button type="submit" className="glass-button-primary" disabled={busy || !address.trim()}>
                {busy ? "Checking…" : "Continue"}
              </button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

/** TV start-up: paired and reachable → the app; otherwise connect / pair first. */
export function useTvConnection() {
  const [server, setServer] = useState<PairedServer | null>(() => pairedServer());
  const [ready, setReady] = useState(false);
  const forget = useCallback(() => {
    savePairedServer(null);
    setServer(null);
    setReady(false);
  }, []);
  const paired = useCallback(() => {
    setServer(pairedServer());
    setReady(true);
  }, []);
  const onReady = useCallback(() => setReady(true), []);
  return { server, ready, forget, paired, onReady };
}
