import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const query = "newer_than:2d in:inbox";
// Per-run wall-clock budget for the per-thread body read loop. Sized from observed
// clean-run reality: a 29-row inbox reads in 131-145s, so a 140s budget left ZERO
// margin and any slowdown (concurrent navigation on the shared default browser
// profile, or a few more rows) tripped "mailbox read budget exceeded" and discarded
// an otherwise-authenticated read — that was the sep8-1902 scheduled-run failure
// (26/29 rows verified, then aborted at 152s). Default now 240000ms with generous
// margin; override with GMAIL_READ_BUDGET_MS. The browser's request/evaluate timeouts
// are independent of the outer CLI subprocess allowance below.
const READ_BUDGET_MS = Number(process.env.GMAIL_READ_BUDGET_MS) > 0 ? Number(process.env.GMAIL_READ_BUDGET_MS) : 240_000;
// The browser request has its own bounded timeout. Allow CLI startup and Gateway
// queueing in addition: Sep24's 25s outer timeout killed a still-running initial
// evaluate, then cleanup closed its page before that request completed. The
// canonical job's total480s cap remains authoritative over every operation.
const BROWSER_COMMAND_TIMEOUT_MS = 60_000;
// Dedicated browser profile for the reader. The reader closes its own tab at the end of
// each run (see finally); on the SHARED default profile that close deterministically left
// the very next scheduled open() with no reusable target, so alternating runs failed
// BROWSER_TARGET_UNAVAILABLE (the every-:00-fail / every-:30-ok 60-min-effective flap).
// Isolating the reader onto its own profile means its own close cannot starve its next
// start. Default is UNSET so behavior/authentication is unchanged until an operator opts
// in via GMAIL_BROWSER_PROFILE (mirrors the cua1..cua4 worker-isolation convention).
const BROWSER_PROFILE = (process.env.GMAIL_BROWSER_PROFILE || "").trim();
// Bounded retry budget for acquiring a stable browser target on an empty open(): a
// transient empty open is retried a few times (re-listing existing tabs to reuse an
// already-authenticated Gmail tab) before declaring BROWSER_TARGET_UNAVAILABLE. Kept
// small so a genuinely dead browser still fails fast within the per-run budget.
const TARGET_ACQUIRE_ATTEMPTS = Number(process.env.GMAIL_TARGET_ACQUIRE_ATTEMPTS) > 0 ? Number(process.env.GMAIL_TARGET_ACQUIRE_ATTEMPTS) : 3;
const TARGET_ACQUIRE_BACKOFF_MS = Number(process.env.GMAIL_TARGET_ACQUIRE_BACKOFF_MS) >= 0 ? Number(process.env.GMAIL_TARGET_ACQUIRE_BACKOFF_MS) : 500;
const inboxUrl = "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(query);
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
// A tab is a CANDIDATE reusable Gmail target when its URL is under mail.google.com.
// Note: a mail.google.com URL prefix is NOT proof of an authenticated mailbox (a
// logged-out/interstitial page shares the same origin). Authentication is asserted
// separately by validateInbox (inbox.authenticated) after the read, and the reused tab
// is only accepted once navigateOk re-points it at our inbox query; a stale/unauth tab
// therefore cannot silently produce a "complete" receipt.
const isGmailTab = (tab) => typeof tab?.url === "string" && tab.url.startsWith("https://mail.google.com/");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const writePrivate = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
// Canonical receipt is OVERWRITTEN each successful check (not wx): the runtime
// contract requires a single durable, greppable success marker at a stable path.
const writeCanonical = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
const DEFAULT_RECEIPT_STATE_PATH = path.join(process.env.HOME ?? "/Users/rogelio", "rocky-pipeline", "state", "gmail-watch-last-check.json");
// Never print raw browser/exec errors: they can contain request details. Preserve
// only a bounded diagnostic category instead of swallowing every failure as unknown.
export function failureCategory(error) {
  const message = String(error?.message || '');
  const categories = [
    ['mailbox authentication/query not verified', 'AUTH_OR_QUERY_UNVERIFIED'],
    ['mailbox not rendered', 'INBOX_NOT_RENDERED'],
    // RC-1: match the specific overflow/unsupported prefixes before the legacy umbrella.
    ['mailbox pagination overflow', 'PAGINATION_OVERFLOW'],
    ['mailbox pagination unsupported', 'PAGINATION_UNSUPPORTED'],
    ['mailbox pagination incomplete or unsupported', 'PAGINATION_INCOMPLETE'],
    ['mailbox identity incomplete', 'IDENTITY_INCOMPLETE'],
    ['duplicate mailbox identity', 'DUPLICATE_IDENTITY'],
    ['stable browser target unavailable', 'BROWSER_TARGET_UNAVAILABLE'],
    ['browser read failed', 'BROWSER_READ_FAILED'],
    ['mailbox read budget exceeded', 'READ_BUDGET_EXCEEDED'],
    ['latest message body/identity not verified', 'MESSAGE_BODY_UNVERIFIED'],
    ['mailbox authentication lost on final re-read', 'FINAL_AUTH_LOST'],
    ['notification dedupe changed concurrently', 'DEDUPE_CONCURRENT_CHANGE'],
  ];
  return categories.find(([prefix]) => message.startsWith(prefix))?.[1]
    || (error?.code === 'ETIMEDOUT' ? 'BROWSER_TIMEOUT' : 'READ_FAILED_UNKNOWN');
}
// Diagnostics contain only fixed enums/numbers; never command text, argv, profile,
// target, URLs, message bodies, raw error messages, stdout or stderr.
export function safeFailureDiagnostic(error) {
  const allowedCodes = new Set(['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOSPC', 'EIO', 'ENOBUFS', 'ECONNREFUSED', 'ECONNRESET']);
  const allowedSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT']);
  // Inspect bounded error text internally, expose only a fixed hint. A hint is not
  // root-cause proof; for example handshake failure does not prove a dead Gateway.
  const boundedText = value => typeof value === 'string' ? value.slice(0, 16384)
    : Buffer.isBuffer(value) ? value.subarray(0, 16384).toString('utf8') : '';
  const text = boundedText(error?.message) + '\n' + boundedText(error?.stderr);
  // MESSAGE_BODY_UNVERIFIED carries which sub-check failed (fixed enum only).
  const verificationHint = BODY_VERIFICATION_HINTS.includes(error?.verificationHint) ? error.verificationHint : null;
  const hint = verificationHint
    ?? (text.includes('Opening handshake has timed out') ? 'CLI_OPENING_HANDSHAKE_TIMEOUT'
    : text.includes('browser request timed out') ? 'BROWSER_REQUEST_TIMEOUT'
    : error instanceof SyntaxError ? 'JSON_PARSE_ERROR' : 'UNCLASSIFIED');
  const diagnostic = {
    reason: failureCategory(error), hint,
    code: allowedCodes.has(error?.code) ? error.code : null,
    exitStatus: Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status : null,
    signal: allowedSignals.has(error?.signal) ? error.signal : null,
  };
  // Booleans/small integers/fixed enums only: never subject, body or ids.
  const v = error?.verification;
  if (verificationHint && v && typeof v === 'object') {
    diagnostic.verification = {
      requestedRendered: v.requestedRendered === true,
      latestRenderedIsRequested: v.latestRenderedIsRequested === true,
      renderedMessageCount: Number.isInteger(v.renderedMessageCount) && v.renderedMessageCount >= 0 && v.renderedMessageCount <= 1000 ? v.renderedMessageCount : null,
      subjectHeaderPresent: v.subjectHeaderPresent === true,
      bodySource: ['a3s', 'container', 'message', 'placeholder', 'missing'].includes(v.bodySource) ? v.bodySource : null,
      route: ['thread', 'message'].includes(v.route) ? v.route : null,
    };
  }
  return diagnostic;
}

// The latest-message read check used to be ONE combined condition (id || missing ||
// empty body || exact subject) logged only as MESSAGE_BODY_UNVERIFIED/UNCLASSIFIED, so
// the Oct-1 poison row (thread 1a0f7fdb277b8c85 / msg 1a0f80253c738bb9, a reply in a
// thread started by our own sent mail) was unclassifiable. Split it into a fixed hint.
export const BODY_VERIFICATION_HINTS = ['ID_MISMATCH', 'SUBJECT_MISMATCH', 'BODY_EMPTY'];
// Reply/forward/auto-reply prefixes (EN/ES/PT/DE/FR/Nordic, optional [n]/(n) counter).
// Gmail's list row and the thread header (h2.hP) can disagree on such a prefix for a
// reply/auto-reply in an existing thread; it is the same conversation subject.
const SUBJECT_PREFIX = /^(?:(?:re|fwd?|rv|res|enc|tr|aw|wg|sv|vs)\s*(?:\[\d+\]|\(\d+\))?\s*:|(?:respuesta autom[aá]tica|automatic reply|auto(?:matic)?[- ]?reply|out of office|fuera de la oficina)\s*:)\s*/i;
// Least-surprising subject identity: NFC, drop zero-width chars, collapse every Unicode
// space (NBSP/U+202F included) to one ASCII space, trim, strip leading reply prefixes.
export function normalizeSubject(value) {
  let s = String(value ?? '').normalize('NFC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(SUBJECT_PREFIX, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}
// 'exact' | 'normalized' | null (mismatch). An all-prefix/empty subject never matches
// by normalization alone; it must be exactly equal.
export function subjectMatch(rowSubject, threadSubject) {
  if (typeof threadSubject !== 'string' || typeof rowSubject !== 'string') return null;
  if (threadSubject.trim() === rowSubject.trim()) return 'exact';
  const a = normalizeSubject(rowSubject), b = normalizeSubject(threadSubject);
  return a !== '' && a === b ? 'normalized' : null;
}
// Returns null when verified, else the first failing check as a fixed hint. Identity is
// still strict: the rendered element's own data-legacy-message-id must equal the inbox
// row's last-message-id (no fallback to a different message).
export function verifyThreadRead(row, thread) {
  if (!thread || thread.bodySource === 'missing' || thread.messageId !== row.messageId) return 'ID_MISMATCH';
  if (!subjectMatch(row.subject, thread.subject)) return 'SUBJECT_MISMATCH';
  if (!String(thread.body ?? '').trim()) return 'BODY_EMPTY';
  return null;
}

// RC-2: stable per-thread dedupe identity used both to count "new important" and to
// advance the notification dedupe file so the same thread is not re-reported next run.
export function dedupeKey(row) {
  return [row.subject, row.sender, row.date].map(v => String(v ?? "").trim()).join("|");
}

// RC-3: routine notification classes (high-volume automated mail) must NOT inflate the
// "new important" count. This mirrors gmail-review-state.mjs ROUTINE_PATTERNS so the
// receipt count and the ledger classifier agree. Keep tight: only mail routine-by
// -construction, never customer/billing mail.
const RECEIPT_ROUTINE_PATTERNS = [
  /workflow completed/i, /bpro cartera sync/i, /nightly \(run/i,
  /community digest/i, /^\[qomplement Community\] Summary/i,
];
export function isRoutineRow(row) {
  const hay = `${row?.subject ?? ""} ${row?.sender ?? ""} ${row?.senderAddress ?? ""}`;
  return RECEIPT_ROUTINE_PATTERNS.some(re => re.test(hay));
}

// Count inbox rows whose stable dedupe identity (subject|sender|date) is NOT yet in the
// notification dedupe file AND are not routine-by-construction -> "new important" since
// the last advancement. Returns the routine count and the keys read this run so the
// caller can advance the dedupe file (RC-2).
export function computeNewImportantCount(rows, dedupeText) {
  const seen = new Set(String(dedupeText ?? "").split("\n").map(line => line.trim()).filter(Boolean));
  let count = 0;
  let routineCount = 0;
  const readKeys = [];
  for (const row of rows) {
    const key = dedupeKey(row);
    if (!key) continue;
    readKeys.push(key);
    if (isRoutineRow(row)) { routineCount++; continue; }
    if (!seen.has(key)) count++;
  }
  return { count, routineCount, readKeys };
}

// RC-2: atomically, additively append the dedupe keys read this run that are not yet
// present. Additive-only (never rewrites/truncates) so a concurrent writer's keys are
// preserved; returns whether any new key was appended.
function advanceDedupe(dedupePath, readKeys) {
  const current = fs.existsSync(dedupePath) ? fs.readFileSync(dedupePath, "utf8") : "";
  const present = new Set(current.split("\n").map(l => l.trim()).filter(Boolean));
  const toAppend = [];
  for (const key of readKeys) {
    if (key && !present.has(key)) { present.add(key); toAppend.push(key); }
  }
  if (toAppend.length === 0) return false;
  const suffix = (current.length === 0 || current.endsWith("\n") ? "" : "\n") + toAppend.join("\n") + "\n";
  fs.appendFileSync(dedupePath, suffix, { mode: 0o600 });
  return true;
}

// Gmail list page size (default "Maximum page size" setting). Oct07 08:00 root cause:
// the 2-day window grew past 50 inbox rows, so Gmail rendered page 1 as "1–50 de muchas"
// (unknown-total form; EN "1–50 of many") and the single-page parser, which only
// accepted "1–N de N", failed every scheduled run as PAGINATION_INCOMPLETE until the
// cron auto-disabled. The reader now walks `/p2`, `/p3`… until the numeric total is
// reached (Gmail shows the exact total on the last page: live Oct08 "51–83 de 83").
export const INBOX_PAGE_SIZE = 50;
export const MAX_INBOX_PAGES = Number(process.env.GMAIL_MAX_INBOX_PAGES) > 0 ? Number(process.env.GMAIL_MAX_INBOX_PAGES) : 10;

// Parse Gmail's range chrome ("1–50 de muchas", "51–83 de 83", "1–41 of 41",
// "1–50 de 1,048"). Returns { start, end, total } with total=null when Gmail has not
// computed it yet ("muchas"/"muchos"/"many"), or null when the text is unsupported.
export function parseInboxRange(text) {
  const compact = typeof text === "string" ? text.replace(/\s/g, "").replace(/,/g, "") : "";
  const match = compact.match(/^(\d+)[–-](\d+)(?:de|of)(\d+|muchas|muchos|many)$/i);
  if (!match) return null;
  const total = /^\d+$/.test(match[3]) ? Number(match[3]) : null;
  return { start: Number(match[1]), end: Number(match[2]), total };
}

// Validate ONE rendered list page against the page index it was requested as.
// Returns the parsed range so the caller can decide whether another page follows.
export function validateInboxPage(inbox, expectedStart = 1) {
  if (!inbox.authenticated || inbox.query?.trim() !== query || !Array.isArray(inbox.rows)) {
    throw new Error("mailbox authentication/query not verified");
  }
  // Split a transient empty-DOM render race (list never painted: 0 rows AND no range
  // chrome) from a genuine pagination overflow. The race is retryable; conflating the
  // two as PAGINATION_INCOMPLETE made the 19:00/19:30 empty loads look like a real,
  // unrecoverable pagination fault. Strip thousands separators too ("1–50 de 1,048").
  if (inbox.rows.length === 0 && (!inbox.range || inbox.range.trim() === "")) {
    throw new Error("mailbox not rendered (empty DOM; retryable)");
  }
  const range = parseInboxRange(inbox.range);
  if (!range) throw new Error("mailbox pagination incomplete or unsupported");
  // The rendered page must be the page we asked for and its row count must match the
  // range it advertises; a stale previous page (SPA hash change not yet painted) or a
  // half-painted list fails closed here instead of being silently concatenated.
  if (range.start !== expectedStart || range.end - range.start + 1 !== inbox.rows.length) {
    throw new Error("mailbox pagination unsupported (range/row mismatch)");
  }
  if (range.total !== null && range.end > range.total) {
    throw new Error("mailbox pagination unsupported (range/row mismatch)");
  }
  const identities = new Set();
  for (const row of inbox.rows) {
    if (!row.subject || !row.sender || !row.date || !/^[a-f0-9]+$/.test(row.threadId ?? "") || !/^[a-f0-9]+$/.test(row.messageId ?? "")) {
      throw new Error("mailbox identity incomplete");
    }
    const identity = `${row.threadId}:${row.messageId}`;
    if (identities.has(identity)) throw new Error("duplicate mailbox identity");
    identities.add(identity);
  }
  return range;
}

// Does another list page follow this one? Numeric total: yes while end < total.
// Unknown total ("muchas"): yes while the page is full (Gmail reports the exact total
// once the last page renders, so a full page with unknown total is never the last).
export function hasNextInboxPage(range, rowCount) {
  if (range.total !== null) return range.end < range.total;
  return rowCount >= INBOX_PAGE_SIZE;
}

// Backward-compatible single-object validation (page 1 or an already-merged read):
// the row set must be COMPLETE, i.e. the range must not announce further pages.
export function validateInbox(inbox) {
  const range = validateInboxPage(inbox, 1);
  if (hasNextInboxPage(range, inbox.rows.length)) {
    throw new Error("mailbox pagination overflow (more mail than one page)");
  }
  return digest(JSON.stringify(inbox.rows));
}

// Build the in-page list reader for the page whose range starts at `expectedStart`.
// Page 1 (expectedStart=1) waits for any visible row, as before. A later page is reached
// by a same-document hash change (`/p2`), during which Gmail keeps the PREVIOUS page's
// rows visible until the new one paints; so for expectedStart>1 wait until the visible
// range chrome actually starts at the requested index (bounded; a timeout returns
// whatever is rendered and validateInboxPage fails closed on the start mismatch).
export function buildInboxFn(expectedStart = 1) {
  const start = Number(expectedStart) >= 1 ? Math.floor(Number(expectedStart)) : 1;
  return `async () => {
  // Gmail retains hidden inbox/search tables during SPA navigation. Count only
  // rendered rows and range chrome, not stale hidden lists from the previous route.
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const expectedStart = ${start};
  const rangeText = () => Array.from(document.querySelectorAll(".Dj")).find(visible)?.innerText;
  const settled = () => Array.from(document.querySelectorAll("tr.zA")).some(visible)
    && (expectedStart === 1 || (rangeText() ?? "").replace(/\\s/g, "").startsWith(expectedStart + "\u2013") || (rangeText() ?? "").replace(/\\s/g, "").startsWith(expectedStart + "-"));
  for (let attempt = 0; attempt < 40 && !settled(); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
  return {
    authenticated: location.origin === "https://mail.google.com" && !!document.querySelector("[role=main]") && !!document.querySelector('a[aria-label*="Google"]'),
    query: document.querySelector("input[name=q]")?.value?.trim() || decodeURIComponent((location.hash.split("#search/")[1] ?? "").replace(/\\/p\\d+$/, "").replace(/\\+/g, " ")),
    range: rangeText(),
    rows: Array.from(document.querySelectorAll("tr.zA")).filter(visible).map(row => {
      const identity = row.querySelector("[data-legacy-thread-id]");
      // Gmail marks an UNREAD list row with class "zE" (read rows carry "yO"). Capture it
      // so receipts can answer "what is still unread"; read:true on an entry only means
      // the helper read the body, never Gmail's own unread state. (No backticks here: this
      // code lives inside a template literal.)
      return {
        unread: row.classList.contains("zE"),
        subject: row.querySelector(".bog")?.innerText.trim(),
        sender: row.querySelector(".yW")?.innerText.trim(),
        senderAddress: row.querySelector(".yW [email]")?.getAttribute("email"),
        date: row.querySelector(".xW [title]")?.getAttribute("title"),
        threadId: identity?.getAttribute("data-legacy-thread-id"),
        messageId: identity?.getAttribute("data-legacy-last-message-id")
      };
    })
  };
}`;
}

// Page-1 reader (kept as the exported constant other modules/tests import).
export const inboxFn = buildInboxFn(1);

// Gmail route for list page N of the reader's query (page 1 has no suffix).
export function inboxPageHash(pageIndex) {
  const base = "#search/" + encodeURIComponent(query);
  return pageIndex > 1 ? `${base}/p${pageIndex}` : base;
}

// Read EVERY list page of the query and merge them into one inbox object whose `rows`
// is the complete ordered set (page 1 first). `readPage(pageIndex, expectedStart)` must
// return the raw in-page reader result for that page (navigation is the caller's job via
// `navigate(pageIndex)`), so this stays unit-testable with captured fixtures.
// Throws the same fixed-prefix errors as validateInboxPage (fail closed on any page).
export function readAllInboxPages({ readPage, navigate, maxPages = MAX_INBOX_PAGES }) {
  const pages = [];
  const rows = [];
  let expectedStart = 1;
  let first = null;
  for (let pageIndex = 1; ; pageIndex++) {
    if (pageIndex > maxPages) throw new Error(`mailbox pagination overflow (more than ${maxPages} pages)`);
    if (pageIndex > 1) navigate(pageIndex);
    const page = readPage(pageIndex, expectedStart);
    const range = validateInboxPage(page, expectedStart);
    if (pageIndex === 1) first = page;
    pages.push({ pageIndex, range: page.range, rowCount: page.rows.length, parsed: range });
    rows.push(...page.rows);
    if (!hasNextInboxPage(range, page.rows.length)) break;
    expectedStart = range.end + 1;
  }
  // Cross-page duplicate identity is a merge fault (same thread on two pages).
  const identities = new Set();
  for (const row of rows) {
    const identity = `${row.threadId}:${row.messageId}`;
    if (identities.has(identity)) throw new Error("duplicate mailbox identity");
    identities.add(identity);
  }
  return { authenticated: first.authenticated, query: first.query, range: first.range, pageCount: pages.length, pages, rows };
}

function browser(args) {
  // Thread the dedicated reader profile onto every browser subcommand when configured, so
  // open/evaluate/navigate/close/tabs all target the same isolated profile.
  const profileArgs = BROWSER_PROFILE ? ["--browser-profile", BROWSER_PROFILE] : [];
  // killSignal SIGKILL (Oct05): with the default SIGTERM the `openclaw browser` CLI kept
  // running long after the 60s timeout (Oct03 read-failure.json: commandElapsedMs
  // 138917/177628/201629/348641, exitStatus 143), so one hung evaluate overran the
  // cron's 480s cap, the cron killed the whole run, `finally` never closed the tab, and
  // every killed run leaked a Gmail tab. SIGKILL makes the 60s bound real.
  const output = execFileSync("openclaw", ["browser", ...profileArgs, ...args, "--json"], { encoding: "utf8", timeout: BROWSER_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output);
}

// A leftover reader tab is identified by the reader's own exact search route (Gmail
// rewrites %20 to '+'). Operator tabs on other Gmail routes are never matched.
export function isStaleReaderTab(tab) {
  if (typeof tab?.url !== "string" || !tab.url.startsWith("https://mail.google.com/mail/u/0/#search/")) return false;
  try { return decodeURIComponent(tab.url.slice("https://mail.google.com/mail/u/0/#search/".length).replace(/\+/g, " ")).trim() === query; }
  catch { return false; }
}

// Close one target through Chrome's DevTools HTTP endpoint. This is handled by the
// browser process, so it works even when the tab's renderer is dead/hung -- exactly the
// case where `openclaw browser close/evaluate` (Playwright connectOverCDP attaches to
// every page) times out. --noproxy: the CDP endpoint is loopback only.
function cdpHttpClose(cdpUrl, targetId) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl) || !/^[A-F0-9]{16,64}$/i.test(targetId)) return false;
  const out = execFileSync("curl", ["-s", "--noproxy", "*", "-m", "10", "-X", "PUT", `${cdpUrl}/json/close/${targetId}`], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  return /Target is closing/.test(out);
}

// Root cause of the Oct03 10x red streak (live Oct05 11:5x): the reader's Chrome had
// lost every renderer process; 10 leaked reader tabs (+1 other) were renderer-less, and
// Playwright's connectOverCDP (used by every `openclaw browser evaluate`) hung on them
// ("connectOverCDP: Timeout 9000ms exceeded") even for a freshly opened healthy tab.
// Closing the dead tabs restored evaluate in 3s. So before acquiring a target, close
// leftover tabs carrying the reader's own route (from runs killed before `finally`).
// Best-effort and bounded: a failed sweep never fails the read; it is recorded.
export function sweepStaleReaderTabs(browserCall, { closeTarget = cdpHttpClose, max = 20 } = {}) {
  const result = { found: 0, closed: 0, error: null };
  try {
    const listed = browserCall(["tabs"]);
    const stale = (Array.isArray(listed?.tabs) ? listed.tabs : []).filter(isStaleReaderTab).slice(0, max);
    result.found = stale.length;
    if (!stale.length) return result;
    const cdpUrl = browserCall(["status"])?.cdpUrl;
    for (const tab of stale) {
      try { if (closeTarget(cdpUrl, tab.targetId)) result.closed++; } catch {}
    }
  } catch (error) { result.error = failureCategory(error); }
  return result;
}

// A browser subcommand (navigate/close/…) is only "ok" when it neither throws nor
// returns a non-ok envelope. The reader's evaluate path already treats `ok !== true`
// as failure; navigate/close share that `{ ok }` envelope, so mirror the same check
// here. Returns true only on a definite success; any throw or falsy/absent `ok` is
// treated as a failed navigation (fail closed).
function navigateOk(browserCall, target) {
  let response;
  try { response = browserCall(["navigate", inboxUrl, "--target-id", target]); }
  catch { return false; }
  return response?.ok === true;
}

// Gmail is already authenticated and loaded when the body loop begins. Changing
// its SPA route must not wait for page.goto's full-page `load` event: that event
// timed out on Sep24 while reading the first thread. Keep navigation same-origin
// and retain the independent subject/message/body validation after every route.
export function navigateGmailHash(browserCall, target, hash) {
  if (!/^#(?:all\/[a-f0-9]+|search\/[^\s]+)$/.test(hash)) throw new Error("browser read failed: invalid Gmail route");
  const response = browserCall(["evaluate", "--target-id", target, "--fn", `() => {
    if (location.origin !== "https://mail.google.com" || location.pathname !== "/mail/u/0/") return { navigated: false };
    location.hash = ${JSON.stringify(hash)};
    return { navigated: location.hash === ${JSON.stringify(hash)} };
  }`]);
  if (response?.ok !== true || response.result?.navigated !== true) throw new Error("browser read failed: Gmail route not acknowledged");
}

// Acquire a stable browser target for the inbox URL, resilient to a transient empty
// open(). Root cause of the receipt flap: after the reader's own close(), the next
// open() sometimes returns no suggestedTargetId/tabId; throwing on the first empty open
// discarded an otherwise-healthy run. Instead: (1) try open(); (2) on an empty result,
// re-list tabs and reuse an existing authenticated Gmail tab (navigating it to the inbox
// URL); (3) retry open() a few times with short backoff. Only after all attempts fail do
// we surface BROWSER_TARGET_UNAVAILABLE — so a genuinely dead browser still fails hard
// and the wrapper's honest CHECK_INCOMPLETE gate is preserved.
export function acquireTarget(browserCall, { attempts = TARGET_ACQUIRE_ATTEMPTS, backoffMs = TARGET_ACQUIRE_BACKOFF_MS, sleep = sleepSync } = {}) {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    const opened = browserCall(["open", inboxUrl]);
    const target = opened?.suggestedTargetId ?? opened?.tabId;
    // owned=true: this run opened the tab, so its end-of-run close is safe. owned=false:
    // we reused a pre-existing authenticated Gmail tab we did NOT open, and MUST NOT close
    // it in the finally (close-only-owned-tab semantics) or we would tear down an
    // operator/other-run tab. Return the ownership flag so the caller can gate cleanup.
    if (target) return { target, owned: true };
    // Empty open: try to reuse an existing authenticated Gmail tab before retrying.
    let listed;
    try { listed = browserCall(["tabs"]); } catch { listed = null; }
    const reusable = Array.isArray(listed?.tabs) ? listed.tabs.find(isGmailTab) : null;
    const reuseTarget = reusable?.suggestedTargetId ?? reusable?.tabId;
    if (reuseTarget) {
      // Point the reused tab at our inbox query so the subsequent read sees the right
      // list. FAIL CLOSED: a reused tab still carries its PREVIOUS route's mailbox
      // contents, so it is usable only once we have positively re-pointed it at our
      // inbox query. The prior code swallowed a failed navigate with an empty catch and
      // returned the reused target anyway, so a failed navigation would read STALE
      // mailbox contents from the reused tab and could still write a "complete" receipt.
      // Now: only hand back the reused target when the navigate DEFINITELY succeeded;
      // otherwise fall through to retry/backoff, and if every attempt fails, throw
      // "stable browser target unavailable" (BROWSER_TARGET_UNAVAILABLE ⇒ the wrapper's
      // honest CHECK_INCOMPLETE gate) rather than reading a stale tab.
      if (navigateOk(browserCall, reuseTarget)) return { target: reuseTarget, owned: false };
    }
    if (attempt < Math.max(1, attempts) - 1) sleep(backoffMs);
  }
  throw new Error("stable browser target unavailable");
}

export function runMailboxCheck({ artifactDir, dedupePath, browserCall = browser, receiptStatePath = DEFAULT_RECEIPT_STATE_PATH }) {
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const beforeDedupe = fs.readFileSync(dedupePath);
  const sweep = sweepStaleReaderTabs(browserCall);
  try { writePrivate(path.join(artifactDir, "stale-tab-sweep.json"), sweep); } catch {}
  const { target, owned: targetOwned } = acquireTarget(browserCall);
  const startedMs = Date.now();
  let phase = 'initial-inbox';
  let commandFailure = null;
  const underlyingBrowserCall = browserCall;
  browserCall = (args) => {
    // Retain only the failing command; successful commands cannot be misattributed
    // to a later validation or filesystem failure.
    commandFailure = null;
    const commandStartedMs = Date.now();
    try { return underlyingBrowserCall(args); }
    catch (error) {
      commandFailure = {
        error,
        operation: ['open', 'tabs', 'navigate', 'evaluate', 'close'].includes(args[0]) ? args[0] : 'other',
        elapsedMs: Math.max(0, Date.now() - commandStartedMs),
      };
      throw error;
    }
  };
  const evaluate = (fn) => {
    const response = browserCall(["evaluate", "--target-id", target, "--fn", fn]);
    if (response.ok !== true) throw new Error("browser read failed");
    return response.result;
  };
  try {
    // Retry the initial read a few times on a transient empty-DOM render race
    // (INBOX_NOT_RENDERED): the list frame occasionally has not painted on first
    // evaluate, which previously aborted the whole scheduled run. A real pagination
    // overflow or auth failure still fails fast (not retried).
    // Multi-page read (Oct08): page 1 is read in place; later pages are reached by a
    // same-document hash change to `/pN` and waited on by their expected start index.
    // Any page failing validation fails the whole read (no partial concatenation).
    let lastPage = null;
    const readFullInbox = () => readAllInboxPages({
      navigate: (pageIndex) => navigateGmailHash(browserCall, target, inboxPageHash(pageIndex)),
      readPage: (pageIndex, expectedStart) => { lastPage = { pageIndex, expectedStart, page: evaluate(buildInboxFn(expectedStart)) }; return lastPage.page; },
    });
    let inbox;
    let inboxHash;
    for (let attempt = 0; ; attempt++) {
      try { inbox = readFullInbox(); inboxHash = digest(JSON.stringify(inbox.rows)); break; }
      catch (error) {
        const category = failureCategory(error);
        if (category === 'INBOX_NOT_RENDERED' && attempt < 4) continue;
        if (category === 'PAGINATION_INCOMPLETE' || category === 'PAGINATION_OVERFLOW' || category === 'PAGINATION_UNSUPPORTED') {
          const page = lastPage?.page;
          const range = page ? parseInboxRange(page.range) : null;
          const diagnostic = {
            schema: 'gmail-pagination-diagnostic.v2',
            phase: 'initial-inbox', reason: category,
            pageIndex: lastPage?.pageIndex ?? null, expectedStart: lastPage?.expectedStart ?? null,
            rangePresent: typeof page?.range === 'string' && page.range.trim().length > 0,
            rangeFormatSupported: Boolean(range), rowCount: Array.isArray(page?.rows) ? page.rows.length : null,
            parsedStart: range ? range.start : null, parsedEnd: range ? range.end : null,
            parsedTotal: range ? range.total : null, totalKnown: Boolean(range && range.total !== null),
          };
          // A failed diagnostic write must not replace the original read failure.
          try { writePrivate(path.join(artifactDir, 'pagination-failure.json'), diagnostic); } catch {}
        }
        throw error;
      }
    }
    phase = 'initial-inbox-write';
    writePrivate(path.join(artifactDir, "inbox.json"), inbox);
    const entries = [];
    for (const [index, row] of inbox.rows.entries()) {
      if (Date.now() - startedMs > READ_BUDGET_MS) throw new Error(`mailbox read budget exceeded (${READ_BUDGET_MS}ms, read ${index}/${inbox.rows.length} threads)`);
      phase = 'body-navigate';
      navigateGmailHash(browserCall, target, `#all/${row.threadId}`);
      phase = 'body-read';
      const threadReadFn = `async () => {
        const messageId = ${JSON.stringify(row.messageId)};
        // Gmail can retain a hidden previous thread view during SPA navigation; prefer the
        // VISIBLE thread header (same rule as inboxFn's visible-row filter).
        const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
        const headerSubject = () => { const all = Array.from(document.querySelectorAll("h2.hP")); return (all.find(visible) ?? all[0])?.innerText; };
        // Safe shape-only facts for a failure hint (no ids/text leave the helper's diagnostic).
        const shape = () => {
          const ids = Array.from(new Set(Array.from(document.querySelectorAll("[data-legacy-message-id]")).map(e => e.getAttribute("data-legacy-message-id"))));
          return { renderedMessageCount: ids.length, requestedRendered: ids.includes(messageId), latestRenderedIsRequested: ids.length > 0 && ids[ids.length - 1] === messageId };
        };
        // Echo the id the RENDERED element actually carries (not the requested constant).
        const idOf = message => message.getAttribute("data-legacy-message-id");
        // A real body is the .a3s content. Some legitimate inbound mail (e.g. Google
        // Docs/Drive "document shared" notifications from drive-shares-dm-noreply@google.com)
        // renders as a card with an EMPTY .a3s that settles to a bare "-" placeholder, so
        // .a3s alone never yields text. Fall back to the message container text so a single
        // notification-type mail does not abort the whole verified read. Identity
        // (messageId + subject) is still asserted below.
        const isPlaceholder = (t) => { const s = (t ?? "").trim(); return s === "" || s === "-"; };
        // Ordered body candidates, most-specific first, ending in the whole message
        // element text. Notification cards leave .a3s and .ii.gt as bare "-" placeholders,
        // but message.innerText still carries the sender + notification line.
        const pick = (message) => {
          const a3s = message.querySelector(".a3s")?.innerText;
          if (!isPlaceholder(a3s)) return {body: a3s, bodySource: "a3s"};
          const iigt = message.querySelector(".ii.gt")?.innerText;
          if (!isPlaceholder(iigt)) return {body: iigt, bodySource: "container"};
          const whole = message.innerText;
          if (!isPlaceholder(whole)) return {body: whole, bodySource: "message"};
          return null;
        };
        for (let attempt = 0; attempt < 30; attempt++) {
          const message = document.querySelector('[data-legacy-message-id="' + messageId + '"]');
          if (message) {
            const subject = headerSubject();
            const picked = pick(message);
            if (picked) return {messageId: idOf(message), subject, body: picked.body, bodySource: picked.bodySource, ...shape()};
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        // Last resort: message element present; take whatever text it has (settled).
        const message = document.querySelector('[data-legacy-message-id="' + messageId + '"]');
        if (message) {
          const subject = headerSubject();
          const picked = pick(message);
          if (picked) return {messageId: idOf(message), subject, body: picked.body, bodySource: picked.bodySource, ...shape()};
          return {messageId: idOf(message), subject, body: message.innerText, bodySource: "placeholder", ...shape()};
        }
        return {messageId: null, subject: headerSubject() ?? null, body: null, bodySource: "missing", ...shape()};
      }`;
      let thread = evaluate(threadReadFn);
      let route = "thread";
      // Threads WE started (compose -> autosaved draft -> send) carry a legacy thread id
      // equal to the first DRAFT's id, which no longer exists as a message. Gmail does not
      // render `#all/<that id>` (live Oct01: thread 1a0f7fdb… = 09:03:13 draft, sent msg
      // 09:04:10, reply 09:08; requested message never rendered, 7/7 runs). Gmail resolves a
      // MESSAGE id route to its containing thread, so retry once by the row's own message id.
      // Identity stays strict: verifyThreadRead below still requires the rendered element's
      // data-legacy-message-id == row.messageId plus the subject/body checks.
      if (thread?.requestedRendered !== true && row.messageId !== row.threadId) {
        phase = 'body-navigate-message';
        navigateGmailHash(browserCall, target, `#all/${row.messageId}`);
        phase = 'body-read';
        thread = evaluate(threadReadFn);
        route = "message";
      }
      // Identity (messageId + subject) MUST match. The message element must exist and
      // carry some text; a fully missing message (no element) is still fatal. Each
      // sub-check now reports a fixed hint (ID_MISMATCH | SUBJECT_MISMATCH | BODY_EMPTY).
      const verificationHint = verifyThreadRead(row, thread);
      if (verificationHint) {
        throw Object.assign(new Error("latest message body/identity not verified"), {
          verificationHint,
          verification: {
            requestedRendered: thread?.requestedRendered, latestRenderedIsRequested: thread?.latestRenderedIsRequested,
            renderedMessageCount: thread?.renderedMessageCount, subjectHeaderPresent: typeof thread?.subject === "string" && thread.subject.trim() !== "",
            bodySource: thread?.bodySource, route,
          },
        });
      }
      phase = 'body-write';
      const bodyPath = path.join(artifactDir, `message-${index + 1}.json`);
      writePrivate(bodyPath, thread);
      entries.push({ ...row, bodyPath, bodySha256: digest(fs.readFileSync(bodyPath)), bodySource: thread.bodySource, subjectMatch: subjectMatch(row.subject, thread.subject), route, read: true });
    }
    phase = 'final-inbox-navigate';
    navigateGmailHash(browserCall, target, inboxPageHash(1));
    // Re-read the inbox after the per-thread navigation. A COMPLETED read must not
    // be discarded just because mail arrived (or Gmail's range chrome differs) during
    // the ~minute of navigation: every targeted body was already verified above. So a
    // benign post-read change is recorded as mailboxStable:false (dedupe stays put),
    // NOT thrown. Only a hard read failure (auth lost / no rows) is fatal.
    let mailboxStable = true;
    let finalInbox;
    try {
      phase = 'final-inbox-read';
      // Re-read ALL pages so a multi-page mailbox compares like-for-like with the
      // initial read; a benign page-walk failure here is "changed" (stable:false),
      // not fatal, exactly like a changed single page was before.
      let finalHash = null;
      try { finalInbox = readFullInbox(); finalHash = digest(JSON.stringify(finalInbox.rows)); }
      catch { finalInbox = lastPage?.page ?? { authenticated: false, rows: null }; finalHash = null; }
      phase = 'final-inbox-validate';
      if (!finalInbox.authenticated || !Array.isArray(finalInbox.rows)) throw new Error("mailbox authentication lost on final re-read");
      mailboxStable = finalHash === inboxHash;
      phase = 'final-inbox-write';
      writePrivate(path.join(artifactDir, "inbox-after.json"), finalInbox);
    } catch (error) {
      // Hard failure on the final re-read (not merely "changed") is still fatal.
      throw error;
    }
    // RC-2: a concurrent change to the dedupe file is no longer fatal. Advancement is
    // additive (append-only, never truncate), so another writer's keys are preserved
    // and this run's read is not discarded. Record whether a concurrent change was seen.
    phase = 'dedupe-and-receipt';
    const dedupeConcurrentChange = digest(fs.readFileSync(dedupePath)) !== digest(beforeDedupe);
    const { count: newImportantCount, routineCount, readKeys: readDedupeKeys } =
      computeNewImportantCount(inbox.rows, beforeDedupe.toString());
    // Advance only stable routine rows. Important items remain visible until substantive
    // review; a successful read is not a notification or completed review.
    let notificationDedupeAdvanced = false;
    try {
      notificationDedupeAdvanced = mailboxStable && advanceDedupe(dedupePath, inbox.rows.filter(isRoutineRow).map(dedupeKey));
    } catch (error) {
      // A dedupe-advance write failure must not discard an otherwise-verified read;
      // record it and leave the count honest (advanced=false).
      process.stderr.write(`GMAIL_DEDUPE_ADVANCE_WARNING: ${failureCategory(error)}\n`);
    }
    const checkedAt = new Date().toISOString();
    const receipt = {
      schema: "gmail-browser-read-receipt.v1", startedAt, checkedAt, query,
      complete: true, mailboxAuthenticated: true, checkedCount: entries.length,
      readScope: "latest-message-per-inbox-thread", triageComplete: false, businessActionsComplete: false,
      newImportantCount, routineCount, mailboxStable, dedupeConcurrentChange,
      readKeys: entries.map(row => `${row.threadId}:${row.messageId}`),
      inboxRowsSha256: inboxHash, notificationDedupeSha256: digest(beforeDedupe),
      notificationDedupeAdvanced, pendingAlertReview: true,
      sentMail: false, sentMessages: false, entries,
    };
    phase = 'receipt-write';
    writePrivate(path.join(artifactDir, "receipt.json"), receipt);
    // Canonical, greppable success marker per the runtime contract. Overwrites the
    // previous check so a verifier can gate cron status on a FRESH receipt file.
    phase = 'canonical-write';
    writeCanonical(receiptStatePath, {
      schema: "gmail-watch-last-check.v1", checkedAt, query,
      complete: true, mailboxAuthenticated: true, checkedCount: entries.length,
      readScope: "latest-message-per-inbox-thread", triageComplete: false, businessActionsComplete: false,
      newImportantCount, routineCount, mailboxStable, notificationDedupeAdvanced,
      pendingAlertReview: true, sentMail: false, artifactDir,
      inboxRowsSha256: inboxHash,
    });
    return receipt;
  } catch (error) {
    const failedCommand = commandFailure?.error === error ? commandFailure : null;
    const diagnostic = {
      schema: 'gmail-read-failure.v1', phase, failedAt: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - startedMs),
      operation: failedCommand?.operation ?? null, commandElapsedMs: failedCommand?.elapsedMs ?? null,
      ...safeFailureDiagnostic(error),
    };
    try { writePrivate(path.join(artifactDir, 'read-failure.json'), diagnostic); }
    catch { process.stderr.write("GMAIL_DIAGNOSTIC_WARNING: evidence write failed\n"); }
    throw error;
  } finally {
    // Cleanup is not a second mailbox read. Preserve the original read failure,
    // or a completed receipt, while recording cleanup separately without raw errors.
    // Close-only-owned-tab semantics: close ONLY a tab this run opened. When
    // acquireTarget reused a pre-existing authenticated Gmail tab (targetOwned=false),
    // closing it would tear down an operator/other-run tab, so we skip the close and
    // record it as a preserved (not-owned) tab.
    let cleanup;
    if (!targetOwned) {
      cleanup = { closed: false, reason: "REUSED_TAB_PRESERVED", owned: false };
    } else {
      try {
        browserCall(["close", target]);
        cleanup = { closed: true, owned: true };
      } catch (error) {
        cleanup = { closed: false, reason: failureCategory(error), owned: true, diagnostic: safeFailureDiagnostic(error) };
      }
    }
    try { writePrivate(path.join(artifactDir, "cleanup.json"), cleanup); }
    catch { process.stderr.write("GMAIL_CLEANUP_WARNING: evidence write failed\n"); }
    if (!cleanup.closed && cleanup.reason !== "REUSED_TAB_PRESERVED") process.stderr.write(`GMAIL_CLEANUP_WARNING: ${cleanup.reason}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [artifactDir, dedupePath] = process.argv.slice(2);
    if (!artifactDir || !dedupePath) throw new Error("artifact directory and notification dedupe path required");
    const receipt = runMailboxCheck({ artifactDir, dedupePath });
    process.stdout.write(JSON.stringify({ receipt: path.join(artifactDir, "receipt.json"), complete: receipt.complete, checkedCount: receipt.checkedCount,
      readScope: receipt.readScope, triageComplete: false, businessActionsComplete: false }) + "\n");
  } catch (error) {
    const category = failureCategory(error);
    const hint = BODY_VERIFICATION_HINTS.includes(error?.verificationHint) ? `; hint=${error.verificationHint}` : '';
    process.stderr.write(`Gmail check incomplete; reason=${category}${hint}; no success receipt or notification dedupe advancement.\n`);
    process.exitCode = 1;
  }
}
