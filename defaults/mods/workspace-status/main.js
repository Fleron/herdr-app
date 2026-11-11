import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover, ScrollHandle } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, exec, readTextFile } from "herdr";
import { createUsage, usageText, usageDetail } from "./usage.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.width = Infinity;
    this.usage = createUsage({ home: home(), platform: window()?.platform, exec, readTextFile, fetch });
    this.usageFocus = this.usage.providers.map(() => cx.focus_handle());
    this.refreshFocus = this.usage.providers.map(() => cx.focus_handle());
    this.detailScroll = this.usage.providers.map(() => ScrollHandle.new());
    this.detailRow = this.usage.providers.map(() => 0);
    this.details = null;
    this.refresh(cx);
    cx.timer.every(30_000, cx => this.refresh(cx));
  }

  close() { for (const scroll of this.detailScroll) scroll.release(); }

  refresh(cx, force = false, selected = null) {
    if (!window()?.active && !force) return;
    for (const state of this.usage.providers.filter(s => !selected || s.name === selected)) {
      cx.spawn(async cx => { const pending = this.usage.refresh(state, force); cx.notify(); await pending; cx.notify(); });
    }
  }

  usageIndicator(state, index, t) {
    const handle = this.usageFocus[index];
    const detail = usageDetail(state, Date.now());
    const trigger = div().id(`usage-${state.name.toLowerCase()}`).role("button").track_focus(handle).tab_stop(true)
      .h(24).min_w(24).px(4).flex().items_center().rounded(4).border_1().border_color(handle.is_focused() ? t.foreground : t.chrome)
      .text_color(state.status === "ready" ? t.foreground : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(detail).accessibility_label(`${usageText(state, Date.now(), true)}${state.windows.length ? " remaining" : ""}. Open usage details.`)
      .on_mouse_down("left", () => handle.focus())
      .child(div().truncate().child(usageText(state, Date.now(), this.width < 900)));
    const refresh = (_e, cx) => this.refresh(cx, true, state.name);
    const [title, ...lines] = detail.split("\n");
    const button = div().id(`refresh-${state.name}`).role("button").track_focus(this.refreshFocus[index]).tab_stop(true)
      .h(26).min_w(24).px(6).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(this.refreshFocus[index].is_focused() ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_click(refresh)
      .on_key_down((e, cx) => {
        if (["enter", "space", " "].includes(e.key)) { cx.stop_propagation(); refresh(e, cx); }
      })
      .child(state.busy ? "Refreshing…" : "Refresh");
    const content = v_flex().w(Math.max(100, Math.min(380, this.width - 28))).p(12).gap(10).bg(t.popover).text_color(t.foreground).text_size(12)
      .border_1().border_color(t.border).rounded(6)
      .child(h_flex().gap(10).items_center().child(div().flex_1().child(title)).child(button))
      .child(v_flex().id(`usage-rows-${state.name}`).max_h(260).gap(8).overflow_y_scrollbar().track_scroll(this.detailScroll[index])
        .children(lines.map(line => div().child(line))))
      .on_key_down((e, cx) => {
        const steps = { up: -1, down: 1, pageup: -5, pagedown: 5 };
        if (!(e.key in steps) && !["home", "end"].includes(e.key)) return;
        this.detailRow[index] = e.key === "home" ? 0 : e.key === "end" ? lines.length - 1 : Math.max(0, Math.min(lines.length - 1, this.detailRow[index] + steps[e.key]));
        this.detailScroll[index].scroll_to_item(this.detailRow[index]);
        cx.stop_propagation(); cx.notify();
      });
    return Popover.new(`usage-details-${state.name}`).anchor("bottom_right")
      .open(this.details === state.name).track_focus(this.refreshFocus[index])
      .on_open_change((open, cx) => { this.details = open ? state.name : null; this.detailRow[index] = 0; this.detailScroll[index].scroll_to_item(0); cx.notify(); })
      .trigger(trigger).content(content);
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .on_size_change((size, cx) => { if (this.width !== Math.floor(size.width)) { this.width = Math.floor(size.width); cx.notify(); } })
      .when(this.width >= 380, el => el.child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer").max_w(160).truncate()))
      .when(this.width >= 600 && Boolean(space?.branch), el => el.child(label("branch", space.branch).max_w(160).truncate()))
      .when(this.width >= 600, el => el.child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`)))))
      .child(h_flex().flex_1().min_w(0).gap(4).justify_end().children(this.usage.providers.map((s, i) => this.usageIndicator(s, i, t))))
      .when(this.width >= 900, el => el.child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t))));
  }
}
