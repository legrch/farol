/** Closed diagnostic pipes must not terminate the desktop process. They say
 * nothing about the outcome of the operations being reported. */
export function guardDiagnosticPipes(
  streams: readonly NodeJS.WritableStream[],
): void {
  for (const stream of new Set(streams)) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
}
