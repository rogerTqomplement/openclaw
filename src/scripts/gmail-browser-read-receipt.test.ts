import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireInboxTarget, failureCategory, inboxFn, runMailboxCheck, validateInbox } from "../../scripts/gmail-browser-read-receipt.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const makeInbox = () => ({ authenticated: true, query: "newer_than:2d in:inbox ", range: "1–1 de 1", rows: [{ subject: "Example", sender: "Sender", date: "2026-09-05", threadId: "abc123", messageId: "def456" }] });

// Regression for the #search hash-nav bug: real Gmail leaves input[name=q] empty, so the
// production inboxFn must fall back to the URL hash it navigated to. This executes the actual
// inboxFn string from the .mjs against a stubbed DOM, so reverting the fix fails these tests.
async function runInboxFn(searchBoxValue: string, hash: string) {
  const doc = {
    querySelector(sel: string) {
      if (sel === "input[name=q]") return { value: searchBoxValue };
      if (sel === "[role=main]") return {};
      if (sel === 'a[aria-label*="Google"]') return {};
      return null;
    },
    querySelectorAll() { return []; },
  };
  const fn = new Function("document", "location", `return (${inboxFn})();`);
  return fn(doc, { origin: "https://mail.google.com", hash });
}

describe("Gmail query derivation (hash-nav regression)", () => {
  const query = "newer_than:2d in:inbox";
  const hash = "#search/" + encodeURIComponent(query);
  it("derives the query from the URL hash when the search box is empty", async () => {
    // Real Gmail hash-nav: search box blank. Pre-fix inbox.query was "" and validateInbox threw.
    const inbox = await runInboxFn("", hash);
    expect(inbox.query).toBe(query);
    expect(() => validateInbox({ ...makeInbox(), query: inbox.query })).not.toThrow();
  });
  it("still prefers a populated search box", async () => {
    const inbox = await runInboxFn("newer_than:2d in:inbox ", "#search/other");
    expect(inbox.query.trim()).toBe(query);
  });
});

// Regression for the sep15 empty-DOM render race: a transient not-rendered inbox
// (0 rows AND no range chrome — the real 19:00/19:30 shape) must classify as its own
// retryable INBOX_NOT_RENDERED category, NOT be conflated with a real pagination
// overflow. A genuine overflow ("1–50 de 1,048", 49 rendered) stays PAGINATION_INCOMPLETE
// and fails fast. Reverting the split re-collapses both to PAGINATION_INCOMPLETE.
describe("Gmail empty-DOM vs pagination classification (sep15 render-race regression)", () => {
  const catFor = (inbox: unknown) => {
    try { validateInbox(inbox as never); return null; }
    catch (error) { return failureCategory(error); }
  };
  it("classifies an empty-DOM race as retryable INBOX_NOT_RENDERED", () => {
    expect(catFor({ authenticated: true, query: "newer_than:2d in:inbox", range: undefined, rows: [] }))
      .toBe("INBOX_NOT_RENDERED");
  });
  it("classifies a real pagination overflow (with thousands separator) as PAGINATION_OVERFLOW", () => {
    // The live helper splits the legacy PAGINATION_INCOMPLETE umbrella: a parsed total
    // greater than the shown end ("1–50 de 1,048", 49 rendered) is a genuine overflow and
    // fails fast as PAGINATION_OVERFLOW (still not retried).
    const overflow = { authenticated: true, query: "newer_than:2d in:inbox", range: "1–50 de 1,048",
      rows: new Array(49).fill(0).map((_, i) => ({ subject: "s" + i, sender: "x", date: "d", threadId: "a" + i, messageId: "b" + i })) };
    expect(catFor(overflow)).toBe("PAGINATION_OVERFLOW");
  });
});

// Regression for the sep17 self-induced target flap: the reader drove the SHARED default
// browser profile and threw BROWSER_TARGET_UNAVAILABLE whenever its own prior close left
// the next `open` with no suggestedTargetId/tabId (deterministic every-`:00`-fail flap).
// acquireInboxTarget must (a) reuse an existing authenticated Gmail tab and (b) retry the
// open before failing hard, but still throw when NO target is ever obtainable.
describe("Gmail target acquisition resilience (sep17 flap regression)", () => {
  const noSleep = () => {};
  it("reuses an existing authenticated Gmail tab when the first open yields no target", () => {
    const calls: string[][] = [];
    const browserCall = vi.fn((args: string[]) => {
      calls.push(args);
      if (args[0] === "open") return {}; // empty open: no suggestedTargetId/tabId (the flap)
      if (args[0] === "tabs") return { tabs: [{ url: "https://mail.google.com/mail/u/0/#search/x", suggestedTargetId: "reused-tab" }] };
      return { ok: true };
    });
    const target = acquireInboxTarget(browserCall, "https://mail.google.com/mail/u/0/#inbox", { attempts: 3, sleep: noSleep });
    expect(target).toBe("reused-tab");
    // Reuse succeeds on the FIRST attempt via tabs; open must have been tried, tabs consulted.
    expect(calls.map(c => c[0])).toEqual(["open", "tabs"]);
  });

  it("retries the open and succeeds on a later attempt", () => {
    let openCount = 0;
    const browserCall = vi.fn((args: string[]) => {
      if (args[0] === "open") { openCount++; return openCount >= 2 ? { suggestedTargetId: "late-tab" } : {}; }
      if (args[0] === "tabs") return { tabs: [] }; // no reusable tab, forces the retry path
      return { ok: true };
    });
    const target = acquireInboxTarget(browserCall, "https://mail.google.com/mail/u/0/#inbox", { attempts: 3, sleep: noSleep });
    expect(target).toBe("late-tab");
    expect(openCount).toBe(2);
  });

  it("still fails hard with BROWSER_TARGET_UNAVAILABLE when no target is ever obtainable", () => {
    const browserCall = vi.fn((args: string[]) => (args[0] === "tabs" ? { tabs: [] } : {}));
    let category: string | null = null;
    try { acquireInboxTarget(browserCall, "https://mail.google.com/mail/u/0/#inbox", { attempts: 3, sleep: noSleep }); }
    catch (error) { category = failureCategory(error); }
    expect(category).toBe("BROWSER_TARGET_UNAVAILABLE");
  });
});

describe("Gmail browser read receipt", () => {
  it.each(["authentication", "pagination", "identity"])("fails closed on incomplete %s", (boundary) => {
    const inbox = makeInbox();
    if (boundary === "authentication") inbox.authenticated = false;
    if (boundary === "pagination") inbox.range = "1–1 de 2";
    if (boundary === "identity") inbox.rows[0].messageId = "";
    expect(() => validateInbox(inbox)).toThrow();
  });

  // Back-to-back reliability: two consecutive full runs, where the SECOND run's first
  // `open` returns no target (the exact self-induced flap after the first run's close).
  // Pre-fix the second run threw BROWSER_TARGET_UNAVAILABLE; with resilient acquisition it
  // reuses the still-open Gmail tab and completes. Both receipts must be written.
  it("completes two consecutive runs even when the second open yields no target", () => {
    const runReceipt = (openBehavior: "target" | "empty") => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-receipt-b2b-"));
      roots.push(root);
      const dedupePath = path.join(root, "seen.txt");
      fs.writeFileSync(dedupePath, "existing notification key\n");
      const artifactDir = path.join(root, "proof");
      let reads = 0;
      const browserCall = vi.fn((args: string[]) => {
        if (args[0] === "open") return openBehavior === "target" ? { suggestedTargetId: "b2b-tab" } : {};
        if (args[0] === "tabs") return { tabs: [{ url: "https://mail.google.com/mail/u/0/#inbox", suggestedTargetId: "b2b-tab" }] };
        if (args[0] !== "evaluate") return { ok: true };
        reads++;
        if (reads === 2) return { ok: true, result: { subject: "Example", messageId: "def456", body: "Latest message content" } };
        return { ok: true, result: makeInbox() };
      });
      return runMailboxCheck({ artifactDir, dedupePath, browserCall });
    };
    const first = runReceipt("target");
    const second = runReceipt("empty"); // second run's open yields no target -> must reuse tab, not throw
    expect(first).toMatchObject({ complete: true, checkedCount: 1 });
    expect(second).toMatchObject({ complete: true, checkedCount: 1 });
  });

  it.each(["complete", "missing-body", "changed-mailbox"])("records only a %s check and never consumes alerts", (outcome) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-receipt-test-"));
    roots.push(root);
    const dedupePath = path.join(root, "seen.txt");
    fs.writeFileSync(dedupePath, "existing notification key\n");
    const artifactDir = path.join(root, "proof");
    let reads = 0;
    const browserCall = vi.fn((args: string[]) => {
      if (args[0] === "open") return { suggestedTargetId: "test-tab" };
      if (args[0] !== "evaluate") return { ok: true };
      reads++;
      if (reads === 2) return { ok: true, result: { subject: "Example", messageId: "def456", body: outcome === "missing-body" ? "" : "Latest message content" } };
      const inbox = makeInbox();
      if (reads === 3 && outcome === "changed-mailbox") inbox.rows[0].messageId = "ffff";
      return { ok: true, result: inbox };
    });
    if (outcome === "missing-body") {
      // A missing/empty latest-message body is a hard identity failure: no receipt.
      expect(() => runMailboxCheck({ artifactDir, dedupePath, browserCall })).toThrow();
      expect(fs.existsSync(path.join(artifactDir, "receipt.json"))).toBe(false);
    } else {
      // Both "complete" and a benign post-read "changed-mailbox" produce a receipt: the
      // live helper records a change during the ~minute of navigation as mailboxStable:false
      // (dedupe untouched), NOT a thrown read — every targeted body was already verified.
      const receipt = runMailboxCheck({ artifactDir, dedupePath, browserCall });
      expect(receipt).toMatchObject({ complete: true, checkedCount: 1, readKeys: ["abc123:def456"], sentMail: false, sentMessages: false, notificationDedupeAdvanced: false });
      expect(receipt.mailboxStable).toBe(outcome === "complete");
      expect(fs.existsSync(path.join(artifactDir, "receipt.json"))).toBe(true);
    }
    expect(fs.readFileSync(dedupePath, "utf8")).toBe("existing notification key\n");
    expect(browserCall).toHaveBeenLastCalledWith(["close", "test-tab"]);
    expect(browserCall.mock.calls.every(([args]) => ["open", "tabs", "navigate", "evaluate", "close"].includes(args[0]))).toBe(true);
  });
});
