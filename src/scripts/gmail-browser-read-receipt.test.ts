import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failureCategory, inboxFn, runMailboxCheck, validateInbox } from "../../scripts/gmail-browser-read-receipt.mjs";

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
  it("keeps a real pagination overflow (with thousands separator) as PAGINATION_INCOMPLETE", () => {
    const overflow = { authenticated: true, query: "newer_than:2d in:inbox", range: "1–50 de 1,048",
      rows: new Array(49).fill(0).map((_, i) => ({ subject: "s" + i, sender: "x", date: "d", threadId: "a" + i, messageId: "b" + i })) };
    expect(catFor(overflow)).toBe("PAGINATION_INCOMPLETE");
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
    expect(browserCall.mock.calls.every(([args]) => ["open", "navigate", "evaluate", "close"].includes(args[0]))).toBe(true);
  });
});
