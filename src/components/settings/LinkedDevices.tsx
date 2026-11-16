/**
 * Settings → Linked Devices (desktop only): the LAN companion server switch, the pairing PIN
 * and QR code for phones / TVs on the same Wi-Fi, and the paired devices with Revoke.
 */
import qrcode from "qrcode-generator";
import { useCallback, useEffect, useMemo, useState } from "react";
import { relativeTime } from "../../lib/format";
import { lan, type LanStatus } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { RefreshIcon, TrashIcon } from "../common/Icons";

/** QR code as an SVG path (generated on this device; the link never leaves the LAN). */
function QrCode({ text, size = 176 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { d, n };
  }, [text]);
  const pad = 2;
  return (
    <svg width={size} height={size} viewBox={`${-pad} ${-pad} ${path.n + pad * 2} ${path.n + pad * 2}`} className="rounded-[12px] bg-white" role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
      <path d={path.d} fill="#000" />
    </svg>
  );
}

export function LinkedDevicesSection({ Section, Toggle }: { Section: React.FC<{ title: string; description?: string; children: React.ReactNode }>; Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }> }) {
  const toast = useAppStore((s) => s.toast);
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => lan.status().then(setStatus).catch(() => setStatus(null)), []);

  useEffect(() => {
    void refresh();
    let off: (() => void) | undefined;
    void lan.onChanged(() => void refresh()).then((fn) => (off = fn));
    // The PIN rotates (10 min, after each pairing): keep the screen current.
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [refresh]);

  const run = async (fn: () => Promise<LanStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (e) {
      toast({ kind: "error", title: "Linked Devices", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const minutes = status?.pinExpiresInSecs ? Math.max(1, Math.ceil(status.pinExpiresInSecs / 60)) : null;

  return (
    <Section title="Linked Devices" description="Browse Omnia on your iPhone (Safari) or Android TV over your own Wi-Fi. Nothing goes through the internet: devices read this PC directly, and only devices you pair can.">
      <Toggle
        on={!!status?.enabled}
        onChange={(v) => void run(() => lan.setEnabled(v))}
        label="Allow phones & TVs on this network"
        hint={`Runs Omnia's companion server on port ${status?.port ?? 8765} while Omnia is open. Windows may ask to allow it on private networks.`}
      />
      {status?.error && <p className="mt-2 text-[13px] text-[#ff6961]">{status.error}</p>}

      {status?.running && (
        <div className="mt-4 flex flex-wrap items-center gap-6 rounded-card bg-white/[0.04] p-5">
          {status.pairUrl && <QrCode text={status.pairUrl} />}
          <div className="min-w-0 flex-1 basis-[220px]">
            <p className="text-[13px] text-label-tertiary">Pairing PIN</p>
            <p className="font-mono text-[40px] font-semibold tracking-[0.25em]" aria-live="polite">
              {status.pin}
            </p>
            <p className="text-[13px] text-label-tertiary">{minutes ? `Changes in ${minutes} min, and after each pairing.` : ""}</p>
            <div className="mt-3 text-[14px] text-label-secondary">
              <p>
                <b>iPhone:</b> scan the QR code with the Camera app, or open{" "}
                <span className="break-all font-mono text-label-primary">{status.address ? `http://${status.address}:${status.port}` : "this PC's address"}</span> in Safari and enter the PIN.
              </p>
              <p className="mt-1">
                <b>Android TV:</b> open the Omnia TV app; it finds this PC (or enter <span className="font-mono text-label-primary">{status.address ?? "its IP"}</span>), then type the PIN.
              </p>
            </div>
            <button className="glass-button mt-4 !py-2 text-[13px]" disabled={busy} onClick={() => void run(() => lan.newPin())}>
              <RefreshIcon size={14} /> New PIN
            </button>
          </div>
        </div>
      )}

      <div className="mt-5">
        <p className="text-[15px] font-medium">Paired devices</p>
        {!status?.devices.length ? (
          <p className="mt-1 text-[13px] text-label-tertiary">No devices yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {status.devices.map((d) => (
              <li key={d.deviceId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-pill bg-white/[0.05] px-4 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium">{d.deviceName}</span>
                  <span className="block text-[12px] text-label-tertiary">
                    Paired {relativeTime(d.pairedAt)}
                    {d.lastSeenAt ? ` · last used ${relativeTime(d.lastSeenAt)}` : ""}
                  </span>
                </span>
                <button className="glass-button !py-1.5 text-[13px] !text-[#ff6961]" disabled={busy} onClick={() => void run(() => lan.revoke(d.deviceId))}>
                  <TrashIcon size={14} /> Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
