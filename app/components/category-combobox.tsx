"use client";

import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "list" | "children"> & {
  value: string;
  options: readonly string[];
  onValueChange: (value: string) => void;
};

/** A category stays free text; selecting an existing suggestion is optional. */
export function CategoryCombobox({ value, options, onValueChange, disabled, readOnly, id: suppliedId, className = "", onKeyDown, ...props }: Props) {
  const generated = useId();
  const id = suppliedId ?? `${generated}-category`, listId = `${id}-suggestions`;
  const container = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const available = !disabled && !readOnly;
  const query = value.trim().toLocaleLowerCase();
  const matches = [...new Set(options)].filter(option => option.toLocaleLowerCase().includes(query));
  const expanded = open && available;
  const activeIndex = active >= 0 && active < matches.length ? active : -1;

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) { setOpen(false); setActive(-1); }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  useEffect(() => {
    if (expanded && activeIndex >= 0) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex, listId]);

  function select(option: string) {
    if (!available) return;
    onValueChange(option); setOpen(false); setActive(-1); input.current?.focus({ preventScroll: true });
  }

  return <div ref={container} className="relative min-w-0 max-w-full" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1); }
  }}>
    <input {...props} id={id} ref={input} className={`alfred-input ${className}`} style={{ ...props.style, paddingInlineEnd: "46px" }}
      role="combobox" autoComplete="off" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={expanded} aria-controls={listId}
      aria-activedescendant={expanded && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      value={value} disabled={disabled} readOnly={readOnly}
      onFocus={event => { props.onFocus?.(event); if (available) setOpen(true); }}
      onChange={event => { if (available) { onValueChange(event.target.value); setOpen(true); setActive(-1); } }}
      onKeyDown={event => {
        onKeyDown?.(event); if (event.defaultPrevented || !available || event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          setActive(current => matches.length ? event.key === "ArrowDown" ? (current + 1) % matches.length : current <= 0 ? matches.length - 1 : current - 1 : -1);
        } else if (event.key === "Enter" && expanded && activeIndex >= 0) { event.preventDefault(); select(matches[activeIndex]); }
        else if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
      }} />
    <button type="button" tabIndex={-1} disabled={!available} aria-label="Show category suggestions" aria-expanded={expanded} aria-controls={listId}
      className="absolute right-0 top-0 grid min-h-[46px] w-11 place-items-center rounded-r-lg text-muted focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
      onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={() => { if (available) { const next = !expanded; input.current?.focus({ preventScroll: true }); setOpen(next); setActive(-1); } }}>
      <span aria-hidden="true" className="block size-5" style={{ background: "url('/icons/input-chevron-down.svg') center / 20px 20px no-repeat" }} />
    </button>
    {expanded ? <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-[min(240px,40dvh)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-1 shadow-lg">
      <ul id={listId} role="listbox" aria-label="Existing categories" className="m-0 list-none p-0">
        {matches.map((option, index) => <li key={option} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex}
          className={`cursor-pointer break-words rounded-lg px-3 py-2.5 text-base leading-6 ${index === activeIndex ? "bg-accent-soft text-accent" : "text-ink hover:bg-surface-2"}`}
          onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => select(option)}>{option}</li>)}
      </ul>
      {!matches.length ? <p role="status" className="px-3 py-2 text-sm leading-5 text-muted">No matching categories. You can use the name you typed.</p> : null}
    </div> : null}
  </div>;
}
