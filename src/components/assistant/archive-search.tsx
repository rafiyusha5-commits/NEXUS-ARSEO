"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RequestProgress } from "./request-progress";

export function ArchiveSearch({ query }: { query: string }) {
  const router = useRouter();
  const [value, setValue] = useState(query);
  const [pending, startTransition] = useTransition();

  return <form className="archive-search" method="get" aria-busy={pending} onSubmit={event => {
    event.preventDefault();
    if (pending) return;
    const href = `/assistant/archive?${new URLSearchParams({ q: value.trim() })}`;
    startTransition(() => {
      if (window.location.pathname + window.location.search === href) router.refresh();
      else router.push(href);
    });
  }}>
    <label>Название или бренд <input name="q" value={value} onChange={event => setValue(event.target.value)} maxLength={120} placeholder="Belgian ДС" disabled={pending} /></label>
    <button className="primary" type="submit" disabled={pending}>{pending ? "Ищу…" : "Найти"}</button>
    {pending && <RequestProgress label="Ищу документы в архиве…" />}
  </form>;
}
