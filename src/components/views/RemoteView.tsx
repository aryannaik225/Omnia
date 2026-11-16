/**
 * Phone remote: drive Omnia on the TV (thin client) or on the PC from your phone.
 * The keys go to the PC's LAN server, which forwards them to the chosen screen. On the PC,
 * while Omnia's player is open, OK / Play-Pause toggle it, ◀ ▶ seek 10 s and Back returns
 * to the hub; otherwise they move the focus in the catalog like a TV remote.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { remoteControl, type RemoteKey, type RemoteTarget } from "../../services/platform";
import { ChevronLeftIcon, ChevronRightIcon, HomeIcon, PlayIcon } from "../common/Icons";
import { PageHeader } from "./BrowseViews";

function Pad({ label, onPress, className = "", children }: { label: string; onPress: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className={`flex select-none items-center justify-center rounded-full bg-white/[0.09] text-label-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] transition-[transform,background-color] active:scale-95 active:bg-white/[0.22] ${className}`}
    >
      {children}
    </button>
  );
}

const Chevron = ({ dir }: { dir: "up" | "down" }) => (
  <span className={dir === "up" ? "rotate-90" : "-rotate-90"}>
    <ChevronLeftIcon size={26} />
  </span>
);

export function RemoteView() {
  const [targets, setTargets] = useState<RemoteTarget[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await remoteControl.targets();
      setTargets(list);
      setError(null);
      // Keep the chosen screen while it's there; otherwise the most recently active one.
      setTarget((t) => (t && list.some((x) => x.id === t) ? t : (list[0]?.id ?? null)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const press = (key: RemoteKey) => {
    if (!target) return;
    navigator.vibrate?.(12);
    remoteControl.send(target, key).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const current = targets?.find((t) => t.id === target);

  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center pb-10">
      <PageHeader title="Remote" subtitle="Control Omnia on your TV or PC" />
      <div className="mb-8 flex w-full flex-wrap justify-center gap-2" role="radiogroup" aria-label="Screen">
        {(targets ?? []).map((t) => (
          <button key={t.id} role="radio" aria-checked={t.id === target} className="chip max-w-full" data-active={t.id === target} onClick={() => setTarget(t.id)}>
            <span className="truncate">{t.kind === "tv" ? "📺 " : "🖥️ "}{t.name}</span>
          </button>
        ))}
        {targets && targets.length === 1 && <p className="w-full text-center text-[12px] text-label-tertiary">Open the Omnia TV app to control it from here.</p>}
      </div>

      {/* D-pad */}
      <div className="relative h-[264px] w-[264px] rounded-full bg-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
        <Pad label="Up" onPress={() => press("up")} className="absolute left-1/2 top-2 h-[72px] w-[72px] -translate-x-1/2">
          <Chevron dir="up" />
        </Pad>
        <Pad label="Down" onPress={() => press("down")} className="absolute bottom-2 left-1/2 h-[72px] w-[72px] -translate-x-1/2">
          <Chevron dir="down" />
        </Pad>
        <Pad label="Left" onPress={() => press("left")} className="absolute left-2 top-1/2 h-[72px] w-[72px] -translate-y-1/2">
          <ChevronLeftIcon size={26} />
        </Pad>
        <Pad label="Right" onPress={() => press("right")} className="absolute right-2 top-1/2 h-[72px] w-[72px] -translate-y-1/2">
          <ChevronRightIcon size={26} />
        </Pad>
        <Pad label="OK" onPress={() => press("ok")} className="absolute left-1/2 top-1/2 h-[96px] w-[96px] -translate-x-1/2 -translate-y-1/2 !bg-white/[0.16] text-[18px] font-semibold">
          OK
        </Pad>
      </div>

      <div className="mt-8 grid w-full max-w-[300px] grid-cols-3 gap-4">
        <Pad label="Back" onPress={() => press("back")} className="h-14 text-[13px] font-medium">
          Back
        </Pad>
        <Pad label="Home" onPress={() => press("home")} className="h-14">
          <HomeIcon size={20} />
        </Pad>
        <Pad label="Play / Pause" onPress={() => press("playpause")} className="h-14 gap-0.5">
          <PlayIcon size={16} />
          <span className="text-[13px] font-semibold">❚❚</span>
        </Pad>
      </div>

      <p className="mt-6 text-center text-[12px] text-label-tertiary">
        {current?.kind === "pc"
          ? "On the PC, while a title is playing in Omnia's player: OK pauses / plays, ◀ ▶ skip 10 s, Back returns to the hub."
          : current
            ? "Play / Pause works in Omnia on the TV. Once a title opens in the Netflix / Prime app, use the TV's own remote."
            : ""}
      </p>
      {error && <p className="mt-3 text-center text-[13px] text-[#ff6961]">{error}</p>}
    </div>
  );
}
