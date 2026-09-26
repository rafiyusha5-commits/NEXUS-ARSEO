import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus-ARSEO",
  description: "Управление импортом, экспортом и логистикой ТОО ARSEO",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
