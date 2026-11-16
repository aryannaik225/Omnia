/**
 * On-screen keyboard for TV remotes. It docks at the bottom whenever a text field is focused
 * (D-pad mode only), types into that field like a real keyboard (React sees normal `input`
 * events), and stays open while focus moves between the field and its keys. Numeric fields
 * (`inputmode="numeric"`, e.g. the pairing PIN) open on the number pad.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { focusElement } from "../../lib/spatialNav";

/** Dispatch on `window` to close the keyboard (the remote's Back button). */
export const VK_CLOSE_EVENT = "omnia:vk-close";
export const isVirtualKeyboardOpen = () => !!document.querySelector('[aria-label="On-screen keyboard"]');

type Layout = "letters" | "symbols" | "numeric";

const LETTERS = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.-"];
const SYMBOLS = ["1234567890", "!@#$%^&*()", "?/:;\"+=_~", "<>[]{}|\\`"];
const NUMERIC = ["123", "456", "789"];

type Field = HTMLInputElement | HTMLTextAreaElement;

function isField(el: EventTarget | null): el is Field {
  return (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && ["text", "search", "url", "email", "tel", "number", "password", ""].includes(el.type))
  );
}

/** Sets the value the way typing would, so React's onChange fires. */
function setValue(el: Field, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function VirtualKeyboard() {
  const [target, setTarget] = useState<Field | null>(null);
  const [layout, setLayout] = useState<Layout>("letters");
  const [shift, setShift] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Opens on OK / click on a field, not on mere focus: moving the D-pad across a search box
    // must not trap focus in the keyboard. Fields with `autofocus` (the TV's PIN / IP inputs)
    // open it straight away, since typing is the only thing to do there.
    const open = (el: Field) => {
      setTarget(el);
      setLayout(el.inputMode === "numeric" || el.type === "tel" || el.type === "number" ? "numeric" : "letters");
    };
    const onFocusIn = (e: FocusEvent) => {
      if (isField(e.target)) {
        if (e.target.autofocus) open(e.target);
        return;
      }
      // Focus left both the field and the keyboard: close it.
      if (!panel.current?.contains(e.target as Node)) setTarget(null);
    };
    const onClick = (e: MouseEvent) => {
      if (isField(e.target)) open(e.target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && isField(e.target) && !panel.current) {
        e.preventDefault();
        open(e.target);
      }
    };
    const onClose = () => setTarget(null);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(VK_CLOSE_EVENT, onClose);
    return () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(VK_CLOSE_EVENT, onClose);
    };
  }, []);

  // Keys never steal the field's focus on a mouse / touch click (desktop testing).
  const keep = (e: React.PointerEvent) => e.preventDefault();

  const type = (text: string) => {
    if (!target) return;
    const max = target.maxLength > 0 ? target.maxLength : Infinity;
    if (target.value.length >= max) return;
    setValue(target, target.value + (shift ? text.toUpperCase() : text));
    if (shift) setShift(false);
  };
  const backspace = () => target && setValue(target, target.value.slice(0, -1));
  const clear = () => target && setValue(target, "");
  const done = () => {
    if (!target) return;
    const form = target.form;
    const field = target;
    setTarget(null);
    if (form) form.requestSubmit();
    else focusElement(field);
  };

  const rows = layout === "numeric" ? NUMERIC : layout === "symbols" ? SYMBOLS : LETTERS;
  const key = "flex h-12 min-w-12 flex-1 items-center justify-center rounded-[12px] bg-white/[0.08] text-[18px] font-medium text-label-primary outline-none transition-colors hover:bg-white/[0.16] focus-visible:bg-white focus-visible:text-black";

  return (
    <AnimatePresence>
      {target && (
        <m.div
          ref={panel}
          data-focus-scope
          role="group"
          aria-label="On-screen keyboard"
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 340, damping: 32 }}
          className="glass-panel glass-strong fixed inset-x-0 bottom-4 z-[90] mx-auto flex w-[min(880px,calc(100vw-32px))] flex-col gap-2 p-4"
        >
          {rows.map((row) => (
            <div key={row} className="flex gap-2">
              {row.split("").map((ch) => (
                <button key={ch} type="button" className={key} onPointerDown={keep} onClick={() => type(ch)}>
                  {shift && layout === "letters" ? ch.toUpperCase() : ch}
                </button>
              ))}
            </div>
          ))}
          {layout === "numeric" && (
            <div className="flex gap-2">
              <button type="button" className={key} onPointerDown={keep} onClick={backspace} aria-label="Delete">
                ⌫
              </button>
              <button type="button" className={key} onPointerDown={keep} onClick={() => type("0")}>
                0
              </button>
              <button type="button" className={`${key} !bg-[#0a84ff]/80`} onPointerDown={keep} onClick={done}>
                Done
              </button>
            </div>
          )}
          {layout !== "numeric" && (
            <div className="flex gap-2">
              <button type="button" className={`${key} !flex-[1.4]`} onPointerDown={keep} onClick={() => setLayout(layout === "letters" ? "symbols" : "letters")}>
                {layout === "letters" ? "#+=" : "ABC"}
              </button>
              {layout === "letters" && (
                <button type="button" className={`${key} !flex-[1.4]`} aria-pressed={shift} onPointerDown={keep} onClick={() => setShift((s) => !s)}>
                  ⇧
                </button>
              )}
              <button type="button" className={`${key} !flex-[4]`} onPointerDown={keep} onClick={() => type(" ")}>
                Space
              </button>
              <button type="button" className={`${key} !flex-[1.4]`} onPointerDown={keep} onClick={backspace} aria-label="Delete">
                ⌫
              </button>
              <button type="button" className={`${key} !flex-[1.4]`} onPointerDown={keep} onClick={clear}>
                Clear
              </button>
              <button type="button" className={`${key} !flex-[1.6] !bg-[#0a84ff]/80`} onPointerDown={keep} onClick={done}>
                Done
              </button>
            </div>
          )}
        </m.div>
      )}
    </AnimatePresence>
  );
}
