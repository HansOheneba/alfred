"use client";

import { useEffect, useRef } from "react";

/** Fit Chat to the visible app viewport, including keyboards that overlay Safari's layout viewport. */
export function useChatViewport(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    const visual = window.visualViewport;
    let baselineHeight = window.innerHeight;
    let frame = 0;
    const update = () => {
      const focused = document.activeElement;
      const editing = focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLInputElement && !["button", "submit", "checkbox", "radio", "file", "range", "hidden"].includes(focused.type) ||
        focused instanceof HTMLElement && focused.isContentEditable;
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      const touch = window.matchMedia("(pointer: coarse)").matches;
      const zoomed = Boolean(visual && visual.scale > 1.1);
      if (!editing) baselineHeight = window.innerHeight;
      const height = zoomed ? window.innerHeight : Math.min(visual?.height ?? window.innerHeight, window.innerHeight);
      const keyboard = mobile && editing && !zoomed &&
        (window.innerHeight - height > 120 || touch && baselineHeight - height > 120);
      node.style.setProperty("--alfred-chat-viewport-height", `${Math.round(height)}px`);
      node.style.setProperty("--alfred-chat-offset-top", `${mobile && !zoomed ? Math.round(visual?.offsetTop ?? 0) : 0}px`);
      node.dataset.keyboardOpen = keyboard ? "true" : "false";
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const orientation = () => { baselineHeight = window.innerHeight; schedule(); };
    update();
    visual?.addEventListener("resize", schedule);
    visual?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", orientation);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(frame);
      visual?.removeEventListener("resize", schedule);
      visual?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", orientation);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      node.style.removeProperty("--alfred-chat-viewport-height");
      node.style.removeProperty("--alfred-chat-offset-top");
      delete node.dataset.keyboardOpen;
    };
  }, [active]);
  return ref;
}
