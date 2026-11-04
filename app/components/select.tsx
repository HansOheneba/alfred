"use client";

import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import "./select.css";

export type SelectOption = { value: string; label: string; disabled: boolean; hidden: boolean; group?: string };
export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "multiple" | "size"> & { label?: string; ref?: Ref<HTMLSelectElement> };

function nodeText(node: ReactNode): string {
  return Children.toArray(node).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? nodeText(child.props.children) : "").join("");
}

/** Keep native option values and disabled groups; labels are text, never HTML. */
export function collectSelectOptions(children: ReactNode, group?: string, groupDisabled = false): SelectOption[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean; hidden?: boolean }>(child)) return [];
    if (child.type === Fragment) return collectSelectOptions(child.props.children, group, groupDisabled);
    if (child.type === "optgroup") return collectSelectOptions(child.props.children, child.props.label, groupDisabled || Boolean(child.props.disabled));
    if (child.type !== "option") return [];
    const text = nodeText(child.props.children);
    return [{ value: child.props.value === undefined ? text : String(child.props.value), label: child.props.label ?? text, disabled: groupDisabled || Boolean(child.props.disabled), hidden: Boolean(child.props.hidden), group }];
  });
}

export function nextSelectOption(options: SelectOption[], current: number, direction: 1 | -1): number {
  for (let step = 1; step <= options.length; step++) {
    const index = ((current + direction * step) % options.length + options.length) % options.length;
    if (!options[index].disabled && !options[index].hidden) return index;
  }
  return -1;
}

export function findSelectTypeahead(options: SelectOption[], current: number, query: string): number {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return -1;
  for (let step = 1; step <= options.length; step++) {
    const index = ((current + step) % options.length + options.length) % options.length;
    if (!options[index].disabled && !options[index].hidden && options[index].label.toLocaleLowerCase().startsWith(normalized)) return index;
  }
  return -1;
}

/** React receives an actual native change event, with its original select target. */
export function changeNativeSelect(select: HTMLSelectElement, value: string): boolean {
  if (select.disabled || select.value === value) return false;
  const option = Array.from(select.options).find(item => item.value === value);
  if (!option || option.disabled || option.hidden || option.closest("optgroup")?.disabled) return false;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function scalar(value: SelectProps["value"]): string | undefined { return value === undefined ? undefined : String(Array.isArray(value) ? value[0] ?? "" : value); }
function lockSelectScroll() {
  const body = document.body;
  const overflow = body.style.overflow;
  // An enclosing editor owns its lock. Do not restore a stale nested lock if it unmounts first.
  if (overflow === "hidden") return () => {};
  body.style.overflow = "hidden";
  return () => { body.style.overflow = overflow; };
}

/** A custom picker backed by a native select for forms, without the OS option menu. */
export function Select({ children, value, defaultValue, onChange, onInvalid, onFocus, className = "", style, label, ref: forwardedRef, id: suppliedId, disabled, "aria-label": ariaLabel, "aria-labelledby": labelledBy, "aria-describedby": describedBy, "aria-invalid": ariaInvalid, ...nativeProps }: SelectProps) {
  const generatedId = useId();
  const id = suppliedId ?? `alfred-select-${generatedId}`;
  const options = useMemo(() => collectSelectOptions(children), [children]);
  const controlledValue = scalar(value);
  const [uncontrolledValue, setUncontrolledValue] = useState(() => scalar(defaultValue) ?? options.find(option => !option.disabled && !option.hidden)?.value ?? "");
  const selectedValue = controlledValue ?? uncontrolledValue;
  const selectedIndex = options.findIndex(option => option.value === selectedValue);
  const selected = options[selectedIndex];
  const unknown = selectedIndex < 0 && selectedValue !== "";
  const unavailable = selectedIndex < 0;
  const [open, setOpen] = useState(false);
  const [invalidMessage, setInvalidMessage] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [fallbackLabel, setFallbackLabel] = useState(label ?? ariaLabel ?? "Choose an option");
  const [position, setPosition] = useState<CSSProperties>({});
  const [initialResetValue] = useState(() => scalar(defaultValue) ?? uncontrolledValue);
  const resetDefaultValue = scalar(defaultValue) ?? initialResetValue;
  // Keep missing defaults available to the browser's native form reset after a valid choice.
  const retainedValues = [...new Set([...(unavailable ? [selectedValue] : []), ...(!options.some(option => option.value === resetDefaultValue) ? [resetDefaultValue] : [])])];
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const ownedValidity = useRef(false);
  const currentValue = useRef(controlledValue);
  const currentDefaultValue = useRef(resetDefaultValue);
  const pendingFocus = useRef<HTMLElement | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const searchable = options.filter(option => !option.hidden).length > 8;
  const visible = options.map((option, index) => ({ ...option, index })).filter(option => !option.hidden && (!query || option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const menuLabel = label ?? ariaLabel ?? fallbackLabel;
  const listId = `${id}-options`, titleId = `${id}-title`;
  const invalidId = `${id}-validation`;
  const description = [describedBy, invalidMessage ? invalidId : null].filter(Boolean).join(" ") || undefined;
  const activeOption = visible.some(option => option.index === active && !option.disabled) ? active : visible.find(option => !option.disabled)?.index ?? -1;
  const setNativeRef = useCallback((node: HTMLSelectElement | null) => {
    native.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  const close = useCallback(() => setOpen(false), []);
  function openPicker(start?: "first" | "last" | string) {
    if (disabled || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(box.width, 240), window.innerWidth - 24);
    const below = window.innerHeight - box.bottom - 20;
    const above = box.top - 20;
    const down = below >= Math.min(260, above);
    setPosition({ "--select-left": `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`, "--select-width": `${width}px`, "--select-top": down ? `${box.bottom + 8}px` : "auto", "--select-bottom": down ? "auto" : `${window.innerHeight - box.top + 8}px`, "--select-max-height": `${Math.max(120, down ? below : above)}px` } as CSSProperties);
    setQuery(searchable && start && start !== "first" && start !== "last" ? start : "");
    const initial = start === "last" ? nextSelectOption(options, 0, -1) : start === "first" ? nextSelectOption(options, -1, 1) : typeof start === "string" ? findSelectTypeahead(options, selectedIndex, start) : selectedIndex;
    setActive(initial >= 0 && !options[initial]?.disabled ? initial : nextSelectOption(options, -1, 1));
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled || option.hidden || disabled || !native.current) return;
    changeNativeSelect(native.current, option.value);
    close();
  }
  function move(direction: 1 | -1) {
    const index = visible.findIndex(option => option.index === activeOption);
    const next = nextSelectOption(visible, index, direction);
    if (next >= 0) setActive(visible[next].index);
  }
  function typeahead(key: string, now: number) {
    const text = now - typed.current.at > 700 ? key : typed.current.text + key;
    typed.current = { text, at: now };
    const repeated = text.split("").every(character => character === text[0]);
    const match = findSelectTypeahead(options, activeOption, repeated ? key : text);
    if (match >= 0) setActive(match);
  }
  function tabAway(backwards: boolean) {
    const anchor = trigger.current;
    if (!anchor) return;
    const scope = anchor.closest("dialog[open], [role=dialog]") ?? document;
    const elements = Array.from(scope.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(node => node.getClientRects().length > 0 && node.tabIndex >= 0 && !node.closest(".alfred-select-dialog") && !node.matches(".alfred-select-native"));
    const index = elements.indexOf(anchor);
    pendingFocus.current = elements[index + (backwards ? -1 : 1)] ?? anchor;
    close();
  }

  useEffect(() => {
    currentValue.current = controlledValue;
    currentDefaultValue.current = resetDefaultValue;
  }, [controlledValue, resetDefaultValue]);

  useEffect(() => {
    const node = native.current;
    if (!node) return;
    const parentLabel = node.labels?.[0];
    const directLabel = parentLabel?.querySelector(":scope > .alfred-field-label, :scope > span");
    const text = directLabel?.textContent?.trim() || Array.from(parentLabel?.childNodes ?? []).filter(child => child.nodeType === 3).map(child => child.textContent).join(" ").trim();
    if (text) queueMicrotask(() => setFallbackLabel(text));
    const form = node.form;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const reset = (event: Event) => {
      if (resetTimer !== undefined) clearTimeout(resetTimer);
      // A microtask may run before the browser's reset default action. Restore only after it.
      resetTimer = setTimeout(() => {
        if (event.defaultPrevented) return;
        const restored = currentValue.current ?? currentDefaultValue.current;
        node.value = restored;
        if (currentValue.current === undefined) setUncontrolledValue(restored);
        setInvalidMessage("");
        close();
      }, 0);
    };
    form?.addEventListener("reset", reset);
    return () => { form?.removeEventListener("reset", reset); if (resetTimer !== undefined) clearTimeout(resetTimer); };
  }, [close]);

  useEffect(() => {
    const node = native.current;
    if (!node) return;
    // A blank or unavailable saved value must never become the first real option.
    node.value = selectedValue;
    if (unknown) { node.setCustomValidity("Choose an available option."); ownedValidity.current = true; }
    else if (ownedValidity.current) { node.setCustomValidity(""); ownedValidity.current = false; }
    if (!unknown && node.validity.valid) queueMicrotask(() => setInvalidMessage(""));
  }, [unknown, selectedValue, options]);

  useEffect(() => {
    if (!open) return;
    const node = popup.current;
    if (!node || disabled) { queueMicrotask(close); return; }
    const unlock = lockSelectScroll();
    const control = trigger.current;
    node.showModal();
    (searchable && !window.matchMedia("(max-width:720px)").matches ? search.current : list.current)?.focus({ preventScroll: true });
    const initialWidth = window.innerWidth;
    // Opening a phone keyboard changes only height. Keep the active picker open.
    const dismissOnViewport = () => { if (window.innerWidth !== initialWidth) close(); };
    window.addEventListener("resize", dismissOnViewport);
    return () => {
      window.removeEventListener("resize", dismissOnViewport);
      if (node.open) node.close();
      unlock();
      const nextFocus = pendingFocus.current ?? control;
      pendingFocus.current = null;
      if (nextFocus?.isConnected && !nextFocus.matches(":disabled")) nextFocus.focus({ preventScroll: true });
    };
  }, [open, disabled, searchable, close]);

  useEffect(() => {
    if (!open || activeOption < 0) return;
    list.current?.querySelector<HTMLElement>(`[data-option-index="${activeOption}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeOption, open]);

  return <span className="alfred-select">
    <select {...nativeProps} id={id} ref={setNativeRef} className="alfred-select-native" tabIndex={-1} aria-hidden="true" disabled={disabled} value={value} defaultValue={defaultValue} aria-label={ariaLabel} aria-labelledby={labelledBy} aria-describedby={description} aria-invalid={ariaInvalid || Boolean(invalidMessage) || undefined} onFocus={event => { onFocus?.(event); trigger.current?.focus({ preventScroll: true }); }} onInvalid={event => { event.preventDefault(); setInvalidMessage(unknown ? "Choose an available option." : event.currentTarget.validationMessage || "Choose an option."); onInvalid?.(event); trigger.current?.focus(); }} onChange={event => { setUncontrolledValue(event.currentTarget.value); setInvalidMessage(""); onChange?.(event); }}>
      {retainedValues.map(retained => <option key={retained} value={retained} hidden>{retained ? "Unavailable selection" : "Choose an option"}</option>)}{children}
    </select>
    <button type="button" ref={trigger} id={`${id}-trigger`} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-label={label ?? ariaLabel ?? (!labelledBy ? fallbackLabel : undefined)} aria-labelledby={labelledBy} aria-describedby={description} aria-errormessage={invalidMessage ? invalidId : nativeProps["aria-errormessage"]} aria-invalid={ariaInvalid || unknown || Boolean(invalidMessage) || undefined} aria-required={nativeProps.required || undefined} disabled={disabled} className={`alfred-select-trigger ${className}`} style={style} onClick={() => openPicker()} onKeyDown={event => {
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openPicker(event.key === "Home" ? "first" : event.key === "End" || event.key === "ArrowUp" ? "last" : undefined); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); openPicker(event.key); }
    }}><span className={!selected || selected.value === "" ? "alfred-select-placeholder" : undefined}>{selected?.label || (unknown ? "Unavailable selection" : "Choose an option")}</span><span className="alfred-select-indicators">{ariaInvalid || unknown || invalidMessage ? <span className="alfred-select-errorIcon" aria-hidden="true" /> : null}<span className="alfred-select-chevron" aria-hidden="true" /></span></button>
    {invalidMessage ? <span id={invalidId} className="alfred-select-validation" role="alert">{invalidMessage}</span> : null}
    {open && createPortal(<dialog ref={popup} className="alfred-select-dialog" style={position} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onClick={event => {
      event.stopPropagation();
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }} onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Tab") { event.preventDefault(); tabAway(event.shiftKey); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      else if (event.key === "Home" && event.target !== search.current) { event.preventDefault(); setActive(nextSelectOption(options, -1, 1)); }
      else if (event.key === "End" && event.target !== search.current) { event.preventDefault(); setActive(nextSelectOption(options, 0, -1)); }
      else if (event.key === "Enter" || event.key === " " && event.target !== search.current) { event.preventDefault(); choose(activeOption); }
      else if (event.target !== search.current && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); typeahead(event.key, event.timeStamp); }
    }}>
      <span className="alfred-select-sheetHandle" aria-hidden="true" />
      <header className="alfred-select-menuHeader"><h2 id={titleId}>{menuLabel}</h2><button type="button" onClick={close} aria-label={`Close ${menuLabel} options`}>×</button></header>
      {searchable ? <div className="alfred-select-search"><input ref={search} type="search" role="combobox" aria-label={`Search ${menuLabel} options`} aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="true" aria-activedescendant={activeOption >= 0 ? `${id}-option-${activeOption}` : undefined} placeholder="Search options…" value={query} onChange={event => setQuery(event.target.value)} aria-controls={listId} autoComplete="off" /></div> : null}
      <div ref={list} id={listId} role="listbox" tabIndex={0} aria-label={menuLabel} aria-activedescendant={activeOption >= 0 ? `${id}-option-${activeOption}` : undefined} className="alfred-select-list">
        {visible.map((option, index) => <Fragment key={`${option.index}:${option.value}`}>
          {option.group && option.group !== visible[index - 1]?.group ? <div className="alfred-select-group" role="presentation">{option.group}</div> : null}
          <button type="button" role="option" id={`${id}-option-${option.index}`} data-option-index={option.index} tabIndex={-1} aria-selected={option.index === selectedIndex} disabled={option.disabled} className={`alfred-select-option${option.index === activeOption ? " is-active" : ""}`} onPointerMove={() => { if (!option.disabled) setActive(option.index); }} onClick={() => choose(option.index)}><span>{option.label}</span>{option.index === selectedIndex ? <span className="alfred-select-check" aria-hidden="true" /> : null}</button>
        </Fragment>)}
        {!visible.length ? <p className="alfred-select-empty">No matching options</p> : null}
      </div>
    </dialog>, document.body)}
  </span>;
}
