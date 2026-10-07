"use client";

import { type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function PendingSubmitButton({ children, pendingText, className }: {
  children: ReactNode;
  pendingText: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return <button aria-busy={pending} className={className} disabled={pending} type="submit">
    {pending ? pendingText : children}
  </button>;
}
