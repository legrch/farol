// Observe one fresh fixture before its cleanup decision. No process is signalled
// and no retained UNKNOWN fixture is supplied to this helper.
export async function settleFixtureCleanup(observe, ports) {
  const deadline = ports.now() + ports.budgetMs;
  let state = observe();
  while (
    !ports.clear(state) &&
    ports.complete(state) &&
    ports.now() < deadline
  ) {
    await ports.delay(Math.min(100, deadline - ports.now()));
    state = observe();
  }
  return state;
}
