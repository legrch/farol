import type { ParticipantAuthority } from "../../domain/execution-authority";

export type AuthorityAdmission =
  | Readonly<{ status: "admitted"; authority: ParticipantAuthority }>
  | Readonly<{ status: "existing"; authority: ParticipantAuthority }>;

export interface AuthorityRepository {
  get(participantId: string): Promise<ParticipantAuthority | null>;
  admit(authority: ParticipantAuthority): Promise<AuthorityAdmission>;
}
