"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import { Button, EmptyState, inputClass } from "@/app/components/ui";
import type { AboutNote } from "@/lib/notebook/store";
import type { KnownPerson } from "@/lib/web/people";
import { previewAbout, previewPeople } from "@/ui-preview/destination-fixtures";

type Notebook = { about: AboutNote[]; people: KnownPerson[] };
const initial: Notebook = { about: previewAbout, people: previewPeople };
const initialSnapshot = JSON.stringify(initial);
const storageKey = "alfred-ui-preview-notebook-v1";
const changeEvent = "alfred:preview-notebook";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(changeEvent, onChange);
  return () => { window.removeEventListener("storage", onChange); window.removeEventListener(changeEvent, onChange); };
}

function snapshot() {
  try { return window.localStorage.getItem(storageKey) ?? initialSnapshot; }
  catch { return initialSnapshot; }
}

function readNotebook(value: string): Notebook {
  try {
    const parsed = JSON.parse(value) as Notebook;
    if (Array.isArray(parsed.about) && Array.isArray(parsed.people)
      && parsed.about.every((note) => typeof note.id === "string" && typeof note.note === "string")
      && parsed.people.every((person) => typeof person.personKey === "string" && typeof person.name === "string" && typeof person.note === "string" && typeof person.filing === "string")) return parsed;
  } catch { /* A malformed local demo snapshot falls back to the synthetic fixtures. */ }
  return initial;
}

export function ChatNotebookPreview() {
  const stored = useSyncExternalStore(subscribe, snapshot, () => initialSnapshot);
  const notebook = useMemo(() => readNotebook(stored), [stored]);
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [personNote, setPersonNote] = useState("");
  const [status, setStatus] = useState("");

  function save(next: Notebook, message: string) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      window.dispatchEvent(new Event(changeEvent));
      setStatus(message);
    } catch { setStatus("This browser could not save the demo note. Browser storage may be unavailable."); }
  }

  return <div className="flex flex-col gap-7">
    <p className="text-xs leading-6 text-muted">Keep useful context alongside your conversation. Try adding a demo note or editing what Alfred remembers about someone.</p>
    <section className="flex flex-col gap-3" aria-labelledby="preview-about-heading">
      <h3 className="text-sm font-medium" id="preview-about-heading">About you</h3>
      {notebook.about.length ? <ul className="flex flex-col gap-3">{notebook.about.map((item) => <DemoNote key={item.id} item={item} onSave={(text) => save({ ...notebook, about: notebook.about.map((row) => row.id === item.id ? { ...row, note: text } : row) }, "Demo note updated.")} onForget={() => save({ ...notebook, about: notebook.about.filter((row) => row.id !== item.id) }, "Demo note forgotten.")}/>)}</ul> : <EmptyState>No notes yet. Add something Alfred should remember.</EmptyState>}
      <form data-preview-local-form="true" className="flex flex-col gap-2 rounded-xl border border-dashed border-line p-4" onSubmit={(event) => {
        event.preventDefault();
        if (!note.trim()) return;
        save({ ...notebook, about: [...notebook.about, { id: `demo-${crypto.randomUUID()}`, note: note.trim(), account: null, createdAt: "2026-10-24T12:00:00Z" }] }, "Demo note added.");
        setNote("");
      }}>
        <label className="text-xs text-muted" htmlFor="preview-notebook-note">Something Alfred should know</label>
        <input id="preview-notebook-note" className={`${inputClass} h-10`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. I'm paid on the 25th" maxLength={300}/>
        <Button type="submit" size="sm" variant="primary" className="self-start" disabled={!note.trim()}>Add note</Button>
      </form>
    </section>
    <section className="flex flex-col gap-3" aria-labelledby="preview-people-heading">
      <h3 className="text-sm font-medium" id="preview-people-heading">People</h3>
      {notebook.people.length ? <ul className="flex flex-col gap-3">{notebook.people.map((person) => <DemoPerson key={person.personKey} person={person} onChange={(next) => save({ ...notebook, people: notebook.people.map((row) => row.personKey === person.personKey ? next : row) }, "Demo person updated.")}/>)}</ul> : <EmptyState>Nobody yet. Add someone Alfred should remember.</EmptyState>}
      <form data-preview-local-form="true" className="flex flex-col gap-2 rounded-xl border border-dashed border-line p-4" onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || !personNote.trim()) return;
        const existing = notebook.people.find((person) => person.name.toLowerCase() === name.trim().toLowerCase());
        const person: KnownPerson = { personKey: existing?.personKey ?? `demo-${crypto.randomUUID()}`, name: name.trim(), note: personNote.trim(), filing: existing?.filing ?? "" };
        save({ ...notebook, people: existing ? notebook.people.map((row) => row.personKey === existing.personKey ? person : row) : [...notebook.people, person] }, "Demo person saved.");
        setName(""); setPersonNote("");
      }}>
        <p className="text-xs font-medium">Tell Alfred about someone</p>
        <label className="text-xs text-muted" htmlFor="preview-notebook-person">Name</label>
        <input id="preview-notebook-person" className={`${inputClass} h-10`} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Their name"/>
        <label className="text-xs text-muted" htmlFor="preview-notebook-person-note">What should Alfred remember?</label>
        <input id="preview-notebook-person-note" className={`${inputClass} h-10`} value={personNote} onChange={(event) => setPersonNote(event.target.value)} maxLength={300} placeholder="e.g. My housemate"/>
        <Button type="submit" size="sm" variant="primary" className="self-start" disabled={!name.trim() || !personNote.trim()}>Save person</Button>
      </form>
    </section>
    <p className="text-xs leading-5 text-muted" role="status" aria-live="polite">{status || "Demo changes stay in this browser and do not update an account."}</p>
  </div>;
}

function DemoNote({ item, onSave, onForget }: { item: AboutNote; onSave: (note: string) => void; onForget: () => void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(item.note);
  return <li className="rounded-xl border border-line bg-surface p-4"><form data-preview-local-form="true" onSubmit={(event) => { event.preventDefault(); if (note.trim()) { onSave(note.trim()); setEditing(false); } }}>
    {editing ? <><label className="sr-only" htmlFor={`edit-${item.id}`}>Edit note</label><textarea id={`edit-${item.id}`} className={`${inputClass} min-h-24 py-2`} value={note} maxLength={300} onChange={(event) => setNote(event.target.value)}/><div className="mt-2 flex gap-2"><Button type="submit" size="sm" variant="primary" disabled={!note.trim()}>Save note</Button><Button size="sm" onClick={() => { setEditing(false); setNote(item.note); }}>Cancel</Button></div></> : <><p className="text-sm leading-6">{item.note}</p><div className="mt-3 flex gap-4 text-xs"><button type="button" className="text-accent" onClick={() => setEditing(true)}>Edit note</button><button type="button" className="text-muted hover:text-ink" onClick={onForget}>Forget this</button></div></>}
  </form></li>;
}

function DemoPerson({ person, onChange }: { person: KnownPerson; onChange: (person: KnownPerson) => void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(person.note);
  return <li className="rounded-xl border border-line bg-surface p-4"><form data-preview-local-form="true" onSubmit={(event) => { event.preventDefault(); if (note.trim()) { onChange({ ...person, note: note.trim() }); setEditing(false); } }}>
    <div className="flex items-baseline justify-between gap-3"><h4 className="text-sm font-medium">{person.name}</h4>{!editing ? <button type="button" className="shrink-0 text-xs text-accent" onClick={() => { setNote(person.note); setEditing(true); }}>{person.note ? "Edit note" : "Add a note"}</button> : null}</div>
    {editing ? <><label className="sr-only" htmlFor={`edit-${person.personKey}`}>What Alfred should know about {person.name}</label><textarea id={`edit-${person.personKey}`} className={`${inputClass} mt-2 min-h-24 py-2`} value={note} maxLength={300} onChange={(event) => setNote(event.target.value)}/><div className="mt-2 flex gap-2"><Button type="submit" size="sm" variant="primary" disabled={!note.trim()}>Save person note</Button><Button size="sm" onClick={() => setEditing(false)}>Cancel</Button></div></> : person.note ? <p className="mt-1 text-sm leading-6 text-muted">{person.note}</p> : null}
    {!editing ? <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted"><span>{person.filing ? `Files as ${person.filing}` : "Alfred asks about their payments"}</span>{person.note ? <button type="button" className="hover:text-ink" onClick={() => onChange({ ...person, note: "" })}>Forget note</button> : null}{person.filing ? <button type="button" onClick={() => onChange({ ...person, filing: "" })}>Ask me again instead</button> : null}</div> : null}
  </form></li>;
}
