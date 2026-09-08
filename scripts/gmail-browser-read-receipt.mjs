import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const query = "newer_than:2d in:inbox";
const inboxUrl = "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(query);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const writePrivate = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });

export function validateInbox(inbox) {
  if (!inbox.authenticated || inbox.query?.trim() !== query || !Array.isArray(inbox.rows)) {
    throw new Error("mailbox authentication/query not verified");
  }
  const range = inbox.range?.replace(/\s/g, "").match(/^1[–-](\d+)(?:de|of)(\d+)$/);
  if (!range || Number(range[1]) !== inbox.rows.length || Number(range[2]) !== inbox.rows.length) {
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
  for (let attempt = 0; attempt < 30 && !document.querySelector("tr.zA"); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
  return {
    authenticated: location.origin === "https://mail.google.com" && !!document.querySelector("[role=main]") && !!document.querySelector('a[aria-label*="Google"]'),
    query: document.querySelector("input[name=q]")?.value?.trim() || decodeURIComponent((location.hash.split("#search/")[1] ?? "").replace(/\\+/g, " ")),
    range: document.querySelector(".Dj")?.innerText,
    rows: Array.from(document.querySelectorAll("tr.zA")).map(row => {
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
  const output = execFileSync("openclaw", ["browser", ...args, "--json"], { encoding: "utf8", timeout: 25_000, maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output);
}

export function runMailboxCheck({ artifactDir, dedupePath, browserCall = browser }) {
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const beforeDedupe = fs.readFileSync(dedupePath);
  const opened = browserCall(["open", inboxUrl]);
  const target = opened.suggestedTargetId ?? opened.tabId;
  if (!target) throw new Error("stable browser target unavailable");
  const startedMs = Date.now();
  const evaluate = (fn) => {
    const response = browserCall(["evaluate", "--target-id", target, "--fn", fn]);
    if (response.ok !== true) throw new Error("browser read failed");
    return response.result;
  };
  try {
    const inbox = evaluate(inboxFn);
    const inboxHash = validateInbox(inbox);
    writePrivate(path.join(artifactDir, "inbox.json"), inbox);
    const entries = [];
    for (const [index, row] of inbox.rows.entries()) {
      if (Date.now() - startedMs > 140_000) throw new Error("mailbox read budget exceeded");
      browserCall(["navigate", `https://mail.google.com/mail/u/0/#all/${row.threadId}`, "--target-id", target]);
      const thread = evaluate(`async () => {
        const messageId = ${JSON.stringify(row.messageId)};
        for (let attempt = 0; attempt < 30; attempt++) {
          const message = document.querySelector('[data-legacy-message-id="' + messageId + '"]');
          const body = message?.querySelector(".a3s")?.innerText;
          if (body?.trim()) return {messageId, subject: document.querySelector("h2.hP")?.innerText, body};
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        return {messageId, body: null};
      }`);
      if (thread.messageId !== row.messageId || !thread.body?.trim() || thread.subject?.trim() !== row.subject.trim()) {
        throw new Error("latest message body/identity not verified");
      }
      const bodyPath = path.join(artifactDir, `message-${index + 1}.json`);
      writePrivate(bodyPath, thread);
      entries.push({ ...row, bodyPath, bodySha256: digest(fs.readFileSync(bodyPath)), read: true });
    }
    browserCall(["navigate", inboxUrl, "--target-id", target]);
    const finalInbox = evaluate(inboxFn);
    if (validateInbox(finalInbox) !== inboxHash) throw new Error("mailbox changed during check; retry without advancing dedupe");
    writePrivate(path.join(artifactDir, "inbox-after.json"), finalInbox);
    if (digest(fs.readFileSync(dedupePath)) !== digest(beforeDedupe)) throw new Error("notification dedupe changed concurrently");
    const receipt = {
      schema: "gmail-browser-read-receipt.v1", startedAt, checkedAt: new Date().toISOString(), query,
      complete: true, mailboxAuthenticated: true, checkedCount: entries.length,
      readKeys: entries.map(row => `${row.threadId}:${row.messageId}`),
      inboxRowsSha256: inboxHash, notificationDedupeSha256: digest(beforeDedupe),
      notificationDedupeAdvanced: false, pendingAlertReview: true,
      sentMail: false, sentMessages: false, entries,
    };
    writePrivate(path.join(artifactDir, "receipt.json"), receipt);
    return receipt;
  } finally {
    browserCall(["close", target]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [artifactDir, dedupePath] = process.argv.slice(2);
    if (!artifactDir || !dedupePath) throw new Error("artifact directory and notification dedupe path required");
    const receipt = runMailboxCheck({ artifactDir, dedupePath });
    process.stdout.write(JSON.stringify({ receipt: path.join(artifactDir, "receipt.json"), complete: receipt.complete, checkedCount: receipt.checkedCount }) + "\n");
  } catch {
    process.stderr.write("Gmail check incomplete; no success receipt or notification dedupe advancement.\n");
    process.exitCode = 1;
  }
}
