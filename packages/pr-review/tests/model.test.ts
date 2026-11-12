import { describe, test, expect } from "bun:test";
import { collectPages, checksSummary, orderedPrs, reviewDecision, selectionThread } from "../mods/pull-requests/model.js";

describe("complete PR data", () => {
  test("continues through empty pages and retains results beyond the first page", async () => {
    const pages = new Map<any, any>([
      [null, { prs: [{ number: 3 }], pageInfo: { hasNextPage: true, endCursor: "second" } }],
      ["second", { prs: [], pageInfo: { hasNextPage: true, endCursor: "third" } }],
      ["third", { prs: [{ number: 1 }], pageInfo: { hasNextPage: false, endCursor: null } }],
    ]);
    expect(await collectPages(async cursor => pages.get(cursor), "prs")).toEqual([{ number: 3 }, { number: 1 }]);
  });
  test("rejects incomplete or repeating pagination rather than reporting a complete list", async () => {
    await expect(collectPages(async () => ({ items: [], pageInfo: { hasNextPage: true, endCursor: null } }))).rejects.toThrow("next page");
    await expect(collectPages(async () => ({ items: [], nextCursor: "same" }))).rejects.toThrow("repeated");
  });
  test("running checks retain their spinner even when another check has failed", () => {
    expect(checksSummary({ total: 5, passed: 1, failed: 1, running: 1, skipped: 1, unknown: 1 }).status).toBe("running");
    expect(checksSummary({ total: 2, passed: 1, skipped: 1 }).description).toBe("1 passed · 1 skipped");
    expect(checksSummary().status).toBe("neutral");
    expect(checksSummary({ total: 2, failed: 1, unknown: 1 }).status).toBe("failed");
    expect(checksSummary({ total: 1, waiting: 1 }).status).toBe("waiting");
  });
  test("uses GitHub's aggregate review decision without inventing required counts", () => {
    expect(reviewDecision("REVIEW_REQUIRED")).toEqual({ label: "Review required", status: "waiting" });
    expect(reviewDecision(null).status).toBe("neutral");
    expect(reviewDecision("CHANGES_REQUESTED").status).toBe("failed");
  });
  test("orders the actual queue by queue position", () => {
    const prs = [{ number: 99, state: "In queue", queuePosition: 2 }, { number: 2, state: "In queue", queuePosition: 1 }];
    expect(orderedPrs(prs).map(pr => pr.number)).toEqual([2, 99]);
  });
});

describe("review locations", () => {
  const rows = [
    { kind: "@", text: "@@ -10,3 +10,3 @@" },
    { kind: " ", old: 10, next: 10, text: "unchanged" },
    { kind: "-", old: 11, next: null, text: "old" },
    { kind: "+", old: null, next: 11, text: "new" },
    { kind: " ", old: 12, next: 12, text: "context" },
  ];
  test("anchors deleted ranges to immutable old-side line numbers", () => {
    expect(selectionThread(rows, { anchor: 1, end: 2 }, "a file.ts", " remove this ")).toEqual({
      path: "a file.ts", body: "remove this", side: "LEFT", line: 11, startLine: 10, startSide: "LEFT",
    });
  });
  test("anchors added ranges to new-side line numbers", () => {
    expect(selectionThread(rows, { anchor: 4, end: 3 }, "a.ts", "check")).toEqual({
      path: "a.ts", body: "check", side: "RIGHT", line: 12, startLine: 11, startSide: "RIGHT",
    });
  });
  test("refuses mixed-side and cross-hunk selections instead of sending a misleading location", () => {
    expect(() => selectionThread(rows, { anchor: 2, end: 3 }, "a.ts", "check")).toThrow("one side");
    expect(() => selectionThread(rows, { anchor: 0, end: 1 }, "a.ts", "check")).toThrow("one diff hunk");
  });
});
