import { useMemo } from "react";
import { StoredReplies } from "../../../apps/desktop/renderer/recovery/archive";
import type { RendererFacade, WindowSnapshot } from "./contract";

const busyObservation = (_value: boolean) => {};

/** Current session read authority only; remount on every context/epoch change. */
export function RetiredReplies({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const context = snapshot.chatHistoryContext;
  const key = JSON.stringify([
    snapshot.status,
    snapshot.chatHistoryEpoch,
    context?.profileId,
    context?.backendGeneration,
  ]);
  const api = useMemo(
    () => ({
      read: (query: unknown) => {
        if (!facade.readRetiredReplies)
          return Promise.reject(new Error("RETIRED_REPLY_UNAVAILABLE"));
        return facade.readRetiredReplies(query);
      },
    }),
    [facade],
  );
  return (
    <StoredReplies
      key={key}
      api={api}
      available={
        snapshot.status === "current" &&
        context !== null &&
        facade.readRetiredReplies !== undefined
      }
      starting={false}
      otherBusy={false}
      onBusy={busyObservation}
      context="retired"
    />
  );
}
