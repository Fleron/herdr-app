import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Radio, RadioGroup, Textarea, TextareaState } from "gpui-base";
import { props, theme, setShared, closeOverlay, nextCommand } from "herdr";
import { helper, nextDraft } from "./client.js";

const OPTIONS = [
  { event: "COMMENT", label: "Comment" },
  { event: "APPROVE", label: "Approve" },
  { event: "REQUEST_CHANGES", label: "Request changes" },
];

export default class Compose {
  init(_p, cx) {
    cx.bind_keys([
      { keystroke: "cmd-enter", action: "pr_review_submit", context: "PRReviewComposer > Input" },
      { keystroke: "cmd-enter", action: "pr_review_submit", context: "PRReviewComposer" },
      { keystroke: "escape", action: "pr_review_choose", context: "PRReviewComposer > Input" },
      { keystroke: "escape", action: "pr_review_close", context: "PRReviewComposer" },
    ]);
    this.p = props() ?? {};
    this.key = this.p.key;
    this.draft = this.p.draft ?? {};
    this.event = this.draft.event ?? "COMMENT";
    this.attempt = null; this.candidates = []; this.loading = true; this.generation = 0;
    this.body = TextareaState.new({ value: this.draft.body ?? "", placeholder: "Leave a comment…", rows: 5 });
    this.body.on("change", (_e, cx) => { this.changed = true; this.error = null; this.scheduleSave(cx); cx.notify(); });
    this.body.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.body.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.handle = cx.focus_handle(); this.body.focus();
    cx.timer.after(100, () => this.body.focus());
    cx.spawn(async cx => {
      try {
        const state = await helper("draft.get", { key: this.key });
        this.attempt = state.attempt;
        if (!this.changed && state.draft) {
          this.draft = state.draft; this.event = this.draft.event ?? "COMMENT";
          this.body.set_value(this.draft.body ?? "");
        }
        if (this.attempt?.state === "confirmed") await this.confirmed(this.attempt);
      } catch (error) { this.error = error.message; }
      this.loading = false;
      if (!this.sent) this.body.focus();
      cx.notify();
    });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.body.focus();
        else if (command === "select-approve") this.choose("APPROVE", cx);
        else if (command === "select-changes") this.choose("REQUEST_CHANGES", cx);
        else if (command === "submit") this.submit(cx);
        else if (command === "reconcile") this.reconcile(cx);
        cx.notify();
      }
    });
  }

  snapshot() { return { ...this.draft, body: this.body.value(), event: this.event }; }
  scheduleSave(cx) {
    const generation = ++this.generation;
    cx.timer.after(300, cx => { if (generation === this.generation && !this.sending && !this.sent) this.save(cx); });
  }
  async persist() {
    const draft = this.snapshot();
    this.draft = draft;
    const pending = (this.saving ?? Promise.resolve()).catch(() => {}).then(() => helper("draft.save", { key: this.key, draft: { body: draft.body, event: draft.event } }));
    this.saving = pending;
    await pending;
    setShared("pull-requests.draft-saved." + this.key, { body: draft.body, event: draft.event, token: Date.now() + ":" + (this.saveVersion = (this.saveVersion ?? 0) + 1) });
  }
  save(cx) {
    cx.spawn(async cx => {
      try { await this.persist(); }
      catch (error) { this.error = "Draft could not be saved: " + error.message; }
      cx.notify();
    });
  }
  choose(event, cx) {
    if (this.sending) return;
    this.changed = true; this.event = event; this.scheduleSave(cx); cx.notify();
  }
  async close() { if (!this.sent && !this.sending) await this.persist(); }
  dismiss(cx) {
    if (this.sending) return;
    if (this.sent) { closeOverlay(this.p.overlay); return; }
    cx.spawn(async cx => {
      try { await this.persist(); closeOverlay(this.p.overlay); }
      catch (error) { this.error = error.message; cx.notify(); }
    });
  }
  reconcile(cx, reviewId = null) {
    if (this.sending) return;
    this.sending = true; this.error = null;
    this.handle.focus(); this.typing = false;
    cx.spawn(async cx => {
      try {
        const value = await helper(reviewId ? "review.adopt" : "review.reconcile", { key: this.key, ...(reviewId ? { reviewId } : {}) });
        this.attempt = value.attempt ?? value;
        this.candidates = value.candidates ?? this.attempt.candidates ?? [];
        if (this.attempt.state === "confirmed") await this.confirmed(this.attempt);
      } catch (error) { this.error = error.message; }
      this.sending = false; cx.notify();
    });
  }
  restart(cx) {
    if (this.sending) return;
    this.sending = true;
    cx.spawn(async cx => {
      try {
        const value = await helper("review.restart", { key: this.key, acknowledgeRisk: true, githubInspected: true });
        this.attempt = value.attempt ?? value; this.candidates = []; this.error = null;
      } catch (error) { this.error = error.message; }
      this.sending = false; cx.notify();
    });
  }
  async confirmed(attempt) {
    this.sent = true;
    await nextDraft(this.p.repo, this.p.number, this.p.comparisonKey, this.key, this.draft.inlineDrafts ?? {});
    setShared("pull-requests.published." + this.key, attempt);
    closeOverlay(this.p.overlay);
  }
  submit(cx) {
    if (this.sending || this.loading || this.sent || ["sending", "outcome-unknown"].includes(this.attempt?.state)) return;
    const body = this.body.value().trim(), threads = this.draft.threads ?? [];
    if (this.event !== "APPROVE" && !body && !threads.length) { this.error = "Add a summary or a line comment before submitting."; cx.notify(); return; }
    this.sending = true; this.error = null;
    this.handle.focus(); this.typing = false;
    cx.spawn(async cx => {
      try {
        await this.persist();
        const value = await helper("review.submit", { repo: this.p.repo, number: this.p.number, headOid: this.p.headOid, baseOid: this.p.baseOid, key: this.key, body, event: this.event, threads });
        this.attempt = value.attempt ?? value;
        if (this.attempt.state === "confirmed") await this.confirmed(this.attempt);
        else this.error = this.attempt.error?.message ?? "The review has not been confirmed. Recheck GitHub before submitting again.";
      } catch (error) {
        this.error = error.message;
        try { this.attempt = (await helper("draft.get", { key: this.key })).attempt; } catch {}
      }
      this.sending = false; cx.notify();
    });
    cx.notify();
  }

  render() {
    const t = theme(), notes = this.draft.threads?.length ?? 0;
    const unknown = ["sending", "outcome-unknown"].includes(this.attempt?.state);
    const ready = !this.loading && !this.sending && !this.sent && this.attempt?.state !== "confirmed" && !unknown && (this.event === "APPROVE" || Boolean(this.body.value().trim()) || notes > 0);
    return v_flex().id("review-compose").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.popover).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .key_context("PRReviewComposer")
      .on_action("pr_review_submit", (_e, cx) => { cx.stop_propagation(); this.submit(cx); })
      .on_action("pr_review_choose", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.typing = false; cx.notify(); })
      .on_action("pr_review_close", (_e, cx) => { cx.stop_propagation(); this.dismiss(cx); })
      .on_key_down((e, cx) => {
        if (this.typing || this.sending) return;
        if (e.key === "j" || e.key === "k") this.choose(OPTIONS[(OPTIONS.findIndex(option => option.event === this.event) + (e.key === "j" ? 1 : 2)) % 3].event, cx);
        else if (e.key === "i") this.body.focus();
        else if (["1", "2", "3"].includes(e.key)) this.choose(OPTIONS[Number(e.key) - 1].event, cx);
        else return;
        cx.stop_propagation();
      })
      .child(v_flex().flex_none().p(20).gap(6)
        .child(h_flex().items_center().gap(12)
          .child(div().flex_1().font_semibold().text_size(17).child(this.sent ? "Review submitted" : "Finish your review"))
          .child(Button.new("review-close").w(28).h(28).rounded(5).disabled(this.sending).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => this.dismiss(cx)).child(svg("mods/workspace-chrome/x.svg").size(14))))
        .child(div().text_color(t.muted).truncate().child("#" + this.p.number + " · " + this.p.title)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().px(20).gap(14)
        .child(this.loading || this.sending || this.sent
          ? div().h(132).px(10).py(9).rounded(5).border_1().border_color(t.input).bg(t.background).overflow_y_scrollbar().text_size(13).child(this.body.value())
          : Textarea.new(this.body).h(132).px(10).py(9).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(13))
        .child(RadioGroup.new("review-kind").flex().flex_col().gap(0)
          .children(OPTIONS.map(option => Radio.new("review-" + option.event).checked(this.event === option.event).h(34).px(5)
            .on_click((_e, cx) => this.choose(option.event, cx))
            .child(h_flex().w_full().items_center().gap(10)
              .child(div().size(14).rounded_full().border_1().border_color(this.event === option.event ? t.accent : t.muted)
                .flex().items_center().justify_center().when(this.event === option.event, el => el.child(div().size(8).rounded_full().bg(t.accent))))
              .child(div().child(option.label))))))
        .when(notes > 0, el => el.child(div().text_size(12).text_color(t.muted).child(String(notes) + " pending line comments")))
        .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
        .when(unknown, el => el.child(h_flex().gap(8)
          .child(Button.new("review-reconcile").h(28).px(8).border_1().border_color(t.border).rounded(5).disabled(this.sending).on_click((_e, cx) => this.reconcile(cx)).child("Recheck GitHub"))
          .child(Button.new("review-github").h(28).px(8).on_click((_e, cx) => cx.open_url(this.p.url)).child("Open on GitHub"))))
        .when(unknown && !this.attempt?.reviewId && Boolean(this.attempt?.reconciledAt), el => el.child(v_flex().gap(8)
          .child(div().text_size(12).text_color(t.muted).child("A previous review may still exist. Check GitHub first; starting another attempt could duplicate it."))
          .child(Button.new("review-restart").h(32).px(8).border_1().border_color(t.border).rounded(5).disabled(this.sending)
            .on_click((_e, cx) => this.restart(cx)).child("I checked GitHub. Start another attempt"))))
        .children(this.candidates.map(candidate => Button.new("adopt-" + candidate.id).w_full().py(8).on_click((_e, cx) => this.reconcile(cx, candidate.id))
          .child(div().text_size(12).child("Use pending review " + candidate.id).tooltip(candidate.body ?? "")))))
      .child(h_flex().flex_none().p(20).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(11).text_color(t.muted).child(this.sending ? "Submitting…" : this.typing ? "Esc choose · ⌘Enter submit" : "j/k choose · 1/2/3 · i edit"))
        .child(Button.new("review-cancel").h(32).px(14).rounded(6).border_1().border_color(t.border).disabled(this.sending).on_click((_e, cx) => this.dismiss(cx)).child("Cancel"))
        .child(Button.new("review-submit").h(32).px(14).rounded(6).bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.muted).disabled(!ready).on_click((_e, cx) => this.submit(cx)).child("Submit review")));
  }
}
