import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTarget, failureCategory, inboxFn, runMailboxCheck, validateInbox } from "../../scripts/gmail-browser-read-receipt.mjs";

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
  it("keeps a real pagination overflow (with thousands separator) as a real, non-retryable fault", () => {
    const overflow = { authenticated: true, query: "newer_than:2d in:inbox", range: "1–50 de 1,048",
      rows: new Array(49).fill(0).map((_, i) => ({ subject: "s" + i, sender: "x", date: "d", threadId: "a" + i, messageId: "b" + i })) };
    // validateInbox now splits a genuine overflow (parsed total > shown end) into its own
    // PAGINATION_OVERFLOW category (see the overflow branch in validateInbox); it is still a
    // real fault that fails fast, just diagnosed distinctly from the empty-DOM race above.
    expect(catFor(overflow)).toBe("PAGINATION_OVERFLOW");
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

  it.each(["complete", "missing-body"])("records only a %s check and never consumes alerts", (outcome) => {
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
      return { ok: true, result: makeInbox() };
    });
    if (outcome === "complete") {
      const receipt = runMailboxCheck({ artifactDir, dedupePath, browserCall });
      expect(receipt).toMatchObject({ complete: true, checkedCount: 1, readKeys: ["abc123:def456"], sentMail: false, sentMessages: false, notificationDedupeAdvanced: false });
      expect(fs.existsSync(path.join(artifactDir, "receipt.json"))).toBe(true);
    } else {
      expect(() => runMailboxCheck({ artifactDir, dedupePath, browserCall })).toThrow();
      expect(fs.existsSync(path.join(artifactDir, "receipt.json"))).toBe(false);
    }
    expect(fs.readFileSync(dedupePath, "utf8")).toBe("existing notification key\n");
    expect(browserCall).toHaveBeenLastCalledWith(["close", "test-tab"]);
    expect(browserCall.mock.calls.every(([args]) => ["open", "tabs", "navigate", "evaluate", "close"].includes(args[0]))).toBe(true);
  });
});

// Regression for the sep17 receipt flap (beast-reliability-completion-sep17-1358): after
// the reader closes its own tab, the NEXT open() deterministically returned no target on
// the shared profile, so alternating scheduled runs failed BROWSER_TARGET_UNAVAILABLE.
// acquireTarget() must survive an empty open() by reusing an existing authenticated Gmail
// tab and/or retrying, and only throw when the browser is genuinely dead. The instant
// (0ms) sleep keeps these deterministic and fast.
describe("acquireTarget resilience (sep17 receipt-flap regression)", () => {
  const noSleep = () => {};
  it("returns the owned target when open() succeeds on the first try (no tab listing)", () => {
    const browserCall = vi.fn((args: string[]) => (args[0] === "open" ? { suggestedTargetId: "t1" } : {}));
    // acquireTarget now returns { target, owned }; a freshly opened tab is run-owned.
    expect(acquireTarget(browserCall, { sleep: noSleep })).toEqual({ target: "t1", owned: true });
    expect(browserCall).toHaveBeenCalledTimes(1);
    expect(browserCall).toHaveBeenCalledWith(["open", expect.any(String)]);
  });

  it("reuses an existing authenticated Gmail tab when open() returns no target", () => {
    const browserCall = vi.fn((args: string[]) => {
      if (args[0] === "open") return {}; // empty open (the flap condition)
      if (args[0] === "tabs") return { tabs: [
        { url: "https://app.qomplement.com/ui2", tabId: "tX" },
        { url: "https://mail.google.com/mail/u/0/#search/x", suggestedTargetId: "gmail-tab" },
      ] };
      return { ok: true };
    });
    // A reused pre-existing authenticated Gmail tab is NOT run-owned (owned:false),
    // so the caller must not close it in cleanup (close-only-owned-tab semantics).
    expect(acquireTarget(browserCall, { sleep: noSleep })).toEqual({ target: "gmail-tab", owned: false });
    // Reused tab is navigated to the inbox query before it is handed back.
    expect(browserCall).toHaveBeenCalledWith(["navigate", expect.any(String), "--target-id", "gmail-tab"]);
  });

  it("retries open() with backoff and succeeds on a later attempt", () => {
    let opens = 0;
    const browserCall = vi.fn((args: string[]) => {
      if (args[0] === "open") { opens++; return opens >= 2 ? { tabId: "late" } : {}; }
      if (args[0] === "tabs") return { tabs: [] }; // nothing reusable yet
      return { ok: true };
    });
    // A retried open that finally succeeds yields a run-owned tab.
    expect(acquireTarget(browserCall, { attempts: 3, sleep: noSleep })).toEqual({ target: "late", owned: true });
    expect(opens).toBe(2);
  });

  it("throws BROWSER_TARGET_UNAVAILABLE only after all attempts fail", () => {
    const browserCall = vi.fn((args: string[]) => (args[0] === "tabs" ? { tabs: [] } : {}));
    let category: string | null = null;
    try { acquireTarget(browserCall, { attempts: 3, sleep: noSleep }); }
    catch (error) { category = failureCategory(error); }
    expect(category).toBe("BROWSER_TARGET_UNAVAILABLE");
    expect(browserCall.mock.calls.filter(([a]) => a[0] === "open")).toHaveLength(3);
  });
});

// The concrete reproduction the fix must pass: run the whole helper TWICE back-to-back
// against a stub whose SECOND open() returns empty (mimicking the post-close starvation on
// the shared profile). Pre-fix this threw on run 2; post-fix run 2 reuses the Gmail tab
// and completes a real receipt. Both runs must produce a complete receipt.
describe("back-to-back helper runs survive an empty open on the second run", () => {
  it("completes a receipt on both the first and the second consecutive run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-receipt-flap-"));
    roots.push(root);
    const dedupePath = path.join(root, "seen.txt");
    fs.writeFileSync(dedupePath, "existing notification key\n");

    let runIndex = 0;
    const makeBrowserCall = () => {
      let reads = 0;
      let openCount = 0;
      return vi.fn((args: string[]) => {
        if (args[0] === "open") {
          openCount++;
          // On the SECOND helper run, the first open() is empty (post-close starvation).
          if (runIndex === 1 && openCount === 1) return {};
          return { suggestedTargetId: "tab-" + runIndex };
        }
        if (args[0] === "tabs") {
          // A previously authenticated Gmail tab is still around to be reused.
          return { tabs: [{ url: "https://mail.google.com/mail/u/0/#inbox", suggestedTargetId: "tab-" + runIndex }] };
        }
        if (args[0] !== "evaluate") return { ok: true };
        reads++;
        if (reads === 2) return { ok: true, result: { subject: "Example", messageId: "def456", body: "Latest message content" } };
        return { ok: true, result: makeInbox() };
      });
    };

    for (runIndex = 0; runIndex < 2; runIndex++) {
      const artifactDir = path.join(root, "proof-" + runIndex);
      const receipt = runMailboxCheck({ artifactDir, dedupePath, browserCall: makeBrowserCall() });
      expect(receipt).toMatchObject({ complete: true, checkedCount: 1 });
      expect(fs.existsSync(path.join(artifactDir, "receipt.json"))).toBe(true);
    }
  });
});

// close-only-owned-tab invariant (sep17 consolidation): a run that OPENED its own tab must
// close exactly that tab; a run that REUSED a pre-existing authenticated Gmail tab (empty
// open -> tab reuse) must NOT close it, or it would tear down an operator/other-run tab.
describe("close-only-owned-tab cleanup semantics", () => {
  const makeInboxRow = () => ({ ok: true, result: makeInbox() });
  const makeThread = () => ({ ok: true, result: { subject: "Example", messageId: "def456", body: "Latest message content" } });

  it("closes the tab it OPENED (owned) and records owned:true", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-owned-"));
    roots.push(root);
    const dedupePath = path.join(root, "seen.txt");
    fs.writeFileSync(dedupePath, "existing notification key\n");
    let reads = 0;
    const browserCall = vi.fn((args: string[]) => {
      if (args[0] === "open") return { suggestedTargetId: "OWNED-NEW" };
      if (args[0] === "evaluate") { reads++; return reads === 2 ? makeThread() : makeInboxRow(); }
      return { ok: true };
    });
    const artifactDir = path.join(root, "proof");
    const receipt = runMailboxCheck({ artifactDir, dedupePath, browserCall });
    expect(receipt).toMatchObject({ complete: true });
    const closes = browserCall.mock.calls.filter(([a]) => a[0] === "close");
    expect(closes).toHaveLength(1);
    expect(closes[0][0]).toEqual(["close", "OWNED-NEW"]);
    expect(JSON.parse(fs.readFileSync(path.join(artifactDir, "cleanup.json"), "utf8"))).toMatchObject({ closed: true, owned: true });
  });

  it("does NOT close a REUSED pre-existing authenticated tab and records REUSED_TAB_PRESERVED", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-reused-"));
    roots.push(root);
    const dedupePath = path.join(root, "seen.txt");
    fs.writeFileSync(dedupePath, "existing notification key\n");
    let reads = 0;
    const browserCall = vi.fn((args: string[]) => {
      if (args[0] === "open") return {}; // empty open -> reuse path
      if (args[0] === "tabs") return { tabs: [{ url: "https://mail.google.com/mail/u/0/#inbox", suggestedTargetId: "REUSED-PREEXISTING" }] };
      if (args[0] === "evaluate") { reads++; return reads === 2 ? makeThread() : makeInboxRow(); }
      return { ok: true };
    });
    const artifactDir = path.join(root, "proof");
    const receipt = runMailboxCheck({ artifactDir, dedupePath, browserCall });
    expect(receipt).toMatchObject({ complete: true });
    const closes = browserCall.mock.calls.filter(([a]) => a[0] === "close");
    // The reused pre-existing tab must never be closed.
    expect(closes.some(([, id]) => id === "REUSED-PREEXISTING")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(artifactDir, "cleanup.json"), "utf8"))).toMatchObject({ closed: false, owned: false, reason: "REUSED_TAB_PRESERVED" });
  });
});
