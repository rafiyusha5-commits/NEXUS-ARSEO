"use client";
import { useFormStatus } from "react-dom";
export function DriveSubmit({ children, pending }: { children: React.ReactNode; pending: string }) {
  const status = useFormStatus();
  return <><button className="primary" disabled={status.pending} type="submit">{status.pending ? pending : children}</button>{status.pending && <p role="status" aria-live="polite"><progress aria-label={pending}/> {pending}</p>}</>;
}
