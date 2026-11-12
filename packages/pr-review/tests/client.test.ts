import { test, expect, mock, beforeEach } from "bun:test";

let stored = new Map<string, any>(), requests = new Map<string, any>(), calls: any[] = [];
let tabList: any[] = [], paneList: any[] = [], malformed = false;
let helperReplies = new Map<string, any>(), viewProps: any = {}, activeCx: any, closed = 0, overlays: any[] = [];
let failCommand: null | ((name: string, args: any) => boolean) = null;
let commandReaders: ((name: string) => void)[] = [];
const theme = new Proxy({}, { get: () => "#888888" });
function element(type = "div") {
  const node: any = { type, children: [], handlers: {} };
  let proxy: any;
  proxy = new Proxy({}, { get: (_target, method) => {
    if (method === "node") return node;
    if (method === "then") return undefined;
    return (...args: any[]) => {
      if (method === "child") node.children.push(args[0]?.node ?? args[0]);
      else if (method === "children") node.children.push(...args[0].map((child: any) => child?.node ?? child));
      else if (method === "when") { if (args[0]) args[1](proxy); }
      else if (method === "id") node.id = args[0];
      else if (method === "on_key_down") node.handlers.keyDown = args[0];
      else if (method === "on_action") node.handlers[args[0]] = args[1];
      return proxy;
    };
  } });
  return proxy;
}
function input(options: any = {}) {
  let value = options.value ?? ""; const events: any = {};
  return { value: () => value, set_value: (next: string) => { value = next; events.change?.({}, activeCx); },
    on: (name: string, callback: any) => { events[name] = callback; }, focus: () => events.focus?.({}, activeCx) };
}
function context() {
  const errors: any[] = [], timers: any[] = [];
  const cx: any = { errors, timers, notify() {}, stop_propagation() {}, bind_keys() {},
    focus_handle: () => ({ focused: false, focus() { this.focused = true; }, is_focused() { return this.focused; } }),
    spawn: (callback: any) => { callback(cx).catch((error: any) => errors.push(error)); },
    timer: { after: (_ms: number, callback: any) => timers.push(callback), every() {} } };
  activeCx = cx; return cx;
}
function defer() { let resolve: any; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let n = 0; n < 50 && !check(); n++) await Bun.sleep(1); expect(check()).toBe(true); }
function nodes(node: any): any[] { return [node, ...(node?.children ?? []).flatMap((child: any) => typeof child === "object" ? nodes(child) : [])]; }
mock.module("gpui-kit", () => ({ div: () => element(), svg: () => element("svg"), View: class {} }));
mock.module("gpui-base", () => ({
  h_flex: () => element(), v_flex: () => element(), Button: { new: () => element("button") },
  InputState: { new: input }, TextareaState: { new: input },
  Input: { new: () => element("input") }, Textarea: { new: () => element("textarea") },
  Radio: { new: () => element("radio") }, RadioGroup: { new: () => element("radio-group") },
  TextView: { markdown: () => element("markdown") },
  ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, Scrollbar: { vertical: () => element() },
}));
const repo = { key: "github.com/owner/repo", nameWithOwner: "owner/repo" };
const target = { key: "target", headOid: "abc", checkout: "/owned/pr-22" };

mock.module("herdr", () => ({
  appHome: () => "/app", props: () => viewProps, theme: () => theme, settings: () => ({}),
  nextCommand: () => new Promise(resolve => commandReaders.push(resolve)), openOverlay: (value: any) => overlays.push(value), closeOverlay: () => { closed++; },
  spaces: () => [{ id: "space", active: true, folder: "/repo", tabs: tabList }],
  panes: () => paneList,
  shared: (key: string) => stored.get(key),
  setShared: (key: string, value: any) => stored.set(key, value),
  readTextFile: async () => JSON.stringify({ cli: "/installed/herdr-app", home: "/app" }),
  writeTextFile: async (path: string, text: string) => { requests.set(path, JSON.parse(text)); },
  exec: async (program: string, args: string[]) => {
    calls.push({ program, args });
    if (program.endsWith("/herdr-pr")) {
      const request = requests.get(args[args.indexOf("--request") + 1]);
      if (malformed) return { code: 0, stdout: '{"ok":true,"data":', stderr: "" };
      const reply = helperReplies.has(request.op) ? helperReplies.get(request.op) : request.op === "git.prepare" ? { target } : undefined;
      if (reply === undefined) throw new Error("Unexpected helper operation: " + request.op);
      const data = typeof reply === "function" ? await reply(request) : await reply;
      return { code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: "" };
    }
    const name = args[1], fields = JSON.parse(args[2]);
    if (failCommand?.(name, fields)) return { code: 1, stdout: JSON.stringify({ error: "Temporary layout failure" }), stderr: "" };
    if (name === "tab.new") {
      expect(fields.argv).toBeUndefined();
      expect(fields.folder).toBe(target.checkout);
      tabList.push({ id: "real-tab", name: fields.name });
      paneList.push({ pane: "terminal-pane", tab: "real-tab", terminal: "terminal-address" });
      return { code: 0, stdout: JSON.stringify({ space: "space", tab: "real-tab", terminal: "terminal-address" }), stderr: "" };
    }
    if (name === "pane.split") {
      expect(fields.pane).toBe("terminal-pane");
      paneList.push({ pane: "review-pane", tab: "real-tab", mod: "pull-requests" });
      return { code: 0, stdout: JSON.stringify({ pane: "review-pane" }), stderr: "" };
    }
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  },
}));
const { openPullRequest, helper, currentDraft } = await import("../mods/pull-requests/client.js");
const cx = { timer: { after: (_ms: number, callback: () => void) => callback() } };
beforeEach(() => { stored = new Map(); requests = new Map(); calls = []; tabList = []; paneList = []; malformed = false; helperReplies = new Map(); viewProps = {}; closed = 0; overlays = []; failCommand = null; commandReaders = []; });

test("creates and then reuses the acknowledged tab, ignoring an unrelated matching title", async () => {
  tabList.push({ id: "unrelated", name: "#22 same title" });
  const pr = { number: 22, title: "same title" };
  const first = await openPullRequest(repo, pr, { id: "space" }, cx);
  expect(first.tab).toBe("real-tab");
  expect(first.reviewPane).toBe("review-pane");
  const second = await openPullRequest(repo, pr, { id: "space" }, cx);
  expect(second.tab).toBe("real-tab");
  expect(calls.filter(call => call.args[1] === "tab.new")).toHaveLength(1);
  expect(calls.filter(call => call.args[1] === "tab.select")[0].args[2]).toBe('{"id":"real-tab"}');
});

test("coalesces concurrent clicks into one checkout and tab operation", async () => {
  await Promise.all([openPullRequest(repo, { number: 22, title: "PR" }, { id: "space" }, cx), openPullRequest(repo, { number: 22, title: "PR" }, { id: "space" }, cx)]);
  expect(calls.filter(call => call.args[1] === "tab.new")).toHaveLength(1);
});

test("repairs an interrupted opening without creating a second tab", async () => {
  tabList.push({ id: "real-tab", name: "renamed by user" });
  paneList.push({ pane: "terminal-pane", tab: "real-tab", terminal: "terminal-address" });
  stored.set("pull-requests.session.local:github.com/owner/repo#22", { tab: "real-tab", terminal: "terminal-address", target });
  const result = await openPullRequest(repo, { number: 22, title: "PR" }, { id: "space" }, cx);
  expect(result.reviewPane).toBe("review-pane");
  expect(calls.some(call => call.args[1] === "tab.new")).toBe(false);
});

test("rejects incomplete helper output and keeps request text out of command arguments", async () => {
  malformed = true;
  const body = "$(touch /do-not-run) body";
  await expect(helper("git.prepare", { body })).rejects.toThrow("incomplete");
  const call = calls[0];
  expect(call.args.join(" ")).not.toContain(body);
  expect([...requests.values()][0].body).toBe(body);
});

test("keeps one durable active draft reference until an explicit new draft", () => {
  const first = currentDraft(repo, 22, target.key);
  expect(currentDraft(repo, 22, target.key)).toBe(first);
  expect(currentDraft(repo, 22, target.key, true)).not.toBe(first);
});


const { default: Review } = await import("../mods/pull-requests/review.js");
const { default: Compose } = await import("../mods/pull-requests/compose.js");
function reviewReplies() {
  helperReplies.set("draft.get", { draft: {}, attempt: null });
  helperReplies.set("draft.save", { draft: {}, attempt: null });
  helperReplies.set("git.files", { files: [{ path: "a.rs", status: "M", added: 1, removed: 1 }], nextCursor: null });
  helperReplies.set("git.status", { owned: true, matchesPinned: true });
  helperReplies.set("github.pr", { number: 22, title: "PR", headOid: "head", baseOid: "base", checksSummary: {} });
  for (const name of ["checks", "reviews", "threads"]) helperReplies.set("github." + name, { items: [], pageInfo: { hasNextPage: false } });
}

test("review keyboard handler remains callable after loading a durable draft", async () => {
  reviewReplies();
  helperReplies.set("git.diff", { rows: [{ kind: "@", text: "hunk" }, { kind: "+", next: 1, old: null, text: "first" }, { kind: "+", next: 2, old: null, text: "second" }], nextCursor: null });
  viewProps = { repo, number: 22, target: { ...target, headOid: "head", baseOid: "base" } };
  const cx = context(), review = new Review();
  review.init(viewProps, cx); await until(() => !review.initialLoading);
  review.changeView("changes", cx); await until(() => review.rows.length === 3);
  const rendered = review.render().node;
  rendered.handlers.keyDown({ key: "j", keystroke: "j", modifiers: { shift: false } }, cx);
  expect(review.cursor).toBe(2);
  expect(typeof review.navKey).toBe("function");
  expect(typeof review.draftKey).toBe("string");
  expect(cx.errors).toEqual([]);
});

test("a stale diff response releases its own loading state and cannot block the new target", async () => {
  reviewReplies();
  const old = defer();
  helperReplies.set("git.diff", (request: any) => request.target.key === "old"
    ? old.promise : { rows: [{ kind: "+", next: 2, text: "new target" }], nextCursor: null });
  viewProps = { repo, number: 22, target: { ...target, key: "old" } };
  const cx = context(), review = new Review();
  review.init(viewProps, cx); await until(() => !review.initialLoading);
  review.pickFile(0, cx); await until(() => requests.size > 5 && Boolean(review.loading["diff:old:a.rs"]));
  review.target = { ...target, key: "new" }; review.diffs = {};
  review.pickFile(0, cx); await until(() => review.rows[0]?.text === "new target");
  old.resolve({ rows: [{ kind: "+", next: 1, text: "old target" }], nextCursor: null });
  await until(() => !review.loading["diff:old:a.rs"]);
  expect(review.rows[0].text).toBe("new target");
  expect(review.loading["diff:new:a.rs"]).toBeUndefined();
});

test("choosing a review type before the draft arrives preserves the user's choice", async () => {
  const incoming = defer(); helperReplies.set("draft.get", incoming.promise);
  viewProps = { key: "draft", repo, number: 22, comparisonKey: target.key, headOid: "head", title: "PR", draft: {} };
  const cx = context(), compose = new Compose();
  compose.init(viewProps, cx); compose.choose("REQUEST_CHANGES", cx);
  incoming.resolve({ draft: { event: "APPROVE", body: "old" }, attempt: null });
  await until(() => !compose.loading);
  expect(compose.event).toBe("REQUEST_CHANGES");
});

test("sending a review removes the editable field and ignores repeated submit", async () => {
  helperReplies.set("draft.get", { draft: { body: "review text" }, attempt: null });
  helperReplies.set("draft.save", {});
  const reply = defer(); helperReplies.set("review.submit", reply.promise);
  viewProps = { key: "draft", repo, number: 22, comparisonKey: target.key, headOid: "head", baseOid: "base", title: "PR", draft: { body: "review text" } };
  const cx = context(), compose = new Compose();
  compose.init(viewProps, cx); await until(() => !compose.loading);
  compose.submit(cx); compose.submit(cx);
  await until(() => [...requests.values()].some(request => request.op === "review.submit"));
  expect(nodes(compose.render().node).filter(node => node.type === "textarea")).toHaveLength(0);
  expect([...requests.values()].filter(request => request.op === "review.submit")).toHaveLength(1);
  expect(compose.handle.is_focused()).toBe(true);
  reply.resolve({ state: "confirmed", reviewId: "review" });
  await until(() => closed === 1);
  expect(compose.sent).toBe(true);
});


test("unavailable overview collections never appear as zero approvals or zero threads", async () => {
  reviewReplies();
  for (const name of ["checks", "reviews", "threads"]) helperReplies.set("github." + name, () => { throw new Error("Unavailable"); });
  viewProps = { repo, number: 22, target: { ...target, headOid: "head", baseOid: "base" } };
  const cx = context(), review = new Review();
  review.init(viewProps, cx); await until(() => Boolean(review.errors.threads && review.errors.reviews && review.errors.checks));
  const text = nodes(review.render().node).flatMap(node => node.children ?? []).filter(child => typeof child === "string").join(" ");
  expect(text).toContain("Unavailable");
  expect(text).toContain("Required checks unavailable");
  expect(text).not.toContain("0 approved");
  expect(text).not.toContain("0 resolved");
});

test("confirmed publishing immediately opens a new draft without reusing published comments", async () => {
  reviewReplies();
  const drafts = new Map<string, any>(), oldKey = currentDraft(repo, 22, target.key);
  const old = { path: "a.rs", body: "published comment", thread: { path: "a.rs", side: "RIGHT", line: 1, body: "published comment" } };
  drafts.set(oldKey, { body: "submitted summary", notes: [old], threads: [old.thread] });
  helperReplies.set("draft.get", (request: any) => ({ draft: drafts.get(request.key) ?? null, attempt: null }));
  helperReplies.set("draft.save", (request: any) => { drafts.set(request.key, { ...(drafts.get(request.key) ?? {}), ...request.draft }); return {}; });
  viewProps = { repo, number: 22, target: { ...target, headOid: "head", baseOid: "base" } };
  const cx = context(), review = new Review();
  review.init(viewProps, cx); await until(() => !review.initialLoading);
  viewProps = { key: oldKey, repo, number: 22, comparisonKey: target.key, headOid: "head", title: "PR", draft: drafts.get(oldKey) };
  const compose = new Compose(); compose.init(viewProps, cx); await until(() => !compose.loading);
  await compose.confirmed({ state: "confirmed", reviewId: "published" });
  review.file = 0; review.rows = [{ kind: "+", old: null, next: 1, text: "code" }];
  review.selection = { anchor: 0, end: 0 }; review.comment.set_value("next review comment");
  review.addComment(cx);
  expect(review.draftKey).not.toBe(oldKey);
  expect(review.notes.map((note: any) => note.body)).toEqual(["next review comment"]);
  review.review(cx); await until(() => overlays.length === 1);
  expect(overlays[0].props.key).toBe(review.draftKey);
  expect(overlays[0].props.draft.body).toBeUndefined();
  expect(overlays[0].props.draft.threads).toEqual([{ path: "a.rs", side: "RIGHT", line: 1, body: "next review comment" }]);
});

test("a hydrated confirmed receipt never exposes an editable or sendable composer", async () => {
  const key = currentDraft(repo, 22, target.key);
  helperReplies.set("draft.get", { draft: { body: "already published" }, attempt: { state: "confirmed", reviewId: "published" } });
  helperReplies.set("draft.save", {});
  viewProps = { key, repo, number: 22, comparisonKey: target.key, headOid: "head", title: "PR", draft: { body: "already published" } };
  const cx = context(), compose = new Compose();
  compose.init(viewProps, cx);
  expect(nodes(compose.render().node).some(node => node.type === "textarea")).toBe(false);
  await until(() => closed === 1);
  compose.submit(cx);
  expect(compose.sent).toBe(true);
  expect(nodes(compose.render().node).some(node => node.type === "textarea")).toBe(false);
  expect([...requests.values()].some(request => request.op === "review.submit")).toBe(false);
});

test("draft writes are serialized so a slow earlier save cannot overwrite newer text", async () => {
  helperReplies.set("draft.get", { draft: {}, attempt: null });
  const first = defer(), saved: string[] = [];
  helperReplies.set("draft.save", (request: any) => {
    saved.push(request.draft.body);
    return saved.length === 1 ? first.promise : {};
  });
  viewProps = { key: "draft", repo, number: 22, comparisonKey: target.key, headOid: "head", title: "PR", draft: {} };
  const cx = context(), compose = new Compose(); compose.init(viewProps, cx); await until(() => !compose.loading);
  compose.body.set_value("first"); const earlier = compose.persist();
  compose.body.set_value("second"); const later = compose.persist();
  await until(() => saved.length === 1); expect(saved).toEqual(["first"]);
  first.resolve({}); await Promise.all([earlier, later]);
  expect(saved).toEqual(["first", "second"]);
});


test("a failed swap resumes the acknowledged split instead of creating another pane", async () => {
  failCommand = name => name === "pane.swap";
  await expect(openPullRequest(repo, { number: 22, title: "PR" }, { id: "space" }, cx)).rejects.toThrow("Temporary");
  const partial = stored.get("pull-requests.session.local:github.com/owner/repo#22");
  expect(partial.reviewPane).toBe("review-pane");
  expect(partial.setupStage).toBe("split");
  failCommand = null;
  const ready = await openPullRequest(repo, { number: 22, title: "PR" }, { id: "space" }, cx);
  expect(ready.setupStage).toBe("ready");
  expect(calls.filter(call => call.args[1] === "pane.split")).toHaveLength(1);
});

test("a failed terminal resize resumes sizing without swapping the panes back", async () => {
  failCommand = (name, args) => name === "layout.resize" && args.id === "terminal-pane";
  await expect(openPullRequest(repo, { number: 22, title: "PR" }, { id: "space" }, cx)).rejects.toThrow("Temporary");
  expect(stored.get("pull-requests.session.local:github.com/owner/repo#22").setupStage).toBe("review-sized");
  failCommand = null;
  const ready = await openPullRequest(repo, { number: 22, title: "PR" }, { id: "space" }, cx);
  expect(ready.setupStage).toBe("ready");
  expect(calls.filter(call => call.args[1] === "pane.split")).toHaveLength(1);
  expect(calls.filter(call => call.args[1] === "pane.swap")).toHaveLength(1);
});

test("a base-only update keeps old LEFT-side drafts separate and publishes no old anchors", async () => {
  reviewReplies();
  const previous = { ...target, key: "old-base:head:merge-one", headOid: "head", baseOid: "base", mergeBase: "merge-one" };
  const next = { ...previous, key: "new-base:head:merge-two", baseOid: "new-base", mergeBase: "merge-two" };
  const oldKey = currentDraft(repo, 22, previous.key), drafts = new Map<string, any>();
  const oldThread = { path: "a.rs", side: "LEFT", line: 11, body: "old base comment" };
  drafts.set(oldKey, { body: "old comparison summary", notes: [{ path: "a.rs", body: oldThread.body, thread: oldThread }],
    threads: [oldThread], inlineDrafts: { "a.rs": { body: "unfinished old comment", selection: { anchor: 0, end: 0 } } } });
  helperReplies.set("draft.get", (request: any) => ({ draft: drafts.get(request.key) ?? null, attempt: null }));
  helperReplies.set("draft.save", (request: any) => { drafts.set(request.key, { ...(drafts.get(request.key) ?? {}), ...request.draft }); return {}; });
  helperReplies.set("git.update", { target: next, checkoutStatus: { owned: true, matchesPinned: true } });
  helperReplies.set("review.submit", { state: "confirmed", reviewId: "new-review" });
  stored.set("pull-requests.session.local:github.com/owner/repo#22", { tab: "real-tab", terminal: "terminal-address", target: previous });
  viewProps = { repo, number: 22, target: previous };
  const runtime = context();
  const review = new Review(); review.init(viewProps, runtime); await until(() => !review.initialLoading);
  expect(review.notes).toHaveLength(1);
  const files = defer(); helperReplies.set("git.files", files.promise);
  review.pr.baseOid = "new-base";
  helperReplies.set("github.pr", { ...review.pr });
  review.update(runtime); await until(() => review.target.key === next.key);
  review.render();
  expect(review.draftKey).not.toBe(oldKey);
  expect(review.notes).toEqual([]);
  expect(review.draft.inlineDrafts).toEqual({});
  expect(stored.get("pull-requests.session.local:github.com/owner/repo#22").target.key).toBe(next.key);
  files.resolve({ files: [{ path: "a.rs", status: "M", added: 1, removed: 1 }], nextCursor: null });
  await until(() => !review.initialLoading);
  expect(drafts.get(oldKey).threads).toEqual([oldThread]);
  review.review(runtime); await until(() => overlays.length === 1);
  expect(overlays[0].props.comparisonKey).toBe(next.key);
  viewProps = overlays[0].props;
  const compose = new Compose(); compose.init(viewProps, runtime); await until(() => !compose.loading);
  compose.body.set_value("fresh review"); compose.submit(runtime); await until(() => compose.sent);
  const submission = [...requests.values()].find(request => request.op === "review.submit");
  expect(submission.threads).toEqual([]);
  expect(submission.baseOid).toBe("new-base");
  expect(submission.key).not.toBe(oldKey);
});

test("an owned review restores the updated session comparison after its persisted pane reloads", async () => {
  reviewReplies();
  const previous = { ...target, key: "previous-base:head", headOid: "head", baseOid: "base" };
  const updated = { ...previous, key: "updated-base:head", baseOid: "updated-base" };
  const identity = "local:github.com/owner/repo#22";
  stored.set("pull-requests.session." + identity, { tab: "real-tab", reviewPane: "review-pane", target: updated });
  viewProps = { repo, number: 22, target: previous, sessionKey: identity };
  const runtime = context(), review = new Review();
  review.init(viewProps, runtime); await until(() => !review.initialLoading);
  expect(review.target.key).toBe(updated.key);
  expect(review.draftKey).toBe(currentDraft(repo, 22, updated.key));
  expect([...requests.values()].find(request => request.op === "git.files").target.key).toBe(updated.key);
});

test("a fast base update clears the old inline editor before draft hydration without a render", async () => {
  reviewReplies();
  const previous = { ...target, key: "base-one:head", headOid: "head", baseOid: "base" };
  const updated = { ...previous, key: "base-two:head", baseOid: "base-two" }, drafts = new Map<string, any>();
  helperReplies.set("draft.get", (request: any) => ({ draft: drafts.get(request.key) ?? null, attempt: null }));
  helperReplies.set("draft.save", (request: any) => { drafts.set(request.key, { ...(drafts.get(request.key) ?? {}), ...request.draft }); return {}; });
  helperReplies.set("git.diff", { rows: [{ kind: "-", old: 11, next: null, text: "old base" }], nextCursor: null });
  helperReplies.set("git.update", { target: updated, checkoutStatus: { owned: true, matchesPinned: true } });
  viewProps = { repo, number: 22, target: previous };
  const runtime = context(), review = new Review();
  review.init(viewProps, runtime); await until(() => !review.initialLoading);
  const oldKey = review.draftKey;
  review.changeView("changes", runtime); await until(() => review.rows.length === 1);
  review.beginComment(runtime); review.comment.set_value("unfinished comment on old base");
  review.pr.baseOid = updated.baseOid; helperReplies.set("github.pr", { ...review.pr });
  review.update(runtime); await until(() => review.target.key === updated.key && !review.initialLoading && !review.updating);
  expect(review.inlinePath).toBeNull();
  expect(review.comment.value()).toBe("");
  expect(drafts.get(oldKey).inlineDrafts["a.rs"].body).toBe("unfinished comment on old base");
  review.pickFile(0, runtime); await review.persist();
  expect(drafts.get(review.draftKey).inlineDrafts).toEqual({});
  review.review(runtime); await until(() => overlays.length === 1);
  expect(overlays[0].props.draft.inlineDrafts).toEqual({});
});

test("local draft reload flushes local notes and per-file editor drafts before reading older persisted data", async () => {
  reviewReplies();
  const drafts = new Map<string, any>();
  helperReplies.set("draft.get", (request: any) => ({ draft: drafts.get(request.key) ?? null, attempt: null }));
  helperReplies.set("draft.save", (request: any) => { drafts.set(request.key, { ...(drafts.get(request.key) ?? {}), ...request.draft }); return {}; });
  helperReplies.set("git.diff", { rows: [{ kind: "+", old: null, next: 1, text: "code" }], nextCursor: null });
  viewProps = { repo, number: 22, target: { ...target, headOid: "head", baseOid: "base" } };
  const runtime = context(), review = new Review();
  review.init(viewProps, runtime); await until(() => !review.initialLoading);
  review.changeView("changes", runtime); await until(() => review.rows.length === 1);
  review.beginComment(runtime); review.comment.set_value("new note"); review.addComment(runtime);
  await review.readDraft();
  expect(review.notes.map((note: any) => note.body)).toEqual(["new note"]);
  review.beginComment(runtime); review.comment.set_value("unfinished draft");
  review.pickFile(0, runtime);
  await review.readDraft();
  expect(review.draft.inlineDrafts["a.rs"].body).toBe("unfinished draft");
  expect(drafts.get(review.draftKey).inlineDrafts["a.rs"].body).toBe("unfinished draft");
});


test("periodic GitHub refresh leaves unsaved local notes alone and never queries draft storage", async () => {
  reviewReplies();
  viewProps = { repo, number: 22, target: { ...target, headOid: "head", baseOid: "base" } };
  const runtime = context(), review = new Review();
  review.init(viewProps, runtime); await until(() => !review.initialLoading);
  review.rows = [{ kind: "+", old: null, next: 1, text: "code" }];
  review.selection = { anchor: 0, end: 0 }; review.comment.set_value("unsaved local note"); review.addComment(runtime);
  const reads = [...requests.values()].filter(request => request.op === "draft.get").length;
  review.refresh(runtime); await until(() => !review.refreshing);
  expect(review.notes.map((note: any) => note.body)).toEqual(["unsaved local note"]);
  expect([...requests.values()].filter(request => request.op === "draft.get")).toHaveLength(reads);
});

test("composer close saves its fields before the detail's next note save and explicit focus reload", async () => {
  reviewReplies();
  const drafts = new Map<string, any>();
  helperReplies.set("draft.get", (request: any) => ({ draft: drafts.get(request.key) ?? null, attempt: null }));
  helperReplies.set("draft.save", (request: any) => { drafts.set(request.key, { ...(drafts.get(request.key) ?? {}), ...request.draft }); return {}; });
  viewProps = { repo, number: 22, target: { ...target, headOid: "head", baseOid: "base" } };
  const runtime = context(), review = new Review();
  review.init(viewProps, runtime); await until(() => !review.initialLoading);
  viewProps = { key: review.draftKey, repo, number: 22, comparisonKey: target.key, headOid: "head", title: "PR", draft: review.draft };
  const compose = new Compose(); compose.init(viewProps, runtime); await until(() => !compose.loading);
  compose.body.set_value("saved review summary"); compose.choose("REQUEST_CHANGES", runtime);
  compose.dismiss(runtime); await until(() => closed === 1);
  review.rows = [{ kind: "+", old: null, next: 1, text: "code" }];
  review.selection = { anchor: 0, end: 0 }; review.comment.set_value("new inline note"); review.addComment(runtime);
  await review.persist();
  expect(drafts.get(review.draftKey).body).toBe("saved review summary");
  expect(drafts.get(review.draftKey).event).toBe("REQUEST_CHANGES");
  const reads = [...requests.values()].filter(request => request.op === "draft.get").length;
  commandReaders[0]("focus");
  await until(() => [...requests.values()].filter(request => request.op === "draft.get").length > reads);
  expect(review.draft.body).toBe("saved review summary");
  expect(review.notes.map((note: any) => note.body)).toEqual(["new inline note"]);
});

test("a delayed detail autosave cannot overwrite a newer composer summary", async () => {
  reviewReplies();
  const key = currentDraft(repo, 22, target.key), drafts = new Map<string, any>([[key, { body: "before", event: "COMMENT" }]]);
  helperReplies.set("draft.get", (request: any) => ({ draft: drafts.get(request.key) ?? null, attempt: null }));
  const delayed = defer(); let detailSave = false;
  helperReplies.set("draft.save", async (request: any) => {
    if ("notes" in request.draft) { detailSave = true; await delayed.promise; }
    drafts.set(request.key, { ...(drafts.get(request.key) ?? {}), ...request.draft });
    return {};
  });
  viewProps = { repo, number: 22, target: { ...target, headOid: "head", baseOid: "base" } };
  const runtime = context(), review = new Review();
  review.init(viewProps, runtime); await until(() => !review.initialLoading);
  viewProps = { key, repo, number: 22, comparisonKey: target.key, headOid: "head", title: "PR", draft: review.draft };
  const compose = new Compose(); compose.init(viewProps, runtime); await until(() => !compose.loading);
  const pending = review.persist(); await until(() => detailSave);
  compose.body.set_value("after"); compose.choose("REQUEST_CHANGES", runtime); await compose.persist();
  delayed.resolve({}); await pending;
  expect(drafts.get(key).body).toBe("after");
  expect(drafts.get(key).event).toBe("REQUEST_CHANGES");
});
