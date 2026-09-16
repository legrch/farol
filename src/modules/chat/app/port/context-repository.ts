import type {
  ContextBinding,
  ContextSession,
} from "../../domain/context-continuity";

export interface ContextRepository {
  load(binding: ContextBinding): Promise<ContextSession | null>;
  save(session: ContextSession): Promise<void>;
}
