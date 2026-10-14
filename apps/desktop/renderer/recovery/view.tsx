export function StartupRecovery({ quit }: { quit(): void }) {
  return (
    <main className="startup-recovery-view" aria-labelledby="recovery-title">
      <div className="recovery-symbol" aria-hidden="true">
        ↺
      </div>
      <p className="recovery-eyebrow">Computer access paused</p>
      <h1 id="recovery-title">Your previous session needs recovery</h1>
      <p>
        The previous session did not finish cleanly. Your settings and work
        records have been kept.
      </p>
      <p className="recovery-note">
        Recovery must confirm what happened before Computer access can resume.
      </p>
      <button type="button" onClick={quit}>
        Quit
      </button>
    </main>
  );
}
