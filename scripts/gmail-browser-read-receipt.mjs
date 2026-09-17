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
// margin; override with GMAIL_READ_BUDGET_MS. The per-browser-call timeout (25s) is
// unchanged, so a genuinely hung browser still fails fast per call.
const READ_BUDGET_MS = Number(process.env.GMAIL_READ_BUDGET_MS) > 0 ? Number(process.env.GMAIL_READ_BUDGET_MS) : 240_000;
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

export function validateInbox(inbox) {
  if (!inbox.authenticated || inbox.query?.trim() !== query || !Array.isArray(inbox.rows)) {
    throw new Error("mailbox authentication/query not verified");
  }
  // Split a transient empty-DOM render race (list never painted: 0 rows AND no range
  // chrome) from a genuine pagination overflow. The race is retryable; conflating the
  // two as PAGINATION_INCOMPLETE made the 19:00/19:30 empty loads look like a real,
  // unrecoverable pagination fault. Strip thousands separators too ("1–50 de 1,048").
  const rangeText = typeof inbox.range === "string" ? inbox.range.replace(/\s/g, "").replace(/,/g, "") : "";
  if (inbox.rows.length === 0 && (!inbox.range || inbox.range.trim() === "")) {
    throw new Error("mailbox not rendered (empty DOM; retryable)");
  }
  const range = rangeText.match(/^1[–-](\d+)(?:de|of)(\d+)$/);
  if (!range || Number(range[1]) !== inbox.rows.length || Number(range[2]) !== inbox.rows.length) {
    // Distinguish a genuine pagination overflow (parsed total > shown end, i.e. more
    // mail than one page) from an unparseable/unsupported range chrome. Both are real
    // (not retried), but the split gives an accurate diagnostic instead of one opaque
    // "incomplete or unsupported" bucket.
    if (range && Number(range[2]) > Number(range[1])) {
      throw new Error("mailbox pagination overflow (more mail than one page)");
    }
    if (range) throw new Error("mailbox pagination unsupported (range/row mismatch)");
    throw new Error("mailbox pagination incomplete or unsupported");
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
  return digest(JSON.stringify(inbox.rows));
}

export const inboxFn = `async () => {
  // Gmail retains hidden inbox/search tables during SPA navigation. Count only
  // rendered rows and range chrome, not stale hidden lists from the previous route.
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  for (let attempt = 0; attempt < 30 && !Array.from(document.querySelectorAll("tr.zA")).some(visible); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
  return {
    authenticated: location.origin === "https://mail.google.com" && !!document.querySelector("[role=main]") && !!document.querySelector('a[aria-label*="Google"]'),
    query: document.querySelector("input[name=q]")?.value?.trim() || decodeURIComponent((location.hash.split("#search/")[1] ?? "").replace(/\\+/g, " ")),
    range: Array.from(document.querySelectorAll(".Dj")).find(visible)?.innerText,
    rows: Array.from(document.querySelectorAll("tr.zA")).filter(visible).map(row => {
      const identity = row.querySelector("[data-legacy-thread-id]");
      return {
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

function browser(args) {
  // Thread the dedicated reader profile onto every browser subcommand when configured, so
  // open/evaluate/navigate/close/tabs all target the same isolated profile.
  const profileArgs = BROWSER_PROFILE ? ["--browser-profile", BROWSER_PROFILE] : [];
  const output = execFileSync("openclaw", ["browser", ...profileArgs, ...args, "--json"], { encoding: "utf8", timeout: 25_000, maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output);
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
  const { target, owned: targetOwned } = acquireTarget(browserCall);
  const startedMs = Date.now();
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
    let inbox;
    let inboxHash;
    for (let attempt = 0; ; attempt++) {
      inbox = evaluate(inboxFn);
      try { inboxHash = validateInbox(inbox); break; }
      catch (error) {
        const category = failureCategory(error);
        if (category === 'INBOX_NOT_RENDERED' && attempt < 4) continue;
        if (category === 'PAGINATION_INCOMPLETE' || category === 'PAGINATION_OVERFLOW' || category === 'PAGINATION_UNSUPPORTED') {
          const range = typeof inbox.range === 'string'
            ? inbox.range.replace(/\s/g, '').replace(/,/g, '').match(/^1[–-](\d+)(?:de|of)(\d+)$/) : null;
          const diagnostic = {
            schema: 'gmail-pagination-diagnostic.v1',
            phase: 'initial-inbox', reason: category,
            rangePresent: typeof inbox.range === 'string' && inbox.range.trim().length > 0,
            rangeFormatSupported: Boolean(range), rowCount: inbox.rows.length,
            parsedEnd: range ? Number(range[1]) : null,
            parsedTotal: range ? Number(range[2]) : null,
          };
          // A failed diagnostic write must not replace the original read failure.
          try { writePrivate(path.join(artifactDir, 'pagination-failure.json'), diagnostic); } catch {}
        }
        throw error;
      }
    }
    writePrivate(path.join(artifactDir, "inbox.json"), inbox);
    const entries = [];
    for (const [index, row] of inbox.rows.entries()) {
      if (Date.now() - startedMs > READ_BUDGET_MS) throw new Error(`mailbox read budget exceeded (${READ_BUDGET_MS}ms, read ${index}/${inbox.rows.length} threads)`);
      browserCall(["navigate", `https://mail.google.com/mail/u/0/#all/${row.threadId}`, "--target-id", target]);
      const thread = evaluate(`async () => {
        const messageId = ${JSON.stringify(row.messageId)};
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
            const subject = document.querySelector("h2.hP")?.innerText;
            const picked = pick(message);
            if (picked) return {messageId, subject, body: picked.body, bodySource: picked.bodySource};
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        // Last resort: message element present; take whatever text it has (settled).
        const message = document.querySelector('[data-legacy-message-id="' + messageId + '"]');
        if (message) {
          const subject = document.querySelector("h2.hP")?.innerText;
          const picked = pick(message);
          if (picked) return {messageId, subject, body: picked.body, bodySource: picked.bodySource};
          return {messageId, subject, body: message.innerText, bodySource: "placeholder"};
        }
        return {messageId, subject: null, body: null, bodySource: "missing"};
      }`);
      // Identity (messageId + subject) MUST match. The message element must exist and
      // carry some text; a fully missing message (no element) is still fatal.
      if (thread.messageId !== row.messageId || thread.bodySource === "missing" || !thread.body?.trim() || thread.subject?.trim() !== row.subject.trim()) {
        throw new Error("latest message body/identity not verified");
      }
      const bodyPath = path.join(artifactDir, `message-${index + 1}.json`);
      writePrivate(bodyPath, thread);
      entries.push({ ...row, bodyPath, bodySha256: digest(fs.readFileSync(bodyPath)), bodySource: thread.bodySource, read: true });
    }
    browserCall(["navigate", inboxUrl, "--target-id", target]);
    // Re-read the inbox after the per-thread navigation. A COMPLETED read must not
    // be discarded just because mail arrived (or Gmail's range chrome differs) during
    // the ~minute of navigation: every targeted body was already verified above. So a
    // benign post-read change is recorded as mailboxStable:false (dedupe stays put),
    // NOT thrown. Only a hard read failure (auth lost / no rows) is fatal.
    let mailboxStable = true;
    let finalInbox;
    try {
      finalInbox = evaluate(inboxFn);
      if (!finalInbox.authenticated || !Array.isArray(finalInbox.rows)) throw new Error("mailbox authentication lost on final re-read");
      let finalHash = null;
      try { finalHash = validateInbox(finalInbox); } catch { finalHash = null; }
      mailboxStable = finalHash === inboxHash;
      writePrivate(path.join(artifactDir, "inbox-after.json"), finalInbox);
    } catch (error) {
      // Hard failure on the final re-read (not merely "changed") is still fatal.
      throw error;
    }
    // RC-2: a concurrent change to the dedupe file is no longer fatal. Advancement is
    // additive (append-only, never truncate), so another writer's keys are preserved
    // and this run's read is not discarded. Record whether a concurrent change was seen.
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
    writePrivate(path.join(artifactDir, "receipt.json"), receipt);
    // Canonical, greppable success marker per the runtime contract. Overwrites the
    // previous check so a verifier can gate cron status on a FRESH receipt file.
    writeCanonical(receiptStatePath, {
      schema: "gmail-watch-last-check.v1", checkedAt, query,
      complete: true, mailboxAuthenticated: true, checkedCount: entries.length,
      readScope: "latest-message-per-inbox-thread", triageComplete: false, businessActionsComplete: false,
      newImportantCount, routineCount, mailboxStable, notificationDedupeAdvanced,
      pendingAlertReview: true, sentMail: false, artifactDir,
      inboxRowsSha256: inboxHash,
    });
    return receipt;
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
        cleanup = { closed: false, reason: failureCategory(error), owned: true };
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
    process.stderr.write(`Gmail check incomplete; reason=${category}; no success receipt or notification dedupe advancement.\n`);
    process.exitCode = 1;
  }
}
