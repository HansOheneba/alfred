"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Spinner } from "@/app/components/status";
import { Button, EmptyState, inputClass, sendJson } from "@/app/components/ui";
import type { AboutNote } from "@/lib/notebook/store";
import type { KnownPerson } from "@/lib/web/people";

function Person({ person }: { person: KnownPerson }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(person.note);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function run(key: string, method: string, body: unknown) {
    setBusy(key);
    setError("");
    try {
      await sendJson("/api/people", method, body);
      setEditing(false);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="min-w-0 truncate text-[15px] text-ink">{person.name}</h2>
        {!editing ? (
          <button type="button" className="shrink-0 text-xs text-accent underline-offset-4 hover:underline" onClick={() => setEditing(true)}>
            {person.note ? "Edit note" : "Add a note"}
          </button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim()) void run("save", "POST", { name: person.name, note: note.trim() });
          }}
        >
          <label>
            <span className="sr-only">What Alfred should know about {person.name}</span>
            <textarea
              className={`${inputClass} min-h-20 py-2`}
              value={note}
              maxLength={300}
              placeholder="e.g. Cyril's friend. Usually sends money on his behalf."
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy !== null || !note.trim()}>
              {busy === "save" ? <Spinner className="size-3" /> : null}
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setNote(person.note);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : person.note ? (
        <p className="mt-1 text-sm leading-6 text-muted">{person.note}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        {person.filing ? <span className="rounded-full bg-surface-2 px-2.5 py-1 text-ink">Files as {person.filing}</span> : <span>Alfred asks about their payments</span>}
        {person.note && !editing ? (
          <button type="button" className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-ink hover:underline" disabled={busy !== null} onClick={() => void run("note", "DELETE", { personKey: person.personKey, what: "note" })}>
            {busy === "note" ? <Spinner className="size-3" /> : null}
            Forget note
          </button>
        ) : null}
        {person.filing ? (
          <button type="button" className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-ink hover:underline" disabled={busy !== null} onClick={() => void run("filing", "DELETE", { personKey: person.personKey, what: "filing" })}>
            {busy === "filing" ? <Spinner className="size-3" /> : null}
            Ask me again instead
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function AddPerson() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <form
      className="flex flex-col gap-2 rounded-2xl border border-dashed border-line p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await sendJson("/api/people", "POST", { name: name.trim(), note: note.trim() });
          setName("");
          setNote("");
          router.refresh();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-ink">Tell Alfred about someone</p>
      <label>
        <span className="sr-only">Name</span>
        <input className={`${inputClass} h-9`} value={name} maxLength={120} placeholder="Name, as it appears in your texts" onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span className="sr-only">Note</span>
        <input className={`${inputClass} h-9`} value={note} maxLength={300} placeholder="Who they are, or what their payments usually are" onChange={(event) => setNote(event.target.value)} />
      </label>
      <div>
        <Button type="submit" size="sm" variant="primary" disabled={busy || !name.trim() || !note.trim()}>
          {busy ? <Spinner className="size-3" /> : null}
          Save
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** One thing Alfred has learnt about the person, with a way to forget it. */
function AboutItem({ item }: { item: AboutNote }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-[15px] leading-6 text-ink">{item.note}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        {item.account ? <span className="rounded-full bg-surface-2 px-2.5 py-1 text-ink">Ignoring texts from account ending {item.account}</span> : null}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-ink hover:underline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await sendJson("/api/notebook", "DELETE", { id: item.id });
              router.refresh();
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner className="size-3" /> : null}
          {item.account ? "Stop ignoring it" : "Forget this"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function AddAbout() {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <form
      className="flex flex-col gap-2 rounded-2xl border border-dashed border-line p-4 sm:flex-row sm:items-center"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await sendJson("/api/notebook", "POST", { note: note.trim() });
          setNote("");
          router.refresh();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="min-w-0 flex-1">
        <span className="sr-only">Something Alfred should know about you</span>
        <input className={`${inputClass} h-9`} value={note} maxLength={300} placeholder="e.g. I'm paid on the 25th" onChange={(event) => setNote(event.target.value)} />
      </label>
      <Button type="submit" size="sm" variant="primary" disabled={busy || !note.trim()}>
        {busy ? <Spinner className="size-3" /> : null}
        Add
      </Button>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function NotebookClient({ people, about }: { people: KnownPerson[]; about: AboutNote[] }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-6 pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:px-6">
      <div>
        <h1 className="font-display text-2xl font-medium leading-tight tracking-tight text-ink">Notebook</h1>
        <p className="mt-1 text-sm text-muted">
          What Alfred has learnt about you and the people in your money. He adds to it when you tell him things in chat, like &ldquo;don&rsquo;t look at that account, it&rsquo;s my mum&rsquo;s&rdquo; or &ldquo;Cyril is my housemate&rdquo;, and keeps it in mind every time you talk.
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="about-heading">
        <h2 id="about-heading" className="text-sm font-medium text-ink">
          About you
        </h2>
        {about.length === 0 ? <EmptyState>Nothing yet. Tell Alfred something about how you handle money, or add it here.</EmptyState> : null}
        {about.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {about.map((item) => (
              <AboutItem key={item.id} item={item} />
            ))}
          </ul>
        ) : null}
        <AddAbout />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="people-heading">
        <h2 id="people-heading" className="text-sm font-medium text-ink">
          People
        </h2>
        <AddPerson />
        {people.length === 0 ? (
          <EmptyState>Nobody yet. Once you label a few payments or tell Alfred about someone, they&rsquo;ll show up here.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {people.map((person) => (
              <Person key={person.personKey} person={person} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
