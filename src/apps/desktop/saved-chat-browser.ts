import { setTimeout as delay } from "node:timers/promises";

import type { SavedChatBrowser } from "../../modules/chat/app/service/persistent-chatgpt-handoff";
import type { ChatGptRoute, ChatGptRouteOptions } from "./chatgpt-route";
import { canonicalChatGptConversationUrl } from "./chatgpt-page-policy";

type SavedChatRoute = Pick<
  ChatGptRoute,
  | "open"
  | "observe"
  | "savedChatReady"
  | "savedChatInsert"
  | "savedChatSubmit"
  | "savedChatProof"
  | "savedChatLoad"
  | "currentSavedChatUrl"
  | "dispose"
>;

export type SavedChatRouteFactory = (
  options: ChatGptRouteOptions,
) => SavedChatRoute;

/** Hidden, dedicated Next-partition browser route; never uses the V0 profile. */
export class NextSavedChatBrowser implements SavedChatBrowser {
  private sender: SavedChatRoute | null = null;

  constructor(
    private readonly homeUrl: string,
    private readonly e2eOrigin: string | null,
    private readonly createRoute: SavedChatRouteFactory,
    private readonly routeIdentity: Readonly<{
      partition: NonNullable<ChatGptRouteOptions["partition"]>;
      requiredAppName?: string;
    }>,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = (ms) => delay(ms),
    private readonly maySubmit: () => boolean = () => false,
  ) {}

  private route(): SavedChatRoute {
    return this.createRoute({
      homeUrl: this.homeUrl,
      initialUrl: this.homeUrl,
      e2eOrigin: this.e2eOrigin,
      ...this.routeIdentity,
      parent: () => null,
      windowPresentation: { mode: "hidden" },
      title: "Farol · Saved ChatGPT handoff",
    });
  }

  async prepare(): Promise<
    "ready" | "sign_in_required" | "not_normal_empty" | "unavailable"
  > {
    if (this.sender !== null) return "unavailable";
    const candidate = this.route();
    this.sender = candidate;
    try {
      if ((await candidate.open()).status !== "opened")
        return this.closeAs("unavailable");
      const observed = await candidate.observe();
      if (observed.state === "signed_out")
        return this.closeAs("sign_in_required");
      if (observed.state !== "authenticated")
        return this.closeAs("unavailable");
      const ready: unknown = await candidate.savedChatReady(this.homeUrl);
      if (
        !ready ||
        typeof ready !== "object" ||
        !("ready" in ready) ||
        ready.ready !== true
      )
        return this.closeAs("not_normal_empty");
      return "ready";
    } catch {
      return this.closeAs("unavailable");
    }
  }

  async closePrepared(): Promise<void> {
    const sender = this.sender;
    this.sender = null;
    sender?.dispose();
  }

  async sendOnce(
    message: string,
    expectedDigest: string,
    stillConnected: () => boolean = () => true,
  ): ReturnType<SavedChatBrowser["sendOnce"]> {
    const sender = this.sender;
    if (sender === null)
      return { status: "not_sent", code: "SAVED_CHAT_SURFACE_MISSING" };
    try {
      const inserted: unknown = await sender.savedChatInsert(
        this.homeUrl,
        message,
      );
      if (
        !inserted ||
        typeof inserted !== "object" ||
        !("inserted" in inserted) ||
        inserted.inserted !== true
      )
        return { status: "not_sent", code: "SAVED_CHAT_INSERT_UNVERIFIED" };
      if (!stillConnected() || !this.maySubmit())
        return { status: "not_sent", code: "SAVED_CHAT_ADMISSION_REVOKED" };
      // One submit call only. An unknown script response never triggers a retry.
      const submitted: unknown = await sender.savedChatSubmit(
        this.homeUrl,
        expectedDigest,
      );
      if (
        !submitted ||
        typeof submitted !== "object" ||
        !("clicked" in submitted) ||
        submitted.clicked !== true
      )
        return { status: "outcome_unknown" };
      const deadline = this.now() + 30_000;
      while (this.now() < deadline) {
        const candidate = sender.currentSavedChatUrl();
        if (candidate !== null) {
          const proof: unknown = await sender.savedChatProof(
            candidate,
            expectedDigest,
            "",
            false,
          );
          if (
            proof &&
            typeof proof === "object" &&
            "verified" in proof &&
            proof.verified === true
          )
            return { status: "candidate", conversationUrl: candidate };
        }
        await this.wait(250);
      }
      return { status: "outcome_unknown" };
    } catch {
      return { status: "outcome_unknown" };
    } finally {
      await this.closePrepared();
    }
  }

  async reopen(
    conversationUrl: string,
    firstMessageDigest: string,
    requestedTitleDigest: string,
  ): ReturnType<SavedChatBrowser["reopen"]> {
    if (
      this.sender !== null ||
      canonicalChatGptConversationUrl(conversationUrl, this.e2eOrigin) !==
        conversationUrl
    )
      return { status: "unverified" };
    const reader = this.route();
    try {
      // The sending route has exited. This new hidden helper first loads Home,
      // then navigates and reloads the one recorded private URL.
      if ((await reader.open()).status !== "opened")
        return { status: "unverified" };
      if (!(await reader.savedChatLoad(conversationUrl)))
        return { status: "unverified" };
      if (!(await reader.savedChatLoad(conversationUrl)))
        return { status: "unverified" };
      const observed = await reader.observe();
      if (observed.state !== "authenticated") return { status: "unverified" };
      const proof: unknown = await reader.savedChatProof(
        conversationUrl,
        firstMessageDigest,
        requestedTitleDigest,
        true,
      );
      if (
        !proof ||
        typeof proof !== "object" ||
        !("verified" in proof) ||
        proof.verified !== true ||
        !("titleVerified" in proof) ||
        typeof proof.titleVerified !== "boolean"
      )
        return { status: "unverified" };
      return { status: "verified", titleVerified: proof.titleVerified };
    } catch {
      return { status: "unverified" };
    } finally {
      reader.dispose();
    }
  }

  private async closeAs<
    T extends "unavailable" | "sign_in_required" | "not_normal_empty",
  >(status: T): Promise<T> {
    await this.closePrepared();
    return status;
  }
}
