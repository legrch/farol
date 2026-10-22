export function retiredJourneyReport(journey, reason) {
  if (typeof journey !== "string" || journey.trim().length === 0)
    throw new TypeError("journey must be a nonempty string");
  if (typeof reason !== "string" || reason.trim().length === 0)
    throw new TypeError("reason must be a nonempty string");
  return {
    schema: 1,
    status: "NOT_RUN",
    journey,
    reason,
    qualifying: false,
  };
}

export function reportRetiredJourney(
  journey,
  reason,
  write = process.stdout.write.bind(process.stdout),
) {
  const report = retiredJourneyReport(journey, reason);
  write(`${JSON.stringify(report)}\n`);
  return report;
}
