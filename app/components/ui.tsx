"use client";

import { cloneElement, isValidElement, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Spinner } from "@/app/components/status";
import { buttonClassName, type ButtonSize, type ButtonVariant } from "./button-styles";
import { Select } from "./select";
import "./dialog.css";

// Category hues from the My Money palette: distinct, but muted enough to sit beside the teal.
export const CATEGORY_COLORS = ["#7254ca", "#137d70", "#c77493", "#c9a15f", "#6194dd", "#b94e5b", "#67a69b", "#9b91b3", "#e08a5c", "#8d8994"];

export function categoryColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type="button" {...props} className={buttonClassName({ variant, size, className })} />;
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5 ${className}`}>
      {title || action ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title ? <h2 className="text-sm font-medium text-ink">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: "good" | "bad" }) {
  const toneClass = tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-muted";
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-medium tracking-tight tabular-nums">{value}</p>
      {hint ? <p className={`mt-1 text-xs ${toneClass}`}>{hint}</p> : null}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  const id = useId();
  const labelId = `${id}-label`, hintId = `${id}-hint`, errorId = `${id}-error`;
  let control = children;
  // Associate direct native controls without changing custom components, refs or form behavior.
  if (isValidElement<{ "aria-labelledby"?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false"; "aria-errormessage"?: string }>(children)
    && (children.type === Select || typeof children.type === "string" && ["input", "select", "textarea"].includes(children.type))) {
    const description = [children.props["aria-describedby"], hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
    control = cloneElement(children, {
      ...(children.type === Select ? { "aria-labelledby": children.props["aria-labelledby"] || labelId } : {}),
      ...(description ? { "aria-describedby": description } : {}),
      ...(error ? { "aria-invalid": true, "aria-errormessage": errorId } : {}),
    });
  }
  return (
    <label className="alfred-field">
      <span id={labelId} className="alfred-field-label">{label}</span>
      {control}
      {hint ? <span id={hintId} className="alfred-field-hint">{hint}</span> : null}
      {error ? <span id={errorId} className="alfred-field-hint alfred-field-hint--error">{error}</span> : null}
    </label>
  );
}

export const inputClass = "alfred-input";

/** A modal built on <dialog>, so focus trapping and Escape come from the browser. */
export function Dialog({ open, onClose, title, children, dismissible = true }: { open: boolean; onClose: () => void; title: string; children: ReactNode; dismissible?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      node.showModal();
    }
    if (!open && node.open) node.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    };
  }, [open]);
  const dismiss = () => { if (dismissible) onClose(); };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onClose={() => { if (open) dismiss(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss();
      }}
      className="alfred-dialog"
    >
      <div className="alfred-dialog-surface">
        <span className="alfred-sheet-handle" aria-hidden="true" />
        <header className="alfred-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="secondary" size="icon" onClick={dismiss} disabled={!dismissible} aria-label="Close dialog"><span aria-hidden="true">×</span></Button>
        </header>
        <div className="alfred-dialog-body">{children}</div>
      </div>
    </dialog>
  );
}

/** Grouped modal actions: secondary first, primary last; stacked only on phones. */
export function DialogActions({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <footer className={`alfred-dialog-actions ${className}`}><div className="alfred-dialog-actionGroup alfred-buttonGroup--mobileStack">{children}</div></footer>;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} dismissible={!busy}>
      <div className="text-sm leading-6 text-muted">{body}</div>
      <DialogActions className="mt-5">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy} aria-busy={busy} aria-label={confirmLabel}>
          {busy ? <Spinner /> : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

/** POSTs JSON to one of Alfred's API routes and returns its JSON, throwing the server's message on failure. */
export async function sendJson<T = unknown>(url: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { ok?: boolean; text?: string };
  if (!response.ok || json.ok === false) throw new Error(json.text || "That didn't work. Try again.");
  return json as T;
}
