// An additional reading of the lifecycle soak's own samples.  It changes no
// verdict, no budget and no exit code: `workingSetSlopeKiBPerBatch` and its
// 8192 KiB budget stay exactly as they are, and every FAIL they have ever
// recorded stays a FAIL.  This block exists because that statistic answers a
// different question than the one it is named after.
//
// The measured window contains two application restarts.  Every process is
// replaced at each one, so the ten samples are three separate process
// generations, and a single least-squares line fitted across all of them
// spans two cold starts.  No byte survives a restart, so that line cannot
// measure in-process retention; what it mostly reports is how far into its
// warm-up the final generation happened to be when the run ended.  Across the
// saved attempts it ranged from -852 to +11168 KiB per batch on effectively
// the same bytes.
//
// So this reads the same samples three ways that do not span a restart:
// within a generation, at the same phase across generations, and per process.

function linearSlope(values) {
  if (values.length < 2) return 0;
  const meanX = (values.length - 1) / 2;
  const meanY =
    values.reduce((total, value) => total + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}

function processKey(metric) {
  return metric.name ? `${metric.type}:${metric.name}` : metric.type;
}

// The browser process is replaced by every application restart, so its pid is
// the generation's identity.  Sample points are the baseline followed by each
// batch, in order.
function generationOf(point) {
  const browser = (point.processMetrics ?? []).find(
    (metric) => metric.type === "Browser",
  );
  return browser?.pid ?? null;
}

// A generation needs this many points before a slope through it says anything
// about a trend rather than about where two samples happened to land.
const MINIMUM_TREND_POINTS = 4;

export function retentionDiagnostics({
  baseline,
  samples,
  recoveryEvents = [],
}) {
  const points = [
    { batch: 0, ...baseline },
    ...samples.map((sample) => ({ ...sample })),
  ];
  const generations = [];
  for (const point of points) {
    const pid = generationOf(point);
    const current = generations.at(-1);
    if (!current || current.browserPid !== pid) {
      generations.push({ browserPid: pid, points: [point] });
    } else {
      current.points.push(point);
    }
  }

  const described = generations.map((generation) => {
    const totals = generation.points.map((point) => point.workingSetSizeKiB);
    return {
      browserPid: generation.browserPid,
      batches: generation.points.map((point) => point.batch),
      sampleCount: generation.points.length,
      workingSetKiB: totals,
      // Only a generation with enough points gets a trend; the rest report
      // null rather than a number that would be read as one.
      workingSetSlopeKiBPerBatch:
        totals.length >= MINIMUM_TREND_POINTS ? linearSlope(totals) : null,
      processCount: generation.points.map((point) => point.processCount),
      fileDescriptorCount: generation.points.map(
        (point) => point.fileDescriptorCount,
      ),
      activeResourceCount: generation.points.map(
        (point) => point.activeResourceCount,
      ),
      windowCount: generation.points.map((point) => point.windowCount),
      webContentsCount: generation.points.map(
        (point) => point.webContentsCount,
      ),
      taskViewCount: generation.points.map((point) => point.taskViewCount),
    };
  });

  // The same phase of two generations is the honest comparison: both points
  // are the Nth sample after a restart, so anything a restart resets has
  // already been reset in both.  Drift here is what the product carried over
  // a whole restart cycle, which is the number the budget was meant to catch.
  const previous = described.at(-2);
  const latest = described.at(-1);
  let samePhase = null;
  if (previous && latest && latest.sampleCount >= 2) {
    const width = Math.min(previous.sampleCount, latest.sampleCount);
    const perPoint = Array.from(
      { length: width },
      (_, index) => latest.workingSetKiB[index] - previous.workingSetKiB[index],
    );
    const mean =
      perPoint.reduce((total, value) => total + value, 0) / perPoint.length;
    const previousPoints = generations.at(-2).points;
    const latestPoints = generations.at(-1).points;
    const byProcess = {};
    for (let index = 0; index < width; index += 1) {
      for (const metric of latestPoints[index].processMetrics ?? []) {
        const key = processKey(metric);
        const before = (previousPoints[index].processMetrics ?? []).find(
          (candidate) => processKey(candidate) === key,
        );
        if (!before) continue;
        (byProcess[key] ??= []).push(
          metric.workingSetSizeKiB - before.workingSetSizeKiB,
        );
      }
    }
    samePhase = {
      comparedPoints: width,
      previousBrowserPid: previous.browserPid,
      latestBrowserPid: latest.browserPid,
      workingSetDeltaKiB: perPoint,
      meanWorkingSetDeltaKiB: mean,
      meanPerBatchKiB: mean / Math.max(previous.sampleCount, 1),
      perProcessDeltaKiB: Object.fromEntries(
        Object.entries(byProcess).map(([key, deltas]) => [
          key,
          {
            deltas,
            mean:
              deltas.reduce((total, value) => total + value, 0) / deltas.length,
          },
        ]),
      ),
    };
  }

  const trended = described.filter(
    (generation) => generation.workingSetSlopeKiBPerBatch !== null,
  );
  const longest = trended.reduce(
    (best, generation) =>
      best === null || generation.sampleCount > best.sampleCount
        ? generation
        : best,
    null,
  );

  return {
    schema: 1,
    note: "Additional reading of the same samples. Changes no budget or verdict.",
    restartsInsideMeasuredWindow: recoveryEvents.filter(
      (event) => event.kind === "application-restart",
    ).length,
    recoveryEvents,
    generationCount: described.length,
    minimumTrendPoints: MINIMUM_TREND_POINTS,
    generations: described,
    // The headline pair, so a reader does not have to recompute them.
    longestGenerationSlopeKiBPerBatch:
      longest?.workingSetSlopeKiBPerBatch ?? null,
    longestGenerationSampleCount: longest?.sampleCount ?? null,
    samePhaseAcrossRestart: samePhase,
  };
}
