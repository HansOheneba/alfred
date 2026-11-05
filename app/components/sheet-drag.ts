import type { PointerEvent as ReactPointerEvent } from "react";

import "./sheet-drag.css";

/** How far down, in pixels, a sheet must be pulled to close it. */
export const SHEET_CLOSE_DISTANCE = 96;
/** A flick this fast (pixels per millisecond) closes it from a shorter pull. */
export const SHEET_CLOSE_SPEED = 0.5;

/** Whether a pull of `distance` px, last moving at `speed` px/ms, should close the sheet. */
export function sheetShouldClose(distance: number, speed: number): boolean {
  return distance >= SHEET_CLOSE_DISTANCE || (distance > 16 && speed >= SHEET_CLOSE_SPEED);
}

const INTERACTIVE = "button,input,select,textarea,a,[role=combobox],[contenteditable]";
const SETTLE_MS = 180;

/**
 * Props for the grey handle and the header beside it, so a phone sheet can be
 * pulled down to close, as the handle suggests. It only acts while the
 * handle is showing (phone layouts); on desktop the sheet is a centred modal
 * and the handle is hidden.
 */
export function sheetDragProps(onClose: () => void, enabled = true) {
  return {
    "data-sheet-drag": "",
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (!enabled || !event.isPrimary || event.button !== 0) return;
      if ((event.target as Element).closest(INTERACTIVE)) return;
      const area = event.currentTarget;
      const sheet = area.closest<HTMLElement>("dialog,[role=dialog]");
      const handle = sheet?.querySelector<HTMLElement>("[data-sheet-handle]");
      if (!sheet || !handle || handle.getClientRects().length === 0) return;

      const pointer = event.pointerId;
      const start = event.clientY;
      let distance = 0;
      let speed = 0;
      let last = { y: start, at: event.timeStamp };
      try { area.setPointerCapture(pointer); } catch { /* the pointer already went away */ }
      sheet.style.transition = "none";

      const move = (next: PointerEvent) => {
        if (next.pointerId !== pointer) return;
        distance = Math.max(0, next.clientY - start);
        const elapsed = next.timeStamp - last.at;
        if (elapsed > 0) speed = (next.clientY - last.y) / elapsed;
        last = { y: next.clientY, at: next.timeStamp };
        sheet.style.transform = distance ? `translateY(${distance}px)` : "";
      };
      const end = (done: PointerEvent) => {
        if (done.pointerId !== pointer) return;
        area.removeEventListener("pointermove", move);
        area.removeEventListener("pointerup", end);
        area.removeEventListener("pointercancel", end);
        const closing = done.type === "pointerup" && sheetShouldClose(distance, speed);
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        sheet.style.transition = still ? "none" : `transform ${SETTLE_MS}ms ${closing ? "ease-in" : "ease-out"}`;
        sheet.style.transform = closing ? "translateY(100%)" : "";
        window.setTimeout(() => {
          if (closing) onClose();
          // A sheet that stays mounted after closing must open in place next time.
          sheet.style.transition = "";
          sheet.style.transform = "";
        }, still ? 0 : SETTLE_MS);
      };
      area.addEventListener("pointermove", move);
      area.addEventListener("pointerup", end);
      area.addEventListener("pointercancel", end);
    },
  };
}
