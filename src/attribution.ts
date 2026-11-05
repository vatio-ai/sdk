/**
 * Where the visit came from, sent with the conversation the visitor starts so
 * the business can see which campaigns and pages bring conversations: the
 * page they entered the site on, the site that sent them, the campaign's
 * utm_* and the ad click ids (Google's gclid, Meta's fbclid).
 *
 * The campaign is on the URL of the page the visitor landed on, and the
 * conversation usually starts pages later, where it is gone. So the SDK reads
 * the address bar as soon as it loads, and keeps the visit in sessionStorage
 * for the rest of the tab: a page that arrives with campaign parameters, or
 * from another site, starts a new visit; a page reached from inside the site
 * keeps the one there is.
 *
 * Both URLs are kept as origin and path. A query string carries tokens,
 * emails and search terms, and what is worth keeping from it has keys of its
 * own. Vatio cuts everything to size again on its side.
 */
export interface VatioAttribution {
  landing_page?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  fbclid?: string;
}

const PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"] as const;
const STORE_KEY = "vatio:attribution";
const MAX_VALUE = 200;

function pageOf(url: URL): string {
  return url.origin + url.pathname;
}

function store(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    // A sandboxed frame or blocked storage throws on the mere read.
    return null;
  }
}

function read(storage: Storage | null): VatioAttribution | null {
  try {
    const raw = storage?.getItem(STORE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" ? (value as VatioAttribution) : null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, value: VatioAttribution): void {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    /* Storage full or blocked: this page's visit is still sent. */
  }
}

function campaignOf(value: VatioAttribution): string {
  return PARAMS.map((key) => value[key] || "").join("\u0000");
}

/**
 * Reads this page's address and referrer into the visit the tab is on, and
 * returns it. Null outside a browser.
 */
export function rememberVisit(): VatioAttribution | null {
  if (typeof location === "undefined" || !location.href) return null;

  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;

  const storage = store();
  const stored = read(storage);

  const touch: VatioAttribution = { landing_page: pageOf(url) };
  for (const key of PARAMS) {
    const value = url.searchParams.get(key);
    if (value) touch[key] = value.slice(0, MAX_VALUE);
  }
  const referrer = typeof document !== "undefined" ? document.referrer : "";
  try {
    const from = referrer ? new URL(referrer) : null;
    if (from && /^https?:$/.test(from.protocol) && from.host !== url.host) touch.referrer = pageOf(from);
  } catch {
    /* Not a URL: no referrer. */
  }

  // A new visit is one that brings a campaign, or arrives from another site
  // without one. A single-page app keeps the referrer it loaded with and
  // drops the campaign from the address bar as it routes, and neither is a
  // new visit.
  const campaign = campaignOf(touch);
  const fresh = campaign.replace(/\u0000/g, "")
    ? !stored || campaign !== campaignOf(stored)
    : !!touch.referrer && touch.referrer !== stored?.referrer;

  if (stored && !fresh) return stored;
  write(storage, touch);
  return touch;
}

// The landing page is this one, so it is read the moment the SDK loads,
// before a router rewrites the address or the visitor clicks on.
rememberVisit();
