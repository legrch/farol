import { useRef, useState } from "react";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { setupSteps } from "../../../src/ui/renderer/setup-navigation";
import { Overlay } from "./overlay";
import { pages } from "./pages";

export function Search({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const targets = [
    { label: "Home", area: "home" as const, page: "general" as const },
    { label: "ChatGPT", area: "chatgpt" as const, page: "general" as const },
    { label: "Activity", area: "activity" as const, page: "general" as const },
    { label: "Setup", area: "setup" as const, page: "general" as const },
    ...setupSteps.slice(1).map(([setupStep, label]) => ({
      label,
      area: "setup" as const,
      setupStep,
      page: "general" as const,
    })),
    ...pages.map(([page, label]) => ({
      label,
      area: "settings" as const,
      page,
    })),
  ];
  return (
    <Overlay
      title="Find a page"
      onClose={() => facade.overlay("none")}
      initialFocus={input}
    >
      <input
        ref={input}
        aria-label="Find a page"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            const first = targets.find((item) =>
              item.label.toLowerCase().includes(query.toLowerCase()),
            );
            if (first) facade.navigate(first);
          }
        }}
      />
      <div className="search-results">
        {targets
          .filter((item) =>
            item.label.toLowerCase().includes(query.toLowerCase()),
          )
          .map((item) => (
            <button key={item.label} onClick={() => facade.navigate(item)}>
              {item.label}
            </button>
          ))}
        {snapshot.tasks.tasks
          .filter((task) =>
            task.label.toLowerCase().includes(query.toLowerCase()),
          )
          .map((task) => (
            <button
              key={task.taskId}
              onClick={() =>
                facade.navigate({ area: "chatgpt", taskId: task.taskId })
              }
            >
              {task.label}
            </button>
          ))}
      </div>
    </Overlay>
  );
}
