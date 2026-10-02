/*!
 * Vatio JS SDK — talk to a Vatio agent from a public page.
 *
 *   npm install @vatio-ai/sdk
 *   import { Vatio } from "@vatio-ai/sdk";
 *
 * It is an ES module with no dependencies and no build assumptions, so a page
 * with no bundler can reach the same thing through an npm CDN:
 *
 *   <script type="module">
 *     import { Vatio } from "https://cdn.jsdelivr.net/npm/@vatio-ai/sdk/+esm";
 *   </script>
 *
 * Loading it also sets window.Vatio, for code that would rather reach for a
 * global once the module has run.
 *
 *   const chat = await Vatio.chat({ workspace: "acme", token: "vatpub_..." });
 *   chat.on("message", (m) => render(m));
 *   chat.on("typing", (isTyping) => showDots(isTyping));
 *   await chat.send("hola");
 *
 * A reply arrives whole, as one message, because that is what a web reader
 * expects -- see `replyStyle` on Vatio.chat for the channels where it doesn't,
 * and for how to ask for the bubble-split, human-paced shape instead.
 *
 * The token is a publishable token. It is *meant* to be in your page source:
 * it can start a conversation on one workspace and nothing else, only from an
 * origin you listed in vatio.yml's `allowed_origins:`. Creating a chat returns a
 * credential scoped to that one conversation, which this SDK stores and uses
 * for everything after — you never handle it.
 *
 * Why an SDK rather than a documented socket: the transport is deliberately
 * not part of Vatio's public contract. This file is. That keeps the wire
 * format free to change, and it absorbs the one ordering rule that used to be
 * the caller's problem — a reply can be missed if you post before your
 * subscription is live, so `Vatio.chat()` does not resolve until the
 * subscription is confirmed, and `send()` waits for it.
 *
 * Versioned by npm semver, and by nothing else. It used to ship from
 * cdn.vatio.ai/v1/sdk.js, where the /v1/ was the contract's version because a
 * URL a stranger's page already loads cannot change behaviour under them. A
 * version range in a package.json says the same thing and says it better:
 * nobody is served a new major by surprise, and a breaking change is a major
 * release instead of a second directory maintained forever. widget.js bundles
 * this rather than fetching it, so there is no longer a second copy of the
 * question.
 *
 * Two audiences, two credentials. `Vatio.chat()` and friends are what a
 * *visitor's* browser may do, on a publishable token that is meant to be
 * public. `Vatio.inbox()` is the other side of the same conversations -- read
 * and reply across the whole workspace -- for a developer building their own
 * supervisor UI, and it takes a credential Vatio issued rather than one they
 * signed. See `Vatio.inbox` for which credential goes where; the short
 * version is that the workspace secret stays on a server and the browser gets
 * something scoped to one person that expires.
 */

import {
  DEFAULT_BASE_URL,
  Emitter,
  RECONNECT_DELAYS,
  VatioError,
  errorFrom,
  feedbackFrom,
  type CableEvent,
  type FeedbackRating,
  type VatioFeedback,
  type VatioSendResult,
  type WireFeedback,
  type CableFrame,
  type RailsListEnvelope,
  type VatioMessage
} from "./internal";

export { VatioError } from "./internal";
export type {
  ChatStatus,
  FeedbackRating,
  VatioAttachment,
  VatioMessageUpdate,
  VatioSendResult,
  VatioErrorOptions,
  VatioFeedback,
  VatioEventName,
  VatioMessage
} from "./internal";

const VERSION = "3.3.0";

// Checked here too, so a file the server would refuse is refused before it
// is uploaded. The server stays the authority on the type: it reads the bytes.
const MAX_FILES = 4;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CHANNEL = "VisitorChatChannel";

interface StoredChat {
  chat_id: string;
  chat_token: string;
  visitor_ref?: string | null;
  environment?: string;
  expires_at?: string;
}

interface ChatOptions {
  baseUrl: string;
  workspace: string;
  chatId: string;
  chatToken: string;
  visitorRef?: string | null;
  environment?: string;
}


// Used only when a socket can't be established at all (a proxy that eats
// WebSocket upgrades, say). Polling is the fallback, never the default.
const POLL_INTERVAL = 1500;
const POLL_IDLE_TIMEOUT = 45000;

// `scope` separates two Vatio surfaces that share an origin but must not
// share a conversation -- the live hosted page and the preview screen both sit
// on vatio.ai, and resuming one from the other would show a developer their
// customers' conversation instead of their own test.
function storageKey(baseUrl: string, workspace: string, scope: string | null | undefined, name: string): string {
  return `vatio:${baseUrl}:${workspace}:${scope || "default"}:${name}`;
}

// The same separation, for the same reason, between people. A shared laptop
// signs out Ana and signs in Beto, and the stored conversation and visitor id
// must not carry over: Beto would resume Ana's chat, and become Ana's contact
// in the CRM. So identity is part of the storage scope.
//
// Gaining one is the exception, and the only one: a visitor who was anonymous
// and has now signed in keeps the conversation they were already having --
// see the adoption in chat(). That is a person arriving with a name, not a
// different person arriving. Ana to Beto is still a fresh start, and the
// server enforces it rather than trusting this file to.
//
// The subject, not the token. The key has to answer "same person as last
// time?", and the token answers a stricter question nobody asked: a backend
// signs a fresh one on every render, so keying on the token itself made a
// plain page reload look like a different visitor and started a new
// conversation every time.
//
// Read out of the payload without verifying it, which is safe because this is
// a cache key and nothing else. Every decision that matters -- whether the
// chat may be identified, what a protected tool sees -- is made by the server
// against the signature. The worst a forged `sub` does here is point at a
// conversation in this browser's own storage.
function subjectOf(visitorToken: string | null | undefined): string | null {
  if (!visitorToken) return null;
  const payload = String(visitorToken).split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = JSON.parse(json).sub;
    return sub == null ? null : String(sub);
  } catch {
    return null;
  }
}

function identityScope(scope: string | null | undefined, visitorToken: string | null | undefined): string | null | undefined {
  const subject = subjectOf(visitorToken);
  if (!subject) return scope;

  return `${scope || "default"}#${subject}`;
}

// Hands an existing conversation the token the page is holding now. True when
// it may carry on — newly identified, refreshed, or already current. False
// only when the server says this chat belongs to a different person, which is
// the shared-laptop case and has to start over.
//
// A network failure answers true: the conversation is still the visitor's, and
// throwing away what they typed because one request did not land would be a
// worse answer than carrying on with whatever the chat already knows.
async function identifyChat(
  baseUrl: string,
  workspace: string,
  stored: StoredChat,
  visitorToken: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${baseUrl}/api/visitor/v1/${encodeURIComponent(workspace)}/chats/${encodeURIComponent(stored.chat_id)}/identify`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${stored.chat_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ visitor_token: visitorToken })
      }
    );
    if (!response.ok) return response.status !== 401;

    const body = await response.json();
    return body.reason !== "identity_changed";
  } catch {
    return true;
  }
}

// sessionStorage for the conversation (one tab, one conversation) and
// localStorage for the visitor id (so a returning visitor is the same contact
// tomorrow). Both wrapped: a browser in private mode throws on access rather
// than returning null, and losing persistence is not worth losing the chat.
function readStore(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeStore(store: Storage, key: string, value: string | null): void {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch (_) {
    /* private mode, quota, or a blocked third-party context */
  }
}

class Chat extends Emitter {
  baseUrl: string;
  workspace: string;
  chatId: string;
  chatToken: string;
  visitorRef?: string | null;
  environment?: string;

  private socket: WebSocket | null = null;
  private identifier: string | null = null;
  private subscribed = false;
  private closed = false;
  private attempt = 0;
  private lastMessageId = 0;
  private polling: ReturnType<typeof setInterval> | null = null;
  private pollingUntil = 0;
  private pendingSubscription: Promise<void> | null = null;
  private currentFeedback: VatioFeedback | null = null;

  constructor({ baseUrl, workspace, chatId, chatToken, visitorRef, environment }: ChatOptions) {
    super();
    this.baseUrl = baseUrl;
    this.workspace = workspace;
    this.chatId = chatId;
    this.chatToken = chatToken;
    this.visitorRef = visitorRef;
    this.environment = environment;
  }

  get url(): string {
    return `${this.baseUrl}/api/visitor/v1/${encodeURIComponent(this.workspace)}`;
  }

  // --- public surface ------------------------------------------------------

  /**
   * Send the visitor's message. `files` attaches up to four images (JPEG,
   * PNG, WebP, GIF, HEIC), PDFs, text files or audio clips (M4A, MP3, OGG,
   * WAV, AAC, FLAC) of up to 8 MB each; with files, `text` may be empty. A
   * voice note is transcribed in the background: the stored message comes
   * back labelled "Audio", and its transcript arrives as an `update` event.
   *
   * Recording in a browser: Chrome's MediaRecorder defaults to WebM, which is
   * not accepted -- ask for `audio/mp4` (or `audio/ogg`) explicitly.
   */
  async send(text: string, { files = [] }: { files?: Array<Blob | File> } = {}): Promise<VatioSendResult> {
    const content = String(text == null ? "" : text).trim();
    const list = Array.from(files || []);
    if (!content && !list.length) throw new VatioError("content or files are required", { code: "blank_content" });
    if (list.length > MAX_FILES) {
      throw new VatioError(`at most ${MAX_FILES} files per message`, { code: "too_many_files" });
    }
    const tooLarge = list.find((file) => file.size > MAX_FILE_BYTES);
    if (tooLarge) throw new VatioError("files are limited to 8 MB each", { code: "file_too_large" });
    if (this.closed) throw new VatioError("chat is closed", { code: "chat_closed" });

    // The ordering rule, handled once, here: a reply published before the
    // subscription is live is a reply nobody hears. Waiting costs nothing when
    // the socket is already up, which is the normal case.
    await this.ready();

    const response = await fetch(`${this.url}/chats/${this.chatId}/messages`, {
      method: "POST",
      // No Content-Type with files: the browser writes the multipart
      // boundary itself.
      headers: list.length
        ? { Authorization: `Bearer ${this.chatToken}` }
        : { Authorization: `Bearer ${this.chatToken}`, "Content-Type": "application/json" },
      body: list.length ? formData(content, list) : JSON.stringify({ content })
    });

    if (!response.ok) throw await errorFrom(response);

    // Writing again moves the conversation on, and an unanswered moment with
    // it: the server stops offering it, so stop showing it.
    if (this.currentFeedback && !this.currentFeedback.rating) this.setFeedback(null);

    // If we ended up on the polling fallback, a message just went out and a
    // reply is coming: poll attentively for a while, then go quiet again.
    if (!this.subscribed) this.pollFor(POLL_IDLE_TIMEOUT);

    return response.json();
  }

  async history({ limit }: { limit?: number } = {}): Promise<VatioMessage[]> {
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    const response = await fetch(`${this.url}/chats/${this.chatId}/messages${query}`, {
      headers: { Authorization: `Bearer ${this.chatToken}` }
    });
    if (!response.ok) throw await errorFrom(response);

    const body: RailsListEnvelope<VatioMessage> = await response.json();
    const messages = body.data || [];
    messages.forEach((message) => {
      if (message.id > this.lastMessageId) this.lastMessageId = message.id;
    });
    return messages;
  }

  /**
   * The feedback moment Vatio is offering on this conversation, or null. The
   * `feedback` event delivers the same thing as it happens; this is for a
   * client that wants to ask.
   */
  async feedback(): Promise<VatioFeedback | null> {
    const response = await fetch(`${this.url}/chats/${this.chatId}/feedback`, {
      headers: { Authorization: `Bearer ${this.chatToken}` }
    });
    if (!response.ok) throw await errorFrom(response);

    const body: { feedback?: WireFeedback | null } = await response.json();
    return feedbackFrom(body.feedback);
  }

  /**
   * Answer the feedback moment. `comment` (up to 2,000 characters) is meant
   * for "neutral" and "bad". Rejects with code "feedback_unavailable" once the
   * moment has passed.
   */
  async rate(rating: FeedbackRating, { comment }: { comment?: string } = {}): Promise<VatioFeedback | null> {
    return this.answerFeedback(comment === undefined ? { rating } : { rating, comment });
  }

  /** Decline the feedback moment; it is not offered again. */
  async dismissFeedback(): Promise<VatioFeedback | null> {
    return this.answerFeedback({ dismiss: true });
  }

  ready(): Promise<void> {
    if (this.subscribed || this.polling) return Promise.resolve();
    if (this.pendingSubscription) return this.pendingSubscription;
    return this.connect();
  }

  close(): void {
    this.closed = true;
    this.stopPolling();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.subscribed = false;
      try {
        if (socket.readyState === 1 && this.identifier) {
          socket.send(JSON.stringify({ command: "unsubscribe", identifier: this.identifier }));
        }
        socket.close();
      } catch (_) {
        /* already gone */
      }
    }
    this.emit("status", "closed");
  }

  // --- transport ----------------------------------------------------------

  connect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (typeof WebSocket === "undefined") {
      this.startPolling();
      return Promise.resolve();
    }

    this.pendingSubscription = new Promise<void>((resolve) => {
      const settle = () => {
        this.pendingSubscription = null;
        resolve();
      };

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.cableUrl(), ["actioncable-v1-json", "actioncable-unsupported"]);
      } catch (_) {
        this.startPolling();
        settle();
        return;
      }

      this.socket = socket;
      this.identifier = JSON.stringify({ channel: CHANNEL, chat_token: this.chatToken });

      socket.onmessage = (event: MessageEvent) => {
        let frame: CableFrame;
        try {
          frame = JSON.parse(event.data);
        } catch (_) {
          return;
        }

        if (frame.type === "welcome") {
          socket.send(JSON.stringify({ command: "subscribe", identifier: this.identifier }));
          return;
        }
        if (frame.type === "confirm_subscription") {
          this.attempt = 0;
          this.subscribed = true;
          this.stopPolling();
          this.emit("status", "connected");
          settle();
          // A moment offered while nobody was listening -- a resumed
          // conversation, or one that reconnected -- arrives this way.
          this.refreshFeedback();
          return;
        }
        if (frame.type === "reject_subscription") {
          // The credential expired or was revoked. Polling would fail the same
          // way, so say so instead of retrying forever.
          this.emit("error", new VatioError("subscription rejected — the chat credential is no longer valid", {
            code: "subscription_rejected"
          }));
          this.closed = true;
          settle();
          return;
        }
        if (frame.type === "ping" || frame.type === "disconnect") return;
        if (frame.message) this.handleEvent(frame.message);
      };

      socket.onclose = () => {
        const wasSubscribed = this.subscribed;
        this.subscribed = false;
        this.socket = null;
        if (this.closed) return settle();

        this.emit("status", "reconnecting");
        // Cover the gap with polling so a reply that lands mid-reconnect is
        // not lost, and resync history once we are back.
        this.pollFor(POLL_IDLE_TIMEOUT);
        const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
        this.attempt += 1;
        setTimeout(() => {
          if (this.closed) return;
          this.connect().then(() => {
            if (wasSubscribed) this.resync();
          });
        }, delay);
        settle();
      };

      socket.onerror = () => {
        // onclose always follows, which is where reconnection is handled.
      };
    });

    return this.pendingSubscription;
  }

  private cableUrl(): string {
    const url = new URL("/cable", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private handleEvent(event: CableEvent): void {
    if (!event || !event.type) return;

    if (event.type === "typing_start") return this.emit("typing", true);
    if (event.type === "typing_stop") return this.emit("typing", false);
    if (event.type === "feedback") return this.setFeedback(feedbackFrom(event.feedback));
    if (event.type === "message_updated" && event.message) {
      const { id, content, content_is_media_label } = event.message;
      return this.emit("update", { id, content: content || "", content_is_media_label: Boolean(content_is_media_label) });
    }
    if (event.type === "message" && event.message) {
      const message = event.message;
      // The socket is a convenience layer, not the source of truth: a reply
      // can arrive twice (a reconnect that resyncs history over an event we
      // already got). Dedupe on id so a caller never renders a bubble twice.
      if (message.id && message.id <= this.lastMessageId) return;
      if (message.id) this.lastMessageId = message.id;
      return this.emit("message", message);
    }
  }

  // --- feedback -----------------------------------------------------------

  private async answerFeedback(body: Record<string, unknown>): Promise<VatioFeedback | null> {
    const response = await fetch(`${this.url}/chats/${this.chatId}/feedback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.chatToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw await errorFrom(response);

    const answer: { feedback?: WireFeedback | null } = await response.json();
    const feedback = feedbackFrom(answer.feedback);
    this.setFeedback(feedback);
    return feedback;
  }

  private async refreshFeedback(): Promise<void> {
    try {
      this.setFeedback(await this.feedback());
    } catch (_) {
      /* feedback never interrupts the chat */
    }
  }

  // Emits only on a change, so a reconnect that finds the same moment does
  // not ask the visitor twice.
  private setFeedback(feedback: VatioFeedback | null): void {
    const key = (f: VatioFeedback | null) => (f ? `${f.messageId}:${f.rating}:${f.dismissed}` : "");
    if (key(feedback) === key(this.currentFeedback)) return;
    this.currentFeedback = feedback;
    this.emit("feedback", feedback);
  }

  // --- fallbacks ----------------------------------------------------------

  private async resync(): Promise<void> {
    try {
      const response = await fetch(
        `${this.url}/chats/${this.chatId}/messages?after=${encodeURIComponent(this.lastMessageId)}`,
        { headers: { Authorization: `Bearer ${this.chatToken}` } }
      );
      if (!response.ok) return;

      const body: RailsListEnvelope<VatioMessage> = await response.json();
      (body.data || []).forEach((message) => {
        if (message.id <= this.lastMessageId) return;
        this.lastMessageId = message.id;
        if (message.role !== "user") this.emit("message", message);
      });
    } catch (_) {
      /* offline; the next reconnect will try again */
    }
  }

  private pollFor(duration: number): void {
    this.pollingUntil = Date.now() + duration;
    this.startPolling();
  }

  private startPolling(): void {
    if (this.polling || this.closed) return;
    this.emit("status", "polling");
    this.polling = setInterval(() => {
      if (this.closed || this.subscribed || Date.now() > this.pollingUntil) return this.stopPolling();
      this.resync();
    }, POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (!this.polling) return;
    clearInterval(this.polling);
    this.polling = null;
  }
}

export interface VatioConfig {
  [key: string]: unknown;
}

export interface VatioConversation {
  chatId: string;
  chatToken: string;
  expiresAt?: string;
  environment?: string;
  title: string;
  preview: string;
  startedAt?: string;
  updatedAt?: string;
}

export type ReplyStyle = "stream" | "paced" | "instant";

export interface VatioChatOptions {
  workspace: string;
  token: string;
  baseUrl?: string;
  fresh?: boolean;
  replyStyle?: ReplyStyle;
  scope?: string | null;
  visitorToken?: string | null;
  conversation?: VatioConversation | StoredChat | null;
}

export const Vatio = {
  VERSION,

  /**
   * Fetch the agent's public branding — name, avatar, accent colour — without
   * starting a conversation. What a bubble needs to render before anyone
   * clicks it. Rejects with code "no_agent_deployed" when the environment has
   * nothing deployed, which is the signal to render no bubble at all.
   */
  async config({ workspace, token, baseUrl = DEFAULT_BASE_URL }: { workspace: string; token: string; baseUrl?: string }): Promise<VatioConfig> {
    requireOptions({ workspace, token });
    const response = await fetch(`${baseUrl}/api/visitor/v1/${encodeURIComponent(workspace)}/config`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw await errorFrom(response);
    return response.json();
  },

  /**
   * Start (or resume) a conversation. Resolves once the subscription is live,
   * so the first send() cannot race its reply.
   *
   * Pass `fresh: true` to abandon a stored conversation and start a new one.
   *
   * `replyStyle` decides the shape a reply arrives in, which is a question
   * about the reader, not about the agent:
   *
   *   "stream"  (default) one whole answer, no splitting and no artificial
   *             delay, sent the moment it is ready. What a web page wants:
   *             people arrive there having learned chat from ChatGPT, and a
   *             reply chopped into three texts reads as artificial. Render it
   *             progressively and you get the experience they expect.
   *   "paced"   two or three short bubbles, with a typing event and a
   *             human-sized pause before each. What WhatsApp and Instagram
   *             use, because those are places where people text people. Worth
   *             asking for on the web only if that is the illusion you want.
   *   "instant" one whole answer and no typing events at all, for a client
   *             that is a program rather than a reader.
   *
   * It is fixed when the conversation starts, so changing it only affects the
   * next new chat -- pass `fresh: true` to make that happen now.
   *
   * `visitorToken` says who this is. Pass it when your own app already knows:
   * a string your backend signed for the signed-in user. Vatio verifies it
   * against a public key the workspace published, and an unsigned user id is a
   * user id anyone can type, so sign it.
   *
   * A different token (or none) is a different person, so it gets its own
   * conversation, its own visitor id, and its own history. Signing out really
   * does sign out.
   *
   * Pass `conversation` (one of the entries `conversations()` returned) to
   * reopen an older one instead. It becomes the stored conversation, so the
   * page resumes into it from then on -- reopening is a choice the visitor
   * made, not a detour.
   */
  async chat({
    workspace,
    token,
    baseUrl = DEFAULT_BASE_URL,
    fresh = false,
    replyStyle = "stream",
    scope = null,
    visitorToken = null,
    conversation = null
  }: VatioChatOptions): Promise<Chat> {
    requireOptions({ workspace, token });

    const session = typeof sessionStorage !== "undefined" ? sessionStorage : null;
    const local = typeof localStorage !== "undefined" ? localStorage : null;
    const identity = identityScope(scope, visitorToken);
    const chatKey = storageKey(baseUrl, workspace, identity, "chat");
    const refKey = storageKey(baseUrl, workspace, identity, "visitor");

    if (conversation) {
      const reopened = adopt(conversation, local && readStore(local, refKey));
      if (session) writeStore(session, chatKey, JSON.stringify(reopened));
      const chat = new Chat({
        baseUrl,
        workspace,
        chatId: reopened.chat_id,
        chatToken: reopened.chat_token,
        visitorRef: reopened.visitor_ref,
        environment: reopened.environment
      });
      await chat.connect();
      return chat;
    }

    // The visitor asked something, was told to sign in, did, and came back.
    // Their conversation is filed under the anonymous key, and gaining a name
    // is not a reason to lose it — so an identified boot with nothing of its
    // own adopts it. The server has the last word: it refuses if the chat
    // already belongs to somebody else, and then this falls through to a new
    // conversation like any first visit.
    const anonymousKey = storageKey(baseUrl, workspace, scope, "chat");
    let stored = fresh ? null : readStoredChat(session, chatKey);
    if (!stored && !fresh && identity !== scope) {
      stored = readStoredChat(session, anonymousKey);
    }

    let chat: Chat;
    if (stored) {
      if (visitorToken && !(await identifyChat(baseUrl, workspace, stored, visitorToken))) {
        if (session) writeStore(session, anonymousKey, null);
        stored = null;
      }
    }

    if (stored) {
      chat = new Chat({
        baseUrl,
        workspace,
        chatId: stored.chat_id,
        chatToken: stored.chat_token,
        visitorRef: stored.visitor_ref,
        environment: stored.environment
      });
      // Re-filed under whoever it now belongs to, so the next reload finds it
      // straight away and the anonymous key stops pointing at a conversation
      // that has a name.
      if (session && identity !== scope) {
        writeStore(session, chatKey, JSON.stringify(stored));
        writeStore(session, anonymousKey, null);
      }
    } else {
      const response = await fetch(`${baseUrl}/api/visitor/v1/${encodeURIComponent(workspace)}/chats`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          visitor_ref: (local && readStore(local, refKey)) || undefined,
          reply_style: replyStyle,
          visitor_token: visitorToken || undefined
        })
      });
      if (!response.ok) throw await errorFrom(response);

      const body = await response.json();
      chat = new Chat({
        baseUrl,
        workspace,
        chatId: body.chat_id,
        chatToken: body.chat_token,
        visitorRef: body.visitor_ref,
        environment: body.environment
      });

      if (local) writeStore(local, refKey, body.visitor_ref);
      if (session) {
        writeStore(session, chatKey, JSON.stringify({
          chat_id: body.chat_id,
          chat_token: body.chat_token,
          visitor_ref: body.visitor_ref,
          environment: body.environment,
          expires_at: body.chat_token_expires_at
        }));
      }
    }

    await chat.connect();
    return chat;
  },

  /**
   * Whether there is a conversation to resume — a stored credential that has
   * not expired — without starting one if there isn't.
   *
   * For a client that fills the page rather than hiding behind a launcher:
   * a returning visitor should see their history the moment it loads, and a
   * first-time visitor (or a crawler) should not become a contact for having
   * opened a URL. Ask this, and call `chat()` on the first message instead.
   */
  resumable({ workspace, baseUrl = DEFAULT_BASE_URL, scope = null, visitorToken = null }: { workspace: string; baseUrl?: string; scope?: string | null; visitorToken?: string | null }): boolean {
    const session = typeof sessionStorage !== "undefined" ? sessionStorage : null;
    const identity = identityScope(scope, visitorToken);
    return readStoredChat(session, storageKey(baseUrl, workspace, identity, "chat")) !== null;
  },

  /**
   * Every conversation this visitor has had on this workspace, newest first —
   * what a client needs to offer them more than the one they are in.
   *
   * Resolves to `[]` for a visitor who has never talked here, so a first-time
   * page can call it without a branch. Each entry carries its own credential
   * and is what you hand back to `chat({ conversation })` to reopen it:
   *
   *   { chatId, chatToken, expiresAt, environment, title, preview,
   *     startedAt, updatedAt }
   *
   * `title` is what the visitor opened with and `preview` is the last thing
   * said, which is how a person recognises a conversation they had. The
   * transcript is not here: reading it is what the credential is for.
   *
   * Identity is the visitor id stored by the first `chat()` on this browser,
   * so this lists what *this browser* has been — the same rule that decides
   * which contact a new conversation lands on.
   *
   * Which is why `visitorToken` belongs here too, and must be the same one you
   * pass to `chat()`. The visitor id is stored per identity, so asking without
   * the token reads the anonymous one: a signed-in visitor would be shown an
   * empty list, or — on a shared browser — the list belonging to whoever used
   * it signed out. Pass it and this is "what this browser has been *as this
   * person*", which is the only useful reading of the question.
   */
  async conversations({
    workspace,
    token,
    baseUrl = DEFAULT_BASE_URL,
    scope = null,
    visitorToken = null
  }: { workspace: string; token: string; baseUrl?: string; scope?: string | null; visitorToken?: string | null }): Promise<VatioConversation[]> {
    requireOptions({ workspace, token });

    const local = typeof localStorage !== "undefined" ? localStorage : null;
    const identity = identityScope(scope, visitorToken);
    const visitorRef = local && readStore(local, storageKey(baseUrl, workspace, identity, "visitor"));
    if (!visitorRef) return [];

    const url =
      `${baseUrl}/api/visitor/v1/${encodeURIComponent(workspace)}/chats` +
      `?visitor_ref=${encodeURIComponent(visitorRef)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await errorFrom(response);

    const body: RailsListEnvelope<Record<string, any>> = await response.json();
    return (body.data || []).map((entry) => ({
      chatId: entry.chat_id,
      chatToken: entry.chat_token,
      expiresAt: entry.chat_token_expires_at,
      environment: entry.environment,
      title: entry.title || "",
      preview: entry.preview || "",
      startedAt: entry.started_at,
      updatedAt: entry.updated_at
    }));
  },

  /**
   * Forget the stored conversation for this workspace. Pass the same
   * `visitorToken` you passed to `chat()` -- without it you would forget a
   * different person's conversation than the one on screen.
   */
  reset({ workspace, baseUrl = DEFAULT_BASE_URL, scope = null, visitorToken = null }: { workspace: string; baseUrl?: string; scope?: string | null; visitorToken?: string | null }): void {
    if (typeof sessionStorage === "undefined") return;
    const identity = identityScope(scope, visitorToken);
    writeStore(sessionStorage, storageKey(baseUrl, workspace, identity, "chat"), null);
  },

  VatioError
};

function adopt(conversation: VatioConversation | StoredChat, visitorRef: string | null | undefined): StoredChat {
  const c = conversation as any;
  const chatId = c.chatId || c.chat_id;
  const chatToken = c.chatToken || c.chat_token;
  if (!chatId || !chatToken) {
    throw new VatioError("conversation must carry chatId and chatToken", { code: "unknown_conversation" });
  }

  return {
    chat_id: chatId,
    chat_token: chatToken,
    visitor_ref: c.visitorRef || c.visitor_ref || visitorRef || null,
    environment: c.environment,
    expires_at: c.expiresAt || c.chat_token_expires_at
  };
}

// Returns the stored conversation, or null when there is none, it is
// unreadable, or its credential has expired.
function readStoredChat(session: Storage | null, key: string): StoredChat | null {
  if (!session) return null;

  let stored: StoredChat | null;
  try {
    stored = JSON.parse(readStore(session, key) || "null");
  } catch (_) {
    return null;
  }
  if (!stored || !stored.chat_id || !stored.chat_token) return null;
  if (!(Date.parse(stored.expires_at || "0") > Date.now())) return null;

  return stored;
}

function formData(content: string, files: Array<Blob | File>): FormData {
  const form = new FormData();
  if (content) form.append("content", content);
  files.forEach((file, index) => {
    const name = (file as File).name || `attachment-${index + 1}`;
    form.append("files[]", file, name);
  });
  return form;
}

function requireOptions({ workspace, token }: { workspace: string; token: string }): void {
  if (!workspace) throw new VatioError("workspace is required");
  if (!token) throw new VatioError("token is required (a vatpub_ publishable token)");
  if (!String(token).startsWith("vatpub_")) {
    throw new VatioError(
      "token must be a publishable token (vatpub_...). A vat_ token is a developer secret and must never be in a browser.",
      { code: "wrong_token_kind" }
    );
  }
}

// The module's own side effect: after it has run, window.Vatio is the same
// object the named export gives you. Handy for a page that loads the SDK once
// and reaches for it from unrelated scripts.
declare global {
  interface Window {
    Vatio?: typeof Vatio;
  }
}
if (typeof window !== "undefined") window.Vatio = Vatio;
