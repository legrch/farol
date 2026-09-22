type RevisionedConfigurationSnapshot =
  | Readonly<{ status: "ready"; settings: Readonly<{ revision: number }> }>
  | Readonly<{ status: "error" }>;

export class ConfigurationRequestOrder {
  private latest = 0;

  begin(): number {
    this.latest += 1;
    return this.latest;
  }

  isLatest(request: number): boolean {
    return request === this.latest;
  }
}

export function shouldAdoptConfigurationSnapshot(
  current: RevisionedConfigurationSnapshot,
  incoming: RevisionedConfigurationSnapshot,
): boolean {
  if (incoming.status === "error") return current.status === "error";
  if (current.status === "error") return true;
  return incoming.settings.revision >= current.settings.revision;
}
