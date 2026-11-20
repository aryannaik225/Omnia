"use client";
/**
 * Settings → Home Page Layout: the reorderable Home rows (config/homeLayout.ts) with Up / Down
 * buttons and Reset. Presentational only; each app's Settings stores the order. Keep this file
 * identical in src/ and web-export/omnia/ (the web copy adds "use client").
 */
import { DEFAULT_HOME_ORDER, isDefaultOrder, moveSlot, slotLabel } from "../../config/homeLayout";
import { ChevronDownIcon, RefreshIcon } from "./Icons";

export function HomeLayoutEditor({ order, onChange, busy = false }: { order: string[]; onChange: (order: string[] | null) => void; busy?: boolean }) {
  const isDefault = isDefaultOrder(order);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-label-tertiary">Hero, Continue Watching, Top 10, hubs, My List and Browse by service stay at the top.</p>
        <button type="button" className="glass-button !px-3.5 !py-1.5 text-[13px]" disabled={busy || isDefault} onClick={() => onChange(null)}>
          <RefreshIcon size={14} /> Reset to default
        </button>
      </div>
      <ol className="mt-4 flex flex-col gap-1.5" aria-label="Home rows, top to bottom">
        {order.map((id, i) => {
          const slot = slotLabel(id);
          const moved = DEFAULT_HOME_ORDER[i] !== id;
          return (
            <li key={id} className="flex items-center gap-3 rounded-[12px] bg-white/[0.04] py-1.5 pl-3 pr-1.5">
              <span className="w-6 shrink-0 text-right text-[12px] tabular-nums text-label-tertiary">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                {slot?.label ?? id}
                {slot?.hint && <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide text-label-tertiary">{slot.hint}</span>}
                {moved && <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-[#0a84ff] align-middle" title="Moved from its default place" />}
              </span>
              <button
                type="button"
                className="icon-button !h-8 !w-8 shrink-0 disabled:opacity-30"
                disabled={busy || i === 0}
                onClick={() => onChange(moveSlot(order, i, -1))}
                aria-label={`Move ${slot?.label ?? id} up`}
                title="Move up"
              >
                <span className="inline-flex rotate-180">
                  <ChevronDownIcon size={16} />
                </span>
              </button>
              <button
                type="button"
                className="icon-button !h-8 !w-8 shrink-0 disabled:opacity-30"
                disabled={busy || i === order.length - 1}
                onClick={() => onChange(moveSlot(order, i, 1))}
                aria-label={`Move ${slot?.label ?? id} down`}
                title="Move down"
              >
                <ChevronDownIcon size={16} />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
