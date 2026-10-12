import type { WindowSnapshot } from "./contract";

type DownloadView = Extract<WindowSnapshot["update"], { phase: "downloading" }>;

export function updateDownloadMessage(update: DownloadView): string {
  return update.progress?.stage === "verifying"
    ? "Checking the downloaded update. You can keep working."
    : "Downloading update in the background. Keep working.";
}

/** Byte progress describes the transfer only; Release owns package readiness. */
export function UpdateDownloadProgress({ update }: { update: DownloadView }) {
  const progress = update.progress;
  if (progress?.stage !== "transferring") return null;
  const percent = Math.floor(
    (100 * progress.receivedBytes) / progress.totalBytes,
  );
  const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  return (
    <div className="update-download-progress">
      <progress
        aria-label="Update download"
        max={progress.totalBytes}
        value={progress.receivedBytes}
      />
      <span>
        {percent}% · {megabytes(progress.receivedBytes)} of{" "}
        {megabytes(progress.totalBytes)} MB
      </span>
    </div>
  );
}
