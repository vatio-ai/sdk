// What index.ts is built out of: the error type, the event emitter, the cable
// frame shapes, and the one place an error response turns into a VatioError.
//
// It was the shared core of two entry points, back when
// "@vatio-ai/sdk/inbox" was the other one -- a supervisor client this package
// had no business shipping to a page that only embeds the chat widget. That
// entry is gone (3.0.0) and the inbox owns its own client now, so this is
// simply index.ts's private half.
//
// Not a public module: nothing here is exported from the package. What is
// public is re-exported by name from index.ts.

// Long enough to ride out a tab that was backgrounded and throttled, short
// enough that a visitor who lost their wifi for a moment doesn't sit looking
// at a dead box.
export const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000];

export type VatioEventName = "message" | "typing" | "status" | "error" | "feedback" | "update";
const EVENTS: VatioEventName[] = ["message", "typing", "status", "error", "feedback", "update"];

export type ChatStatus = "connected" | "reconnecting" | "polling" | "closed";

// The shape the API actually sends is a Rails serializer this file has no
// visibility into beyond the fields it reads (id, role) -- everything else
// passes through untouched, so callers get whatever the API adds without this
// type having to track it.
export interface VatioMessage {
  id: number;
  role: string;
  content?: string;
  // The visitor's own files. When the visitor sent only a file, `content` is
  // a stand-in ("Image") and `content_is_media_label` is true: draw the file,
  // not the word.
  attachments?: VatioAttachment[];
  [key: string]: unknown;
}

// A file on a message, as history and send() return it. `url` is absolute
// and signed; it does not need the chat credential to load.
export interface VatioAttachment {
  id: number;
  filename: string;
  content_type: string;
  byte_size: number;
  kind: "image" | "audio" | "video" | "file";
  url: string | null;
}

// A message that changed after it was sent -- a voice note whose transcript
// is in. Merge it into the message with that id.
export interface VatioMessageUpdate {
  id: number;
  content: string;
  content_is_media_label: boolean;
}

// What send() resolves to: the stored message, with its transcript (for a
// voice note) and where each file now lives.
export interface VatioSendResult {
  user_message_id: number;
  message?: VatioMessage;
}

export type FeedbackRating = "good" | "neutral" | "bad";

// A moment to ask the visitor how it went, offered by Vatio once per
// conversation when a request looks resolved. `rating` and `submittedAt` are
// set once they answered.
export interface VatioFeedback {
  agentName: string;
  messageId: number;
  rating: FeedbackRating | null;
  submittedAt: string | null;
  dismissed: boolean;
}

export interface WireFeedback {
  agent_name: string;
  message_id: number;
  rating: FeedbackRating | null;
  submitted_at: string | null;
  dismissed: boolean;
}

export function feedbackFrom(wire: WireFeedback | null | undefined): VatioFeedback | null {
  if (!wire) return null;
  return {
    agentName: wire.agent_name,
    messageId: wire.message_id,
    rating: wire.rating,
    submittedAt: wire.submitted_at,
    dismissed: wire.dismissed
  };
}

export interface VatioErrorOptions {
  code?: string;
  status?: number | null;
}

export class VatioError extends Error {
  code: string;
  status: number | null;

  constructor(message: string, { code = "sdk_error", status = null }: VatioErrorOptions = {}) {
    super(message);
    this.name = "VatioError";
    this.code = code;
    this.status = status;
  }
}

export type EventPayloads = {
  message: VatioMessage;
  typing: boolean;
  status: ChatStatus;
  error: Error;
  feedback: VatioFeedback | null;
  update: VatioMessageUpdate;
};

export type Unsubscribe = () => void;

export class Emitter {
  private handlers = new Map<VatioEventName, Array<(payload: any) => void>>();

  on<E extends VatioEventName>(event: E, handler: (payload: EventPayloads[E]) => void): Unsubscribe {
    if (!EVENTS.includes(event)) {
      throw new VatioError(`unknown event ${JSON.stringify(event)}; expected one of ${EVENTS.join(", ")}`);
    }
    if (typeof handler !== "function") throw new VatioError("handler must be a function");

    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => this.off(event, handler);
  }

  off<E extends VatioEventName>(event: E, handler: (payload: EventPayloads[E]) => void): void {
    const list = this.handlers.get(event);
    if (!list) return;
    this.handlers.set(event, list.filter((fn) => fn !== handler));
  }

  protected emit<E extends VatioEventName>(event: E, payload: EventPayloads[E]): void {
    (this.handlers.get(event) || []).forEach((fn) => {
      // One bad handler must not take down delivery to the others, or break
      // the socket loop that called us.
      try {
        fn(payload);
      } catch (error) {
        if (event !== "error") this.emit("error", error as Error);
        else if (typeof console !== "undefined") console.error("[vatio]", error);
      }
    });
  }
}

export interface RailsListEnvelope<T> {
  data?: T[];
}

export interface CableFrame {
  type?: "welcome" | "confirm_subscription" | "reject_subscription" | "ping" | "disconnect" | string;
  message?: CableEvent;
}

export interface CableEvent {
  type?: "typing_start" | "typing_stop" | "message" | "message_updated" | "feedback" | string;
  message?: VatioMessage;
  feedback?: WireFeedback;
}

interface ErrorBody {
  error?: string;
  error_description?: string;
}

export async function errorFrom(response: Response): Promise<VatioError> {
  let body: ErrorBody = {};
  try {
    body = await response.json();
  } catch (_) {
    /* not json */
  }
  const message = body.error_description || body.error || `request failed with ${response.status}`;
  const error = new VatioError(message, { code: body.error || "request_failed", status: response.status });

  // The one error worth a console line of its own: it is a setup mistake with
  // an exact fix, and it is invisible from the network tab alone.
  if (body.error === "origin_not_allowed" && typeof console !== "undefined") {
    console.error(`[vatio] ${message}`);
  }
  return error;
}

export const DEFAULT_BASE_URL = "https://vatio.ai";

// A browser, as far as this needs to know. Checked before anything is sent,
// because the request that would teach you about the mistake is the one that
// already put a workspace secret in a page.
export function inBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
