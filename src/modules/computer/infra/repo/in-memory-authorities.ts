import type {
  AuthorityAdmission,
  AuthorityRepository,
} from "../../app/port/authority-repository";
import type { ParticipantAuthority } from "../../domain/execution-authority";

export class InMemoryAuthorityRepository implements AuthorityRepository {
  private readonly authorities = new Map<string, ParticipantAuthority>();

  constructor(initial: readonly ParticipantAuthority[] = []) {
    for (const authority of initial) {
      this.authorities.set(authority.participantId, structuredClone(authority));
    }
  }

  async get(participantId: string): Promise<ParticipantAuthority | null> {
    const authority = this.authorities.get(participantId);
    return authority ? structuredClone(authority) : null;
  }

  async admit(authority: ParticipantAuthority): Promise<AuthorityAdmission> {
    const existing = this.authorities.get(authority.participantId);
    if (existing) {
      return { status: "existing", authority: structuredClone(existing) };
    }
    const stored = structuredClone(authority);
    this.authorities.set(authority.participantId, stored);
    return { status: "admitted", authority: structuredClone(stored) };
  }
}
