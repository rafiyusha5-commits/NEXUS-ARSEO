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
}: {
  tabs: OperationTab[];
  children: ReactNode;
  defaultTab?: string;
  activeTab?: string;
}) {
  const selectedTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : defaultTab ?? tabs[0]?.id ?? "";
  const panels = Children.toArray(children);

  return (
    <div className="operation-tabs">
      <div className="operation-tab-list" role="tablist" aria-label="Разделы поставки">
        {tabs.map((tab) => (
          <Link
            aria-controls={`operation-panel-${tab.id}`}
            aria-selected={selectedTab === tab.id}
            className="operation-tab-button"
            href={`?tab=${tab.id}`}
            id={`operation-tab-${tab.id}`}
            key={tab.id}
            role="tab"
          >
            <span>{tab.label}</span>
            {tab.badge !== undefined && <b>{tab.badge}</b>}
          </Link>
        ))}
      </div>
      {tabs.map((tab, index) => selectedTab === tab.id && <div aria-labelledby={`operation-tab-${tab.id}`} className="operation-tab-panel" id={`operation-panel-${tab.id}`} key={tab.id} role="tabpanel">{panels[index]}</div>)}
    </div>
  );
}
