export function fixtureSocketFrames(socket, handle, failure) {
  let pending = "";
  return (chunk) => {
    try {
      pending += String(chunk);
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) return;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        handle(JSON.parse(line));
      }
    } catch (error) {
      failure(error);
      socket.destroy();
    }
  };
}
export function fixtureFailureBoundary() {
  let error;
  return {
    capture(value) {
      error ??=
        value instanceof Error ? value : new Error("FIXTURE_CALLBACK_FAILED");
    },
    async wait(operation) {
      try {
        const result = await operation;
        if (error) throw error;
        return result;
      } catch (failed) {
        throw error ?? failed;
      }
    },
  };
}
