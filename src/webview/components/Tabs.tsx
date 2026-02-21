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
  const current = tabs.find((t) => t.id === active);

  return (
    <div class="flex flex-col h-full">
      <div class="flex gap-0 border-b border-panel">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            class={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              tab.id === active
                ? "tab-active"
                : "border-transparent muted hover:text-[var(--vscode-editor-foreground)]"
            }`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div class="flex-1 overflow-auto p-3">{current?.content}</div>
    </div>
  );
}
