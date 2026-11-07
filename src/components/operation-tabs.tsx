import Link from "next/link";
import { Children, type ReactNode } from "react";

type OperationTab = {
  id: string;
  label: string;
  badge?: string | number;
};

export function OperationTabs({
  tabs,
  children,
  defaultTab,
  activeTab,
  ariaLabel = "Разделы операции",
}: {
  tabs: OperationTab[];
  children: ReactNode;
  defaultTab?: string;
  activeTab?: string;
  ariaLabel?: string;
}) {
  const selectedTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : defaultTab ?? tabs[0]?.id ?? "";
  const panels = Children.toArray(children);

  return (
    <div className="operation-tabs">
      <nav className="operation-tab-list" aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <Link
            aria-current={selectedTab === tab.id ? "page" : undefined}
            className="operation-tab-button"
            href={`?tab=${tab.id}`}
            id={`operation-tab-${tab.id}`}
            key={tab.id}
          >
            <span>{tab.label}</span>
            {tab.badge !== undefined && <b>{tab.badge}</b>}
          </Link>
        ))}
      </nav>
      {tabs.map((tab, index) => selectedTab === tab.id && <section aria-labelledby={`operation-tab-${tab.id}`} className="operation-tab-panel" id={`operation-panel-${tab.id}`} key={tab.id}>{panels[index]}</section>)}
    </div>
  );
}
