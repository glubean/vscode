import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

interface Tab {
  id: string;
  label: string;
  content: ComponentChildren;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
}

export function Tabs({ tabs, defaultTab }: TabsProps) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id ?? "");

  // If the active tab no longer exists (e.g. switching from failed to passed
  // result where Errors tab disappears), fall back to the first tab.
  const resolved = tabs.find((t) => t.id === active) ? active : (defaultTab ?? tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === resolved);

  return (
    <div class="flex flex-col h-full min-h-0">
      <div class="flex items-center gap-1.5 px-3 py-2 shrink-0 border-b border-panel bg-sidebar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            class={`tab-pill-base px-3 py-1.5 text-xs font-normal transition-colors cursor-pointer ${
              tab.id === resolved
                ? "tab-pill-active"
                : "tab-pill-inactive"
            }`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div class="flex-1 min-h-0 overflow-hidden">{current?.content}</div>
    </div>
  );
}
