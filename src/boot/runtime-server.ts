import { ReadonlyComputerPeer } from "../modules/chat/infra/peer/readonly-computer-peer";
import {
  startPreviewRuntime as startChatPreviewRuntime,
  type PreviewMode,
  type PreviewRuntime,
  type PreviewScenario,
} from "../modules/chat/infra/server/preview-runtime";
import { createFixtureComputerContract } from "../modules/computer/infra/fixture/create-fixture-contract";
import { SystemClock } from "../pkg/kernel/infra/system-clock";
import { taskPage } from "../ui/task-page";

export type {
  PreviewCloseReceipt,
  PreviewMode,
  PreviewRuntime,
  PreviewScenario,
  PreviewTask,
} from "../modules/chat/infra/server/preview-runtime";

export function startPreviewRuntime(
  scenario: PreviewScenario = "normal",
  mode: PreviewMode = "empty",
): Promise<PreviewRuntime> {
  return startChatPreviewRuntime(
    scenario,
    {
      createClock: () => new SystemClock(),
      createComputer: (task, approval) => {
        const fixture = createFixtureComputerContract(
          task,
          approval,
          new SystemClock(),
        );
        return new ReadonlyComputerPeer(fixture.contract, fixture.binding);
      },
      renderTaskPage: taskPage,
    },
    mode,
  );
}
