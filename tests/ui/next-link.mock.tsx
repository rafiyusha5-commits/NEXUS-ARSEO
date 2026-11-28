import React from "react";
// next/link outside the application router: a plain link is enough for rendering checks.
export default function Link({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a href={href} {...props}>{children}</a>;
}
