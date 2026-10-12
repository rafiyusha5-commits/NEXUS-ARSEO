// Stroke icons of the navigation groups (decorative: the text label is always shown next to them).
const paths: Record<string, React.ReactNode> = {
  "Главная": <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  "Закупки": <><path d="M1 4h14v11H1z" /><path d="M15 8h4l3 3v4h-7z" /><circle cx="5.5" cy="18" r="2" /><circle cx="18.5" cy="18" r="2" /></>,
  "Продажи": <><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M2 3h3l3 12h11l2-8H6.5" /></>,
  "Логистика": <><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H16a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h7.5" /></>,
  "Склад": <><path d="M21 8l-9-5-9 5v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>,
  "Справочники": <><path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2" /><path d="M8 7h8M8 11h6" /></>,
  "Финансы": <><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20" /><path d="M16 15h2" /></>,
  "Документы": <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>,
  "Планирование": <><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>,
  "Администрирование": <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  "Кабинет": <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
};

export function NavIcon({ group }: { group: string }) {
  return (
    <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[group] ?? paths["Главная"]}
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
