import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState, Textarea, TextareaState, TextView, ScrollHandle, Scrollbar } from "gpui-base";
import { props, theme, settings, nextCommand, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { helper, currentDraft, nextDraft, updateSessionTarget, session } from "./client.js";
import { checksSummary, reviewDecision, collectPages, selectionThread, sessionKey } from "./model.js";

function button(id, label, action, t, primary = false) {
  return Button.new(id).h(28).px(9).rounded(5).border_1().border_color(primary ? t.solid : t.border)
    .bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground)
    .text_size(11).hover(s => s.bg(t.hover)).on_click(action).child(label);
}
function icon(status, t, size = 14) {
  if (status === "running") return svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(t.working).spin(900);
  const name = status === "passed" ? "circle-check" : status === "failed" ? "x" : status === "waiting" ? "clock" : "minus";
  return svg("mods/workspace-chrome/" + name + ".svg").size(size).flex_none().text_color(status === "passed" ? t.ansi2 : status === "failed" ? t.ansi1 : status === "waiting" ? t.ansi3 : t.muted);
}

export default class Review {
  init(_p, cx) {
    this.p = props() ?? {}; this.repo = this.p.repo; this.target = this.p.target; this.number = this.p.number;
    if (this.repo && this.p.sessionKey === sessionKey(this.repo, this.number)) this.target = session(this.repo, this.number)?.target ?? this.target;
    this.handle = cx.focus_handle(); this.treeHandle = cx.focus_handle();
    this.diffScroll = ScrollHandle.new(); this.pageScroll = ScrollHandle.new(); this.treeScroll = ScrollHandle.new();
    this.view = "overview"; this.section = "checks"; this.file = 0; this.cursor = 0; this.pageCursor = 0;
    this.pageHeights = {}; this.pageHeight = 500;
    this.files = []; this.rows = []; this.diffs = {}; this.checks = []; this.reviews = []; this.threads = []; this.events = [];
    this.loading = {}; this.loaded = {}; this.errors = {}; this.notes = []; this.folded = new Set(); this.viewed = new Set();
    this.treeOpen = true; this.showThreads = true; this.treeWidth = 190; this.bodySize = { width: 800, height: 580 }; this.gAt = 0;
    this.filter = InputState.new({ placeholder: "Filter files…" }); this.activityFilter = InputState.new({ placeholder: "Filter activity…" });
    this.comment = TextareaState.new({ placeholder: "Write a review comment…", rows: 3 });
    for (const input of [this.filter, this.activityFilter, this.comment]) {
      input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
      input.on("change", (_e, cx) => { if (input === this.comment) this.saveLater(cx); cx.notify(); });
    }
    cx.bind_keys([
      { keystroke: "cmd-enter", action: "pr_detail_review", context: "PRReviewDetail" },
      { keystroke: "cmd-enter", action: "pr_detail_input", context: "PRReviewDetail > Input" },
      { keystroke: "escape", action: "pr_detail_normal", context: "PRReviewDetail > Input" },
    ]);
    if (this.p.mode !== "keys" && this.repo && this.target) {
      this.draftKey = currentDraft(this.repo, this.number, this.target.key);
      this.draftComparison = this.target.key;
      this.loadInitial(cx); cx.timer.every(30000, cx => this.refresh(cx));
    }
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") {
          this.handle.focus();
          if (this.repo && this.target) {
            this.syncDraft();
            cx.spawn(async cx => { try { await this.readDraft(); } catch (e) { this.notice = "Draft could not reload: " + e.message; } cx.notify(); });
            this.refresh(cx);
          }
        }
        else if (command === "refresh") this.refresh(cx);
        else if (command === "view-changes") this.changeView("changes", cx);
        else if (command === "view-activity") this.changeView("activity", cx);
        else if (command === "show-checks") { this.section = "checks"; this.changeView("overview", cx); }
        else if (command === "show-review") this.review(cx);
        else if (command === "file-next") this.pickFile((this.file + 1) % Math.max(1, this.files.length), cx);
        else if (command === "show-keys") this.help();
        else if (command === "filetree-wider") this.resizeTree(25, cx);
        else if (command === "tree-narrower") this.resizeTree(-25, cx);
        cx.notify();
      }
    });
  }

  async readDraft() {
    this.syncDraft();
    this.captureInline();
    if (this.dirty) { await this.persist(); if (this.dirty) return; }
    const key = currentDraft(this.repo, this.number, this.target.key), generation = this.saveGeneration;
    const value = await helper("draft.get", { key });
    if (generation !== this.saveGeneration || key !== currentDraft(this.repo, this.number, this.target.key)) return;
    this.draftKey = key; this.draftComparison = this.target.key;
    this.draft = value.draft ?? {}; this.notes = this.draft.notes ?? []; this.attempt = value.attempt;
    if (this.attempt?.state === "confirmed") {
      await nextDraft(this.repo, this.number, this.target.key, key, this.draft.inlineDrafts ?? {});
      this.syncDraft();
    }
  }
  syncDraft() {
    if (!this.draftKey || !this.target) return;
    const key = currentDraft(this.repo, this.number, this.target.key);
    if (key !== this.draftKey) {
      this.saveGeneration = (this.saveGeneration ?? 0) + 1;
      const sameComparison = this.draftComparison === this.target.key;
      const inlineDrafts = sameComparison ? { ...this.draft?.inlineDrafts } : {};
      this.draftKey = key; this.draftComparison = this.target.key; this.draft = { inlineDrafts }; this.notes = []; this.attempt = null;
      this.dirty = false; this.composerSaved = null;
      if (!sameComparison) { this.inlinePath = null; this.commentTarget = false; this.comment.set_value(""); }
    }
    const saved = shared("pull-requests.draft-saved." + key);
    if (saved && saved.token !== this.composerSaved) {
      this.composerSaved = saved.token;
      this.draft = { ...this.draft, body: saved.body, event: saved.event };
    }
  }
  captureInline() {
    if (!this.inlinePath) return;
    this.draft.inlineDrafts ??= {};
    const previous = this.draft.inlineDrafts[this.inlinePath], body = this.comment.value();
    if (body) {
      if (previous?.body !== body || previous?.selection?.anchor !== this.selection?.anchor || previous?.selection?.end !== this.selection?.end) this.dirty = true;
      this.draft.inlineDrafts[this.inlinePath] = { body, selection: this.selection };
    } else if (previous) { delete this.draft.inlineDrafts[this.inlinePath]; this.dirty = true; }
  }
  snapshot() {
    this.captureInline();
    return { ...this.draft, notes: [...this.notes], threads: this.notes.map(note => note.thread), inlineDrafts: { ...this.draft.inlineDrafts } };
  }
  async persist() {
    this.syncDraft();
    const key = this.draftKey, draft = this.snapshot();
    const generation = this.saveGeneration;
    this.draft = draft;
    const fields = { notes: draft.notes, threads: draft.threads, inlineDrafts: draft.inlineDrafts };
    const pending = (this.saving ?? Promise.resolve()).catch(() => {}).then(() => helper("draft.save", { key, draft: fields }));
    this.saving = pending;
    await pending;
    if (this.draftKey === key && generation === this.saveGeneration) this.dirty = false;
  }
  saveLater(cx) {
    if (!this.draftKey) return;
    const generation = this.saveGeneration = (this.saveGeneration ?? 0) + 1;
    cx.timer.after(300, cx => {
      if (generation !== this.saveGeneration) return;
      cx.spawn(async cx => { try { await this.persist(); } catch (e) { this.notice = "Draft could not be saved: " + e.message; } cx.notify(); });
    });
  }
  async close() { if (this.draftKey) await this.persist(); }
  loadInitial(cx) {
    this.initialLoading = true; this.initialError = null;
    cx.spawn(async cx => {
      try {
        this.files = await collectPages(cursor => helper("git.files", { target: this.target, cursor }), "files");
        await this.readDraft();
        this.pr = await helper("github.pr", { repo: this.repo, number: this.number });
        this.checkout = await helper("git.status", { target: this.target });
        this.viewed = new Set(shared("pull-requests.viewed." + this.target.key) ?? []);
        this.folded = new Set(this.files.flatMap((file, index) => this.viewed.has(file.path) ? [index] : []));
      } catch (e) { this.initialError = e.message; }
      this.initialLoading = false;
      if (this.pr) for (const name of ["checks", "reviews", "threads"]) this.loadSection(name, cx);
      cx.notify();
    });
  }
  loadSection(name, cx) {
    if (this.loading[name]) return;
    this.loading[name] = true;
    cx.spawn(async cx => {
      try {
        const items = await collectPages(cursor => helper("github." + name, { repo: this.repo, number: this.number, cursor }));
        if (name === "activity") this.events = items; else this[name] = items;
        this.loaded[name] = true;
        delete this.errors[name];
      } catch (e) { this.errors[name] = e.message; }
      this.loading[name] = false; cx.notify();
    });
  }
  refresh(cx) {
    if (this.refreshing || this.initialLoading) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        this.pr = await helper("github.pr", { repo: this.repo, number: this.number });
        this.checkout = await helper("git.status", { target: this.target });
        this.notice = null;
      } catch (e) { this.notice = "Refresh failed: " + e.message; }
      this.refreshing = false;
      for (const name of ["checks", "reviews", "threads", ...(this.view === "activity" ? ["activity"] : [])]) this.loadSection(name, cx);
      cx.notify();
    });
  }
  changeView(view, cx) {
    this.view = view; this.pageCursor = 0; this.pageKey = null;
    if (view === "changes") this.pickFile(this.file, cx);
    if (view === "activity" && !this.events.length) this.loadSection("activity", cx);
    cx.notify();
  }
  pickFile(index, cx) {
    if (!this.files.length) return;
    this.captureInline(); this.inlinePath = null; this.comment.set_value("");
    this.file = Math.max(0, Math.min(this.files.length - 1, index)); this.cursor = 0; this.selection = null; this.visual = false;
    this.folded.delete(this.file); this.commentTarget = false;
    const path = this.files[this.file].path;
    this.rows = this.diffs[path] ?? [];
    const visible = this.visibleFiles().indexOf(this.file);
    if (visible >= 0) this.treeScroll.scroll_to_item(visible + 1);
    const target = this.target;
    const loadingKey = "diff:" + target.key + ":" + path;
    if (this.diffs[path] || this.loading[loadingKey]) { cx.notify(); return; }
    this.loading[loadingKey] = true; delete this.errors.diff;
    cx.spawn(async cx => {
      try {
        const rows = await collectPages(cursor => helper("git.diff", { target, file: path, cursor }), "rows");
        if (target.key !== this.target.key) return;
        this.diffs[path] = rows;
        if (this.files[this.file]?.path === path) { this.rows = rows; this.cursor = Math.max(0, rows.findIndex(row => row.kind !== "@")); }
      } catch (e) { if (target.key === this.target.key) this.errors.diff = e.message; }
      finally { delete this.loading[loadingKey]; cx.notify(); }
    });
    cx.notify();
  }
  update(cx) {
    if (this.updating) return;
    this.updating = true;
    cx.spawn(async cx => {
      try {
        await this.persist();
        const previous = this.target;
        const value = await helper("git.update", { target: previous, pr: this.pr });
        updateSessionTarget(this.repo, this.number, previous, value.target);
        this.target = value.target; this.checkout = value.checkoutStatus;
        this.syncDraft();
        this.diffs = {}; this.rows = []; this.file = 0; this.selection = null; this.commentTarget = false;
        this.loadInitial(cx);
      } catch (e) { this.notice = e.message; }
      this.updating = false; cx.notify();
    });
  }
  review(cx) {
    this.syncDraft();
    if (!this.pr || this.pr.headOid !== this.target.headOid || this.pr.baseOid !== this.target.baseOid) { this.notice = "Update to the latest revision before submitting a review"; cx.notify(); return; }
    cx.spawn(async cx => {
      try {
        await this.persist();
        openOverlay({ mod: "pull-requests", kind: "dialog", width: 510, height: 460, props: {
          role: "compose", repo: this.repo, number: this.number, title: this.pr.title, url: this.pr.url,
          comparisonKey: this.target.key, headOid: this.target.headOid, baseOid: this.target.baseOid, key: this.draftKey, draft: this.draft } });
      } catch (e) { this.notice = e.message; cx.notify(); }
    });
  }
  toggleViewed(cx) {
    const path = this.files[this.file]?.path; if (!path) return;
    if (this.viewed.has(path)) { this.viewed.delete(path); this.folded.delete(this.file); }
    else { this.viewed.add(path); this.folded.add(this.file); }
    setShared("pull-requests.viewed." + this.target.key, [...this.viewed]); this.selection = null; this.visual = false; cx.notify();
  }
  resizeTree(delta, cx) {
    this.treeWidth = Math.max(150, Math.min(360, this.bodySize.width - 324, this.treeWidth + delta)); cx.notify();
  }
  moveCursor(index, cx) {
    if (!Number.isFinite(index)) return;
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, index));
    if (this.visual) this.selection = { anchor: this.selection?.anchor ?? this.cursor, end: this.cursor };
    this.diffScroll.scroll_to_item(this.cursor); cx.notify();
  }
  visibleFiles() {
    const query = this.filter.value().trim().toLowerCase();
    return this.files.flatMap((file, index) => file.path.toLowerCase().includes(query) ? [index] : []);
  }
  moveFile(delta, cx, wrap = false) {
    const files = this.visibleFiles(); if (!files.length) return;
    const at = files.indexOf(this.file), index = at < 0 ? 0 : wrap ? (at + delta + files.length) % files.length : Math.max(0, Math.min(files.length - 1, at + delta));
    this.pickFile(files[index], cx);
  }
  pageHalf(direction) {
    let index = this.pageCursor, distance = 0;
    while (index + direction >= 0 && index + direction < this.pageItems.length && distance < this.pageHeight / 2) {
      index += direction; distance += this.pageHeights[this.pageItems[index].key] ?? 44;
    }
    return index;
  }
  navKey(e, cx, scope = "diff") {
    if (this.typing || !this.pr) return;
    const key = e.key, shift = e.modifiers.shift;
    if (key === "?") this.help();
    else if (key === "o") this.changeView("overview", cx);
    else if (key === "f") this.changeView("changes", cx);
    else if (key === "a") this.changeView("activity", cx);
    else if (key === "r") this.review(cx);
    else if (this.view === "changes" && e.keystroke === "ctrl-shift-h") this.resizeTree(-25, cx);
    else if (this.view === "changes" && e.keystroke === "ctrl-shift-l") this.resizeTree(25, cx);
    else if (this.view === "changes" && e.keystroke === "ctrl-h") this.treeHandle.focus();
    else if (this.view === "changes" && e.keystroke === "ctrl-l") this.handle.focus();
    else if (key === "/" && this.view !== "overview") (this.view === "changes" ? this.filter : this.activityFilter).focus();
    else if (this.view !== "changes") {
      if (this.view === "overview" && ["1", "2", "3"].includes(key)) this.section = ["checks", "reviews", "threads"][Number(key) - 1];
      else if (this.view === "overview" && key === "d") this.descriptionOpen = !this.descriptionOpen;
      else if (this.view === "overview" && key === "p") this.showPassed = !this.showPassed;
      else if (this.view === "overview" && key === "s") this.showSkipped = !this.showSkipped;
      else if (key === "j" || key === "k") this.pageCursor = Math.max(0, Math.min(this.pageItems.length - 1, this.pageCursor + (key === "j" ? 1 : -1)));
      else if (e.keystroke === "ctrl-d" || e.keystroke === "ctrl-u") this.pageCursor = this.pageHalf(e.keystroke === "ctrl-d" ? 1 : -1);
      else if (key === "G" || key === "g" && shift) this.pageCursor = this.pageItems.length - 1;
      else if (key === "g") { if (Date.now() - this.gAt < 600) this.pageCursor = 0; this.gAt = Date.now(); }
      else if (key === "enter") this.pageItems[this.pageCursor]?.action?.(cx);
      else return;
      this.pageKey = this.pageItems[this.pageCursor]?.key;
      this.pageScroll.scroll_to_item(this.pageCursor);
    } else if (key === "space" || key === " ") this.toggleViewed(cx);
    else if (scope === "tree" && key === "h") this.treeOpen = false;
    else if (scope === "tree" && (key === "l" || key === "enter")) { this.treeOpen = true; this.pickFile(this.file, cx); this.handle.focus(); }
    else if (scope === "tree" && (key === "j" || key === "k")) { if (this.treeOpen) this.moveFile(key === "j" ? 1 : -1, cx); }
    else if (scope === "tree" && (e.keystroke === "ctrl-d" || e.keystroke === "ctrl-u")) this.moveFile(Math.max(1, Math.floor(this.bodySize.height / 64)) * (e.keystroke === "ctrl-d" ? 1 : -1), cx);
    else if (!shift && (key === "[" || key === "]")) this.moveFile(key === "]" ? 1 : -1, cx, true);
    else if (key === "G" || key === "g" && shift) scope === "tree" ? this.pickFile(this.visibleFiles().slice(-1)[0] ?? 0, cx) : this.moveCursor(this.rows.length - 1, cx);
    else if (key === "g") { if (Date.now() - this.gAt < 600) scope === "tree" ? this.pickFile(this.visibleFiles()[0] ?? 0, cx) : this.moveCursor(0, cx); this.gAt = Date.now(); }
    else if (key === "j" || key === "k") this.moveCursor(this.cursor + (key === "j" ? 1 : -1), cx);
    else if (e.keystroke === "ctrl-d" || e.keystroke === "ctrl-u") this.moveCursor(this.cursor + Math.max(3, Math.floor(this.bodySize.height / 48)) * (e.keystroke === "ctrl-d" ? 1 : -1), cx);
    else if (key === "{" || key === "}" || shift && (key === "[" || key === "]")) {
      const hunks = this.rows.flatMap((row, index) => row.kind === "@" ? [index] : []);
      const forward = key === "}" || key === "]";
      this.moveCursor(forward ? hunks.find(index => index > this.cursor) ?? hunks[0] : [...hunks].reverse().find(index => index < this.cursor) ?? hunks[hunks.length - 1], cx);
    } else if (key === "V" || key === "v" && shift) { this.visual = true; this.selection = { anchor: this.cursor, end: this.cursor }; }
    else if (key === "t") this.showThreads = !this.showThreads;
    else if (key === "y" || e.keystroke === "cmd-c") this.copy(cx);
    else if (key === "c" || key === "i" || key === "enter") {
      if (this.folded.has(this.file)) this.folded.delete(this.file);
      else this.beginComment(cx);
    } else if (key === "escape") { this.visual = false; this.selection = null; }
    else return;
    cx.stop_propagation(); cx.notify();
  }
  select(index, e, cx) {
    this.cursor = index; this.selection = { anchor: e.modifiers.shift && this.selection ? this.selection.anchor : index, end: index };
    this.visual = e.modifiers.shift; this.handle.focus(); cx.notify();
  }
  copy(cx) {
    this.selection ??= { anchor: this.cursor, end: this.cursor };
    const selected = this.rows.slice(Math.min(this.selection.anchor, this.selection.end), Math.max(this.selection.anchor, this.selection.end) + 1).filter(row => row.kind !== "@");
    if (!selected.length) return;
    const range = field => {
      let first = null, last = null;
      for (const row of selected) if (Number.isInteger(row[field])) {
        first = first === null ? row[field] : Math.min(first, row[field]);
        last = last === null ? row[field] : Math.max(last, row[field]);
      }
      return first === null ? "none" : first + "–" + last;
    };
    const fence = String.fromCharCode(96).repeat(3);
    const notes = this.notes.filter(note => note.path === this.files[this.file].path).map(note => note.body);
    const text = "Repository: " + this.repo.nameWithOwner + "\nPull request: " + this.pr.url + "\nRevision: " + this.target.headOid + "\nFile: " + this.files[this.file].path
      + "\nOld lines: " + range("old") + "\nNew lines: " + range("next")
      + "\n\n" + fence + "diff\n" + selected.map(row => row.kind + row.text).join("\n") + "\n" + fence
      + (notes.length ? "\n\nReview notes:\n" + notes.join("\n\n") : "")
      + (this.comment.value().trim() ? "\n\nDraft comment:\n" + this.comment.value().trim() : "");
    cx.write_to_clipboard(text); this.notice = "Context copied"; cx.notify();
  }
  addComment(cx) {
    this.syncDraft();
    if (!this.selection || !this.comment.value().trim()) return;
    if (this.attempt && this.attempt.state !== "editing") { this.notice = "Resolve the pending review before adding comments"; cx.notify(); return; }
    try {
      const thread = selectionThread(this.rows, this.selection, this.files[this.file].path, this.comment.value());
      this.notes.push({ path: thread.path, body: thread.body, thread, range: { ...this.selection } });
      this.dirty = true;
      if (this.draft.inlineDrafts) delete this.draft.inlineDrafts[thread.path];
      this.inlinePath = null;
      this.comment.set_value(""); this.commentTarget = false; this.notice = "Comment added to review draft"; this.saveLater(cx);
      this.handle.focus();
    } catch (e) { this.notice = e.message; }
    cx.notify();
  }
  beginComment(cx) {
    this.syncDraft();
    const path = this.files[this.file]?.path; if (!path) return;
    const saved = this.draft.inlineDrafts?.[path];
    this.inlinePath = path;
    if (saved && !this.comment.value()) { this.comment.set_value(saved.body); this.selection = saved.selection; }
    this.selection ??= { anchor: this.cursor, end: this.cursor };
    this.commentTarget = true; this.comment.focus(); cx.notify();
  }
  loadThread(thread, cx) {
    if (thread.loading || thread.loaded) return;
    thread.loading = true;
    cx.spawn(async cx => {
      try { thread.comments = await collectPages(cursor => helper("github.thread-comments", { id: thread.id, cursor })); thread.loaded = true; thread.error = null; }
      catch (e) { thread.error = e.message; }
      thread.loading = false; cx.notify();
    });
  }
  thread(thread, t) {
    return v_flex().my(8).p(12).gap(7).bg(t.surface).rounded(5).flex_none()
      .child(h_flex().gap(7).text_size(11).text_color(t.muted).child(div().flex_1().child(thread.path + (thread.line ? ":" + thread.line : ""))).child(div().child(thread.isOutdated ? "Outdated" : thread.isResolved ? "Resolved" : "Open")))
      .children((thread.comments ?? []).map(comment => v_flex().gap(5).child(div().text_size(11).font_semibold().child(comment.author)).child(TextView.markdown("thread-" + comment.id, comment.body ?? "").selectable().text_size(12))))
      .when(Boolean(thread.error), el => el.child(div().text_size(11).text_color(t.ansi1).child(thread.error)))
      .when(!thread.loaded && thread.commentsPageInfo?.hasNextPage, el => el.child(button("thread-more-" + thread.id, thread.loading ? "Loading…" : "Load discussion", (_e, cx) => this.loadThread(thread, cx), t)))
      .child(button("thread-web-" + thread.id, "Open on GitHub", (_e, cx) => cx.open_url(thread.comments?.[0]?.url ?? this.pr.url), t));
  }
  help() { openOverlay({ mod: "pull-requests", kind: "dialog", width: 550, height: 560, props: { role: "review", mode: "keys" } }); }
  helpView(t) {
    const entries = [["o / f / a", "Overview / files / activity"], ["j / k · gg / G", "Navigate visible rows"], ["Ctrl+d / Ctrl+u", "Move half a page"], ["⌘Enter / r", "Open review composer"], ["Ctrl+h / Ctrl+l", "Focus files / diff"], ["Ctrl+Shift+h / l", "Narrow / widen files"], ["[ / ] · { / }", "Previous/next file · hunk"], ["Space", "Toggle viewed and fold"], ["V · j/k", "Select a line range"], ["c / i / Enter", "Comment on selected lines"], ["y / ⌘C", "Copy selected context"], ["Esc", "Leave input and retain draft"], ["1 / 2 / 3", "Overview: checks / approvals / threads"]];
    return v_flex().size_full().min_h(0).p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_size(15).child("Review keyboard shortcuts")).child(button("keys-close", "Close", () => closeOverlay(this.p.overlay), t)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(12).children(entries.map(([key, label]) => h_flex().gap(16).text_size(12).child(div().w(150).text_color(t.accent).child(key)).child(div().flex_1().child(label)))));
  }
  page(items, t) {
    this.pageItems = items;
    const selected = items.findIndex(item => item.key === this.pageKey);
    this.pageCursor = selected >= 0 ? selected : Math.max(0, Math.min(items.length - 1, this.pageCursor));
    this.pageKey = items[this.pageCursor]?.key;
    return div().flex_1().min_h(0).relative().on_size_change(size => { this.pageHeight = size.height; })
      .child(v_flex().id("pr-detail-scroll").absolute().inset_0().overflow_y_scroll().track_scroll(this.pageScroll).px(16).py(12).gap(4)
        .children(items.map((item, index) => div().id("detail-" + item.key).flex_none().border_l(2).border_color(index === this.pageCursor && this.handle.is_focused() ? t.accent : t.background).pl(8)
          .on_size_change(size => { this.pageHeights[item.key] = size.height; })
          .on_mouse_down("left", (_e, cx) => { this.pageCursor = index; this.pageKey = item.key; cx.notify(); }).child(item.element))))
      .child(Scrollbar.vertical("pr-detail-scroll").absolute().inset_0());
  }
  sectionState(name, t) {
    if (this.errors[name]) return div().py(10).text_size(12).text_color(t.ansi1).child(this.errors[name]);
    if (this.loading[name]) return h_flex().py(10).gap(7).text_size(12).text_color(t.muted).child(icon("running", t)).child(div().child("Refreshing…"));
    return null;
  }
  overview(t) {
    const summary = checksSummary(this.pr.checksSummary), decision = reviewDecision(this.pr.reviewDecision);
    const approved = this.reviews.filter(review => review.status === "approved").length;
    const resolved = this.threads.filter(thread => thread.isResolved).length;
    const approvalsText = !this.loaded.reviews ? this.errors.reviews ? "Unavailable" : "Loading…" : approved + " approved" + (this.errors.reviews ? " · stale" : " · " + decision.label);
    const threadsText = !this.loaded.threads ? this.errors.threads ? "Unavailable" : "Loading…" : resolved + " resolved · " + (this.threads.length - resolved) + " open" + (this.errors.threads ? " · stale" : "");
    const state = this.pr.state === "In queue" ? "waiting" : summary.running ? "running" : summary.failed ? "failed" : decision.status;
    const title = this.pr.state === "In queue" ? "In merge queue" : this.pr.state === "Draft" ? "Draft pull request" : summary.running ? "Checks running" : summary.failed ? "Checks need attention" : decision.label;
    const segment = (count, color) => div().h_full().min_w(0).flex_basis(0).flex_grow(count).bg(color);
    const summaryButton = (id, label, value, segments) => Button.new("summary-" + id).flex_1().h(67).px(12).bg(this.section === id ? t.selected : t.background)
      .when(id !== "checks", el => el.border_l(1).border_color(t.border))
      .on_click((_e, cx) => { this.section = id; cx.notify(); })
      .child(v_flex().w_full().gap(7).child(div().text_size(11).font_medium().text_color(t.muted).child(label))
        .child(div().text_size(12).truncate().child(value))
        .child(h_flex().w_full().h(4).rounded(2).overflow_hidden().children(segments.filter(([count]) => count > 0).map(([count, color]) => segment(count, color)))));
    const items = [{ key: "readiness", element: v_flex().my(3).border_1().border_color(t.border).rounded(7).overflow_hidden()
      .child(h_flex().h(43).px(12).gap(8).items_center().child(icon(state, t)).child(div().font_medium().text_size(13).child(title)))
      .child(h_flex().w_full().border_t(1).border_color(t.border)
        .child(summaryButton("checks", "Checks", summary.description, [[summary.passed, t.ansi2], [summary.failed, t.ansi1], [summary.running, t.working], [summary.waiting, t.ansi3], [summary.skipped + summary.neutral + summary.unknown, t.muted]]))
        .child(summaryButton("reviews", "Approvals", approvalsText, this.loaded.reviews ? [[approved, decision.status === "passed" ? t.ansi2 : t.ansi3], [this.reviews.length - approved, t.border]] : []))
        .child(summaryButton("threads", "Threads", threadsText, this.loaded.threads ? [[resolved, t.ansi2], [this.threads.length - resolved, t.ansi3]] : []))) }];
    if (this.section === "checks") {
      const required = this.checks.filter(check => check.required);
      items.push({ key: "check-count", element: h_flex().h(29).items_center().text_size(11).text_color(t.muted)
        .child(div().child(summary.total + " checks")).child(div().flex_1())
        .child(div().child(this.loaded.checks ? required.filter(check => ["passed", "skipped", "neutral"].includes(check.status)).length + "/" + required.length + " required succeeded" : this.errors.checks ? "Required checks unavailable" : "Loading required checks…")) });
      const visible = this.checks.filter(check => !["passed", "skipped", "neutral"].includes(check.status) || check.status === "passed" && this.showPassed || ["skipped", "neutral"].includes(check.status) && this.showSkipped);
      for (const check of visible) items.push({ key: "check-" + check.id, action: cx => { if (check.url) cx.open_url(check.url); }, element: v_flex().py(11).gap(5).border_b(1).border_color(t.border)
        .child(h_flex().gap(9).items_center().text_size(12).child(icon(check.status, t)).child(div().flex_1().font_medium().child(check.name))
          .when(Boolean(check.required), el => el.child(div().text_size(10).text_color(t.muted).child("Required")))
          .child(div().text_size(11).text_color(t.muted).child(check.status[0].toUpperCase() + check.status.slice(1))))
        .when(Boolean(check.description), el => el.child(div().pl(23).text_size(11).text_color(t.muted).child(check.description))) });
      for (const [status, field] of [["passed", "showPassed"], ["skipped", "showSkipped"]]) {
        const count = this.checks.filter(check => status === "skipped" ? ["skipped", "neutral"].includes(check.status) : check.status === status).length;
        if (!count) continue;
        const action = cx => { this[field] = !this[field]; cx.notify(); };
        items.push({ key: "toggle-" + status, action, element: Button.new("checks-" + status).h(37).w_full().on_click((_e, cx) => action(cx)).child(h_flex().gap(8).text_size(12).text_color(t.muted)
          .child(svg("mods/workspace-chrome/chevron-" + (this[field] ? "down" : "right") + ".svg").size(12))
          .child(div().child(count + " " + (status === "skipped" ? "skipped or neutral" : status) + " checks"))) });
      }
      const state = this.sectionState("checks", t); if (state) items.push({ key: "checks-state", element: state });
    } else if (this.section === "reviews") {
      for (const review of this.reviews) items.push({ key: "review-" + review.id, action: cx => { if (review.url) cx.open_url(review.url); }, element: h_flex().h(45).gap(9).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(icon(review.status === "approved" ? "passed" : review.status === "changes-requested" ? "failed" : "neutral", t))
        .child(div().flex_1().font_medium().child(review.author))
        .child(div().text_size(11).text_color(t.muted).child(review.status.replaceAll("-", " "))) });
      const state = this.sectionState("reviews", t); if (state) items.push({ key: "reviews-state", element: state });
      else if (!this.reviews.length) items.push({ key: "reviews-empty", element: div().py(16).text_size(12).text_color(t.muted).child("No submitted review opinions") });
    } else {
      for (const thread of this.threads) items.push({ key: "thread-" + thread.id, element: this.thread(thread, t) });
      const state = this.sectionState("threads", t); if (state) items.push({ key: "threads-state", element: state });
      else if (!this.threads.length) items.push({ key: "threads-empty", element: div().py(16).text_size(12).text_color(t.muted).child("No review threads") });
    }
    const description = cx => { this.descriptionOpen = !this.descriptionOpen; cx.notify(); };
    items.push({ key: "description-toggle", action: description, element: Button.new("description-toggle").mt(9).h(35).w_full().border_t(1).border_color(t.border).on_click((_e, cx) => description(cx))
      .child(h_flex().gap(7).text_size(12).child(svg("mods/workspace-chrome/chevron-" + (this.descriptionOpen ? "down" : "right") + ".svg").size(12).text_color(t.muted)).child(div().font_medium().child("Description"))) });
    if (this.descriptionOpen) items.push({ key: "description", element: TextView.markdown("pr-description", this.pr.body || "No description provided.").selectable().text_size(12).py(8) });
    return this.page(items, t);
  }
  activity(t) {
    const query = this.activityFilter.value().trim().toLowerCase();
    const items = [{ key: "activity-filter", element: Input.new(this.activityFilter).h(31).px(8).mb(10).border_1().border_color(t.input).rounded(5).text_size(12) }];
    const events = this.events.filter(event => [event.author, event.text, event.body].join(" ").toLowerCase().includes(query));
    for (const event of events) {
      const expanded = this.expanded === event.id, action = cx => { this.expanded = expanded ? null : event.id; cx.notify(); };
      items.push({ key: "event-" + event.id, action, element: v_flex().py(12).gap(7).border_b(1).border_color(t.border)
        .child(h_flex().gap(7).items_center().text_size(12)
          .child(div().font_semibold().child(event.author ?? "GitHub"))
          .child(div().flex_1().text_color(t.muted).child(event.text ?? event.kind))
          .child(div().text_size(10).text_color(t.muted).child(event.createdAt ? new Date(event.createdAt).toLocaleString() : "")))
        .when(Boolean(event.body), el => el.child(expanded ? TextView.markdown("activity-body-" + event.id, event.body).selectable().text_size(12) : div().text_size(12).truncate().child(event.body)))
        .when(Boolean(expanded && event.url), el => el.child(button("activity-web-" + event.id, "Open on GitHub", (_e, cx) => cx.open_url(event.url), t))) });
    }
    const state = this.sectionState("activity", t); if (state) items.push({ key: "activity-state", element: state });
    else if (!events.length) items.push({ key: "activity-empty", element: div().py(16).text_size(12).text_color(t.muted).child("No matching activity") });
    items.push({ key: "activity-review", action: cx => this.review(cx), element: h_flex().pt(14).child(button("activity-review", "Write a review", (_e, cx) => this.review(cx), t)) });
    return this.page(items, t);
  }
  fileTree(t) {
    const query = this.filter.value().trim().toLowerCase();
    const files = this.files.map((file, index) => ({ ...file, index })).filter(file => file.path.toLowerCase().includes(query));
    return v_flex().w(this.treeWidth).h_full().flex_none().min_h(0).track_focus(this.treeHandle).on_key_down((e, cx) => this.navKey(e, cx, "tree")).border_r(1).border_color(t.border).bg(t.background)
      .child(h_flex().px(12).h(38).flex_none().items_center().gap(5).text_size(11).text_color(t.muted).child(div().child("Files changed")).child(div().flex_1()).child(div().child(this.viewed.size + "/" + this.files.length + " viewed")))
      .child(Input.new(this.filter).mx(9).h(29).flex_none().px(7).text_size(11).border_1().border_color(t.input).rounded(5).bg(t.background))
      .child(div().flex_1().min_h(0).relative().child(v_flex().id("pr-files-scroll").absolute().inset_0().overflow_y_scroll().track_scroll(this.treeScroll).p(6).gap(2)
        .child(Button.new("changed-folder").h(30).px(4).text_size(11).text_color(t.muted).on_click((_e, cx) => { this.treeOpen = !this.treeOpen; this.treeHandle.focus(); cx.notify(); })
          .child(h_flex().gap(5).items_center().child(svg("mods/workspace-chrome/chevron-" + (this.treeOpen ? "down" : "right") + ".svg").size(12)).child(div().child("Changed files"))))
        .when(this.treeOpen, el => el.children(files.map(file => Button.new("file-" + file.index).h(32).pl(17).pr(7).rounded(5).bg(file.index === this.file ? t.selected : t.background).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.pickFile(file.index, cx); this.treeHandle.focus(); })
          .child(h_flex().w_full().gap(7).items_center()
            .child(div().w(12).text_size(10).text_color(file.status === "A" ? t.ansi2 : file.status === "D" ? t.ansi1 : t.blocked).child(file.status))
            .child(div().flex_1().min_w(0).text_size(11).truncate().tooltip(file.oldPath ? file.oldPath + " → " + file.path : file.path).child(file.path))
            .child(div().text_size(9).text_color(t.ansi2).child("+" + file.added))
            .child(div().text_size(9).text_color(t.ansi1).child("−" + file.removed))
            .when(this.viewed.has(file.path), el => el.child(svg("mods/workspace-chrome/check.svg").size(12).text_color(t.ansi2)))))))
        .when(this.treeOpen && !files.length, el => el.child(div().p(12).text_size(11).text_color(t.muted).child("No matching files"))))
        .child(Scrollbar.vertical("pr-files-scroll").absolute().inset_0()));
  }
  inlineComposer(t) {
    return v_flex().px(14).py(10).gap(9).border_t(1).border_color(t.border).bg(t.background).flex_none()
      .child(div().text_size(11).font_semibold().child("Comment on selected lines"))
      .child(Textarea.new(this.comment).h(78).px(9).py(7).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(12))
      .child(h_flex().gap(7).justify_end()
        .child(button("comment-cancel", "Close", (_e, cx) => { this.commentTarget = false; this.saveLater(cx); this.handle.focus(); cx.notify(); }, t))
        .child(button("comment-add", "Add to review", (_e, cx) => this.addComment(cx), t, true)));
  }
  changes(t) {
    if (!this.files.length) return div().flex_1().p(20).text_color(t.muted).child("No changed files");
    const file = this.files[this.file], lo = this.selection ? Math.min(this.selection.anchor, this.selection.end) : -1, hi = this.selection ? Math.max(this.selection.anchor, this.selection.end) : -1;
    const width = this.rows.reduce((width, row) => Math.max(width, row.text.length * 7 + 102), 480);
    const content = v_flex().id("pr-code").w_full().min_w(width).h_full().overflow_y_scroll().track_scroll(this.diffScroll).font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
      .children(this.rows.flatMap((row, index) => {
        if (row.kind === "@") return [div().h(27).flex_none().px(14).flex().items_center().bg(t.raised).text_color(t.muted).child(row.text)];
        const selected = index >= lo && index <= hi;
        const line = h_flex().h(24).flex_none().gap(7).items_center().bg(selected ? t.selected : row.kind === "+" ? t.ansi2 + "14" : row.kind === "-" ? t.ansi1 + "14" : t.background)
          .child(Button.new("line-" + index).w(69).h(24).flex_none().px(4).when(index === this.cursor && this.handle.is_focused(), el => el.bg(t.hover))
            .on_click((e, cx) => this.select(index, e, cx))
            .child(h_flex().w_full().gap(5).text_color(selected || index === this.cursor ? t.accent : t.muted)
              .child(div().w(27).text_right().child(String(row.old ?? ""))).child(div().w(27).text_right().child(String(row.next ?? "")))))
          .child(div().w(9).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.muted).child(row.kind))
          .child(div().flex_none().child(row.text || " "));
        const threads = this.showThreads && this.pr.headOid === this.target.headOid ? this.threads.filter(thread => thread.path === file.path && !thread.isOutdated && Number.isInteger(thread.line) && row[thread.side === "LEFT" ? "old" : "next"] === thread.line) : [];
        return [line, ...threads.map(thread => this.thread(thread, t))];
      }))
      .children(this.notes.filter(note => note.path === file.path).map((note, index) => v_flex().id("draft-note-" + index).ml(76).mr(16).my(8).p(12).gap(6).bg(t.surface).flex_none().font_family(settings().ui_font_family ?? "Geist")
        .child(div().text_size(10).text_color(t.muted).child("Draft · " + note.path + ":" + note.thread.line)).child(div().text_size(12).child(note.body))));
    const viewport = div().flex_1().min_h(0).relative().on_mouse_down("left", () => this.handle.focus())
      .child(div().id("pr-code-x").absolute().inset_0().overflow_x_scroll().child(content))
      .child(Scrollbar.vertical("pr-code").viewport_from_layout().absolute().inset_0());
    const folded = v_flex().flex_1().items_center().justify_center().gap(10).child(div().text_size(12).text_color(t.muted).child("File marked viewed and folded"))
      .child(button("file-reopen", "Reopen file", (_e, cx) => { this.folded.delete(this.file); cx.notify(); }, t));
    const state = this.errors.diff ?? (this.loading["diff:" + this.target.key + ":" + file.path] ? "Loading diff…" : file.binary ? "Binary file · inspect in the terminal" : "No text changes");
    const diff = v_flex().h_full().flex_1().min_w(300).min_h(0)
      .child(h_flex().px(13).h(38).items_center().gap(8).flex_none().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().tooltip(file.path).child(file.path))
        .child(button("file-viewed", this.viewed.has(file.path) ? "Viewed" : "Mark viewed", (_e, cx) => this.toggleViewed(cx), t)))
      .child(this.folded.has(this.file) ? folded : this.rows.length ? viewport : div().flex_1().p(18).text_size(12).text_color(this.errors.diff ? t.ansi1 : t.muted).child(state))
      .when(this.commentTarget, el => el.child(this.inlineComposer(t)))
      .when(Boolean(this.selection), el => el.child(h_flex().px(12).h(43).gap(7).items_center().flex_none().border_t(1).border_color(t.border).bg(t.raised)
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(file.path))
        .child(button("copy-context", "Copy context", (_e, cx) => this.copy(cx), t))
        .child(button("comment-selection", "Comment", (_e, cx) => this.beginComment(cx), t))
        .child(button("clear-selection", svg("mods/workspace-chrome/x.svg").size(12), (_e, cx) => { this.selection = null; this.visual = false; this.commentTarget = false; cx.notify(); }, t))));
    const divider = div().id("tree-divider").w(24).h_full().flex_none().flex().items_center().justify_center().cursor_col_resize()
      .on_mouse_down("left", (e, cx) => { this.resizing = { x: e.position.x, width: this.treeWidth }; cx.stop_propagation(); })
      .child(div().w(1).h_full().bg(t.border));
    return h_flex().w_full().flex_1().min_h(0).min_w(0)
      .on_size_change((size, cx) => { this.bodySize = size; if (this.treeWidth > size.width - 324 && size.width > 474) this.resizeTree(0, cx); })
      .on_mouse_move((e, cx) => { if (this.resizing) { this.treeWidth = this.resizing.width; this.resizeTree(e.position.x - this.resizing.x, cx); } })
      .on_mouse_up("left", () => { this.resizing = null; }).on_hover(hovered => { if (!hovered) this.resizing = null; })
      .child(this.fileTree(t)).child(divider).child(diff);
  }
  render() {
    const t = theme();
    if (this.p.mode === "keys") return this.helpView(t);
    if (!this.repo || !this.target) return div().p(20).text_color(t.muted).child("Open a pull request from the PRs panel");
    this.syncDraft();
    if (this.initialLoading || this.initialError || !this.pr) return v_flex().size_full().items_center().justify_center().gap(10).bg(t.background).text_color(t.muted)
      .child(icon(this.initialError ? "failed" : "running", t))
      .child(div().text_size(12).child(this.initialError ?? "Loading pull request…"))
      .when(Boolean(this.initialError), el => el.child(button("pr-retry", "Retry", (_e, cx) => this.loadInitial(cx), t)));
    const summary = checksSummary(this.pr.checksSummary), moved = this.pr.headOid !== this.target.headOid || this.pr.baseOid !== this.target.baseOid;
    const lifecycle = this.pr.state === "Draft" ? "git-pull-request-draft-16.svg" : this.pr.state === "Merged" ? "git-merge-16.svg" : "git-pull-request-16.svg";
    const nav = (id, label, view, count = null) => Button.new(id).h(36).px(10).border_b(2).border_color(this.view === view ? t.accent : t.background).text_color(this.view === view ? t.foreground : t.muted)
      .on_click((_e, cx) => this.changeView(view, cx))
      .child(h_flex().gap(6).items_center().child(div().text_size(12).font_medium().child(label))
        .when(count !== null, el => el.child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(String(count)))));
    return v_flex().id("pr-review").size_full().min_h(0).bg(t.background).text_color(t.foreground).track_focus(this.handle).key_context("PRReviewDetail")
      .on_action("pr_detail_review", (_e, cx) => { cx.stop_propagation(); this.review(cx); })
      .on_action("pr_detail_input", (_e, cx) => { cx.stop_propagation(); if (this.commentTarget) this.addComment(cx); else this.review(cx); })
      .on_action("pr_detail_normal", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.typing = false; this.saveLater(cx); cx.notify(); })
      .on_key_down((e, cx) => this.navKey(e, cx))
      .child(v_flex().px(16).pt(12).pb(9).gap(9).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().items_center().gap(8)
          .child(svg("mods/pull-requests/" + lifecycle).size(15).text_color(this.pr.state === "Draft" ? t.muted : this.pr.state === "In queue" ? t.ansi5 : t.ansi2))
          .child(Button.new("pr-link").text_color(t.accent).text_size(12).on_click((_e, cx) => cx.open_url(this.pr.url)).child("#" + this.number))
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().tooltip(this.pr.title).child(this.pr.title))
          .child(button("pr-review-open", "Review…", (_e, cx) => this.review(cx), t, true)))
        .child(h_flex().items_center().gap(7).text_size(11).text_color(t.muted)
          .child(div().flex_1().min_w(0).truncate().child("@" + this.pr.author + " · " + this.pr.base + " ← " + this.pr.head))
          .child(icon(summary.status, t, 12)).child(div().child(summary.label))))
      .when(moved, el => el.child(h_flex().px(16).py(7).gap(8).items_center().flex_none().bg(t.raised)
        .child(div().flex_1().text_size(11).text_color(t.muted).child("New revision available · diff pinned to " + this.target.headOid.slice(0, 8)))
        .child(button("pr-update", this.updating ? "Updating…" : "Update", (_e, cx) => this.update(cx), t))))
      .when(Boolean(this.checkout && (!this.checkout.owned || !this.checkout.matchesPinned)), el => el.child(div().px(16).py(8).text_size(11).text_color(t.ansi3)
        .child("Terminal checkout differs from the pinned diff. " + (this.checkout?.reason ?? ""))))
      .child(h_flex().px(10).h(37).gap(5).items_center().flex_none().border_b(1).border_color(t.border)
        .child(nav("pr-overview", "Overview", "overview")).child(nav("pr-files", "Files changed", "changes", this.files.length)).child(nav("pr-activity", "Activity", "activity"))
        .child(div().flex_1()).child(button("pr-refresh", this.refreshing ? "…" : "Refresh", (_e, cx) => this.refresh(cx), t)).child(button("pr-help", "?", () => this.help(), t)))
      .child(this.view === "changes" ? this.changes(t) : this.view === "activity" ? this.activity(t) : this.overview(t))
      .child(h_flex().px(13).h(27).gap(10).items_center().flex_none().border_t(1).border_color(t.border).text_size(10).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().tooltip(this.notice ?? "").child(this.notice ?? (this.notes.length ? this.notes.length + " draft comments · ⌘Enter review" : "? Keyboard shortcuts")))
        .child(div().child(this.repo.nameWithOwner + " · " + this.target.headOid.slice(0, 8))));
  }
}
