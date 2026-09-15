import { ComputerPeer } from "../modules/chat/infra/peer/computer-peer";
import {
  startPreviewRuntime as startChatPreviewRuntime,
  type PreviewRuntime,
  type PreviewScenario,
} from "../modules/chat/infra/server/preview-runtime";
import { createFixtureComputerContract } from "../modules/computer/infra/fixture/create-fixture-contract";
import { SystemClock } from "../pkg/kernel/infra/system-clock";
import { taskPage } from "../ui/task-page";

export type {
  PreviewCloseReceipt,
  PreviewRuntime,
  PreviewScenario,
  PreviewTask,
} from "../modules/chat/infra/server/preview-runtime";

export function startPreviewRuntime(
  scenario: PreviewScenario = "normal",
): Promise<PreviewRuntime> {
  return startChatPreviewRuntime(scenario, {
    createClock: () => new SystemClock(),
    createComputer: (task, approval) =>
      new ComputerPeer(
        createFixtureComputerContract(task, approval, new SystemClock()),
      ),
    renderTaskPage: taskPage,
  });
}
