"use client";

import { type ButtonHTMLAttributes } from "react";
import { useFormStatus } from "react-dom";

export function PendingSubmitButton({ children, pendingText, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  pendingText: string;
}) {
  const { pending } = useFormStatus();
  return <button {...props} aria-busy={pending} disabled={disabled || pending} type="submit">
    {pending ? pendingText : children}
  </button>;
}
