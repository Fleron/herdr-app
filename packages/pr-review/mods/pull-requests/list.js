import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, ScrollHandle, Scrollbar } from "gpui-base";
import { spaces, theme, nextCommand, setShared } from "herdr";

import { GROUPS, checksSummary, reviewDecision, orderedPrs, collectPages } from "./model.js";
import { helper, activeRepositoryLocation, openPullRequest, session } from "./client.js";

function checkIcon(status, t) {
  if (status === "running") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  const icon = status === "failed" ? "x" : status === "passed" ? "circle-check" : status === "waiting" ? "clock" : "minus";
  return svg(`mods/workspace-chrome/${icon}.svg`).size(12).flex_none().text_color(status === "failed" ? t.ansi1 : status === "passed" ? t.ansi2 : t.muted);
}

export default class PullRequests {
  init(_props, cx) {
    this.handle = cx.focus_handle(); this.scroll = ScrollHandle.new();
    this.index = 0; this.cursorKey = "group:queue"; this.closed = new Set(); this.gAt = 0;
    this.prs = []; this.loading = false; this.loadError = null;
    this.opening = new Map(); this.note = null;
    this.refresh(cx);
    cx.timer.every(30000, cx => this.refresh(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") { this.handle.focus(); this.refresh(cx); }
        else if (command === "refresh") this.refresh(cx);
        else if (command.startsWith("group-toggle-")) this.toggleGroup(command.slice(13), cx);
        else if (command.startsWith("open-")) {
          const pr = this.prs.find(pr => pr.number === Number(command.slice(5)));
          if (pr) this.open(pr, cx);
        }
        cx.notify();
      }
    });
  }
  locationKey() {
    try { const { space, cwd } = activeRepositoryLocation(); return `${space.id}:${cwd}`; }
    catch (error) { return String(error); }
  }
  refresh(cx) {
    const key = this.locationKey();
    if (this.loading && key === this.contextKey) return;
    const changed = key !== this.contextKey;
    this.contextKey = key;
    const generation = this.generation = (this.generation ?? 0) + 1;
    if (changed) { this.prs = []; this.repo = null; }
    this.loading = true; this.loadError = null;
    cx.spawn(async cx => {
      try {
        const { space, cwd } = activeRepositoryLocation();
        const repo = await helper("github.repo", { cwd });
        const prs = await collectPages(cursor => helper("github.list", { repo, cursor }), "prs");
        if (generation !== this.generation) return;
        this.prs = orderedPrs(prs); this.repo = repo; this.space = space;
        this.refreshed = Date.now();
      } catch (error) {
        if (generation === this.generation) {
          this.loadError = error.message ?? String(error);
          setShared("pull-requests.error", { scope: key, message: this.loadError, at: Date.now() });
        }
      }
      if (generation === this.generation) { this.loading = false; cx.notify(); }
    });
  }
  visibleRows() {
    const rows = [];
    for (const group of GROUPS) {
      const prs = this.prs.filter(group.matches);
      rows.push({ kind: "group", key: `group:${group.id}`, group, count: prs.length });
      if (!this.closed.has(group.id)) for (const pr of prs) rows.push({ kind: "pr", key: `pr:${pr.number}`, group, pr });
    }
    return rows;
  }
  syncCursor(rows) {
    let index = rows.findIndex(row => row.key === this.cursorKey);
    if (index < 0) index = Math.max(0, Math.min(rows.length - 1, this.index));
    this.index = index; this.cursorKey = rows[index]?.key;
  }
  move(index, cx) {
    const rows = this.visibleRows();
    this.index = Math.max(0, Math.min(rows.length - 1, index)); this.cursorKey = rows[this.index]?.key;
    this.scroll.scroll_to_item(this.index); this.handle.focus(); cx.notify();
  }
  toggleGroup(id, cx) {
    if (!GROUPS.some(group => group.id === id)) return;
    this.closed.has(id) ? this.closed.delete(id) : this.closed.add(id);
    if (!this.visibleRows().some(row => row.key === this.cursorKey)) this.cursorKey = `group:${id}`;
    this.syncCursor(this.visibleRows()); cx.notify();
  }
  key(e, cx) {
    if (!this.prs.length) { if (e.key === "r") this.refresh(cx); else return; }
    else {
      const rows = this.visibleRows(); this.syncCursor(rows);
      const row = rows[this.index], key = e.key;
      if (key === "j" || key === "down") this.move(this.index + 1, cx);
      else if (key === "k" || key === "up") this.move(this.index - 1, cx);
      else if (key === "G" || (key === "g" && e.modifiers.shift)) this.move(rows.length - 1, cx);
      else if (key === "g") { if (Date.now() - this.gAt <= 600) { this.move(0, cx); this.gAt = 0; } else this.gAt = Date.now(); }
      else if (key === "enter" || key === "space" || key === " ") row.kind === "group" ? this.toggleGroup(row.group.id, cx) : this.open(row.pr, cx);
      else if (key === "h") {
        if (row.kind === "pr") { this.cursorKey = `group:${row.group.id}`; this.syncCursor(rows); }
        else if (!this.closed.has(row.group.id)) this.toggleGroup(row.group.id, cx);
      } else if (key === "l") {
        if (row.kind === "pr") this.open(row.pr, cx);
        else if (this.closed.has(row.group.id)) this.toggleGroup(row.group.id, cx);
        else if (row.count) this.move(this.index + 1, cx);
      } else if (key === "r") this.refresh(cx);
      else return;
    }
    cx.stop_propagation(); cx.notify();
  }
  open(pr, cx) {
    if (this.opening.has(pr.number) || !this.repo || !this.space) return;
    this.opening.set(pr.number, true); this.note = null;
    const repo = this.repo, space = this.space;
    cx.spawn(async cx => {
      try { const state = await openPullRequest(repo, pr, space, cx); this.note = state.warning ?? null; }
      catch (error) { this.note = error.message ?? String(error); }
      finally { this.opening.delete(pr.number); cx.notify(); }
    });
    cx.notify();
  }

  render(cx) {
    if (this.locationKey() !== this.contextKey) this.refresh(cx);
    const activeTab = spaces().find(space => space.active)?.tabs.find(tab => tab.active)?.id;
    const selected = this.prs.find(pr => this.repo && session(this.repo, pr.number)?.tab === activeTab)?.number;
    const t = theme(), rows = this.visibleRows(); this.syncCursor(rows);
    const focus = this.handle.is_focused();
    const content = v_flex().id("pr-tree-rows").absolute().inset_0().overflow_y_scroll().track_scroll(this.scroll).p(6).gap(1)
      .children((this.prs.length ? rows : []).map((row, index) => {
        const cursor = focus && this.cursorKey === row.key;
        if (row.kind === "group") return Button.new(row.key).w_full().h(28).px(4).rounded(5).bg(t.chrome).hover(s => s.bg(t.hover)).border_l(2).border_color(cursor ? t.accent : t.chrome)
          .on_click((_e, cx) => { this.cursorKey = row.key; this.index = index; this.handle.focus(); this.toggleGroup(row.group.id, cx); })
          .child(h_flex().w_full().gap(6).items_center()
            .child(svg(`mods/files/chevron-${this.closed.has(row.group.id) ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).text_size(12).font_medium().text_color(t.foreground).child(row.group.label))
            .child(div().text_size(10).text_color(t.muted).child(String(row.count))));
        const pr = row.pr, checks = checksSummary(pr.checksSummary), approval = reviewDecision(pr.reviewDecision);
        return Button.new(row.key).w_full().h(44).pl(31).pr(7).rounded(5).border_l(2).border_color(cursor ? t.accent : t.chrome).bg(selected === pr.number ? t.selected : t.chrome).hover(s => s.bg(t.hover))
          .accessibility_label(`#${pr.number} ${pr.title}`)
          .on_click((_e, cx) => { this.cursorKey = row.key; this.index = index; this.open(pr, cx); })
          .child(v_flex().w_full().min_w(0).gap(3)
            .child(h_flex().w_full().min_w(0).gap(6).items_center()
              .child(svg(`mods/pull-requests/${row.group.icon}`).size(14).flex_none().text_color(t[row.group.color]))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).tooltip(pr.title).child(pr.title)))
            .child(h_flex().w_full().min_w(0).pl(20).gap(6).items_center().text_size(10).text_color(t.muted)
              .child(div().flex_none().child(`#${pr.number}`))
              .child(div().max_w(60).truncate().tooltip(pr.author).child(`· ${pr.author}`))
              .child(h_flex().gap(3).flex_none().items_center().tooltip(checks.description).child(checkIcon(checks.status, t)).child(div().child(`${checks.passed}/${checks.total}`)))
              .child(h_flex().flex_1().min_w(0).gap(3).items_center().tooltip(approval.label)
                .child(svg(`mods/workspace-chrome/${approval.status === "passed" ? "circle-check" : approval.status === "failed" ? "x" : "clock"}.svg`).size(12).flex_none().text_color(approval.status === "passed" ? t.ansi2 : approval.status === "failed" ? t.ansi1 : t.muted))
                .child(div().min_w(0).truncate().child(approval.label)))));
      }));
    return v_flex().id("pr-list").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(38).px(12).gap(7).items_center().flex_none()
        .child(div().font_semibold().text_size(13).child("Pull requests").tooltip(this.repo?.nameWithOwner ?? "Pull requests"))
        .when(!this.loading && !this.loadError || this.prs.length > 0, el => el.child(div().text_size(10).text_color(t.muted).child(String(this.prs.length))))
        .child(div().flex_1())
        .child(Button.new("pr-refresh").size(28).rounded(5).hover(s => s.bg(t.hover)).accessibility_label("Refresh pull requests").tooltip("Refresh pull requests · automatically every 30 seconds")
          .on_click((_e, cx) => this.refresh(cx)).child(svg("frame/settings/refresh.svg").size(14).text_color(t.muted).when(this.loading, el => el.spin(900)))))
      .when(this.loading && !this.prs.length, el => el.child(h_flex().h(44).px(14).gap(7).items_center().text_color(t.muted)
        .child(checkIcon("running", t)).child(div().child("Loading pull requests…"))))
      .when(!this.loading && !this.prs.length && !this.loadError, el => el.child(div().px(14).py(18).text_color(t.muted).child("No open pull requests")))
      .child(div().flex_1().min_h(0).relative().child(content).child(Scrollbar.vertical("pr-tree-rows").absolute().inset_0()))
      .when(Boolean(this.loadError || this.note), el => el.child(v_flex().max_h(140).px(12).py(8).gap(5).overflow_y_scrollbar().flex_none().text_size(11).text_color(t.ansi1)
        .child(div().child(this.loadError || this.note))
        .when(Boolean(this.loadError), el => el.child(div().text_size(10).text_color(t.muted).child(this.prs.length ? "Showing the last successful refresh. Press R to retry." : "Press R to retry.")))))
      .child(div().h(25).px(12).flex_none().flex().items_center().text_size(10).text_color(t.muted).child(" j/k move · h/l fold · Enter open · R refresh"));
  }
}
