import { appHome, exec, readTextFile, writeTextFile, spaces, panes, shared, setShared } from "herdr";
import { sessionKey, draftKey } from "./model.js";

export function currentDraft(repo, number, comparisonKey, fresh = false) {
  const reference = `pull-requests.draft.${draftKey(repo, number, comparisonKey)}`;
  let key = fresh ? null : shared(reference);
  if (!key) {
    key = `${draftKey(repo, number, comparisonKey)}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setShared(reference, key);
  }
  return key;
}

const rotatingDrafts = new Map();
export function nextDraft(repo, number, comparisonKey, previous, inlineDrafts = {}) {
  const active = currentDraft(repo, number, comparisonKey);
  if (active !== previous) return Promise.resolve(active);
  if (rotatingDrafts.has(previous)) return rotatingDrafts.get(previous);
  const key = `${draftKey(repo, number, comparisonKey)}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pending = helper("draft.save", { key, draft: { inlineDrafts } }).then(() => {
    if (currentDraft(repo, number, comparisonKey) === previous) setShared(`pull-requests.draft.${draftKey(repo, number, comparisonKey)}`, key);
    return currentDraft(repo, number, comparisonKey);
  }).finally(() => rotatingDrafts.delete(previous));
  rotatingDrafts.set(previous, pending);
  return pending;
}

export async function helper(op, fields = {}) {
  const root = `${appHome()}/data/pull-requests`;
  const request = `${root}/requests/${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  await writeTextFile(request, JSON.stringify({ op, ...fields }), null);
  const result = await exec(`${appHome()}/mods/pull-requests/herdr-pr`, ["--state", root, "--request", request], { timeout: 600000 });
  let reply;
  try { reply = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || "The PR helper returned an incomplete response"); }
  if (!reply.ok || result.code !== 0) {
    const error = new Error(reply.error?.message ?? result.stderr ?? "The PR helper failed");
    error.code = reply.error?.code; error.details = reply.error?.details;
    throw error;
  }
  return reply.data;
}

export function activeRepositoryLocation() {
  const space = spaces().find(space => space.active);
  if (!space) throw new Error("Select a space to see its pull requests");
  if (space.machine) throw new Error("Pull requests currently support local repositories");
  const tabs = new Set(space.tabs.map(tab => tab.id));
  const cwd = panes().find(pane => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
  if (!cwd) throw new Error("Open a repository folder in this space");
  return { space, cwd };
}

export async function command(name, args) {
  const text = await readTextFile(`${appHome()}/mods/pull-requests/installation.json`);
  if (text === null) throw new Error("Install the PR package before opening review tabs");
  const installation = JSON.parse(text);
  if (!installation.cli || installation.home !== appHome()) throw new Error("The PR installation does not match this Herdr home; run the installer again");
  const result = await exec(installation.cli, ["do", name, JSON.stringify(args)]);
  let reply;
  try { reply = JSON.parse(result.stdout); } catch {
    const error = new Error(result.stderr || `Herdr did not acknowledge ${name}`);
    error.uncertain = true; throw error;
  }
  if (result.code !== 0 || reply.ok === false || reply.error) {
    const error = new Error(reply.error ?? result.stderr ?? `Herdr could not ${name}`);
    error.uncertain = !reply.error; throw error;
  }
  return reply;
}

export function session(repo, number) { return shared(`pull-requests.session.${sessionKey(repo, number)}`); }
export function updateSessionTarget(repo, number, previous, target) {
  const state = session(repo, number);
  if (!state || state.target?.key !== previous.key) return;
  setShared(`pull-requests.session.${sessionKey(repo, number)}`, { ...state, target });
}

const opening = new Map();
export function openPullRequest(repo, pr, space, cx) {
  const key = sessionKey(repo, pr.number);
  if (opening.has(key)) return opening.get(key);
  const pending = doOpen(repo, pr, space, cx).finally(() => opening.delete(key));
  opening.set(key, pending);
  return pending;
}

async function doOpen(repo, pr, space, cx) {
  const key = sessionKey(repo, pr.number), previous = session(repo, pr.number);
  let state;
  if (previous && spaces().some(space => space.tabs.some(tab => tab.id === previous.tab))) {
    await command("tab.select", { id: previous.tab });
    setShared(`pull-requests.checkout-check.${key}`, Date.now());
    if (previous.setupStage === "uncertain") return previous;
    if (previous.reviewPane && panes().some(pane => pane.pane === previous.reviewPane && pane.tab === previous.tab)
      && (!previous.setupStage || ["ready", "uncertain"].includes(previous.setupStage))) return previous;
    state = previous;
  } else {
    const prepared = await helper("git.prepare", { repo, pr });
    const created = await command("tab.new", { space: space.id, name: `#${pr.number} ${pr.title}`, folder: prepared.target.checkout });
    if (!created.tab || !created.terminal || created.space !== space.id) throw new Error("Herdr did not return the new PR tab identity");
    state = { tab: created.tab, terminal: created.terminal, target: prepared.target, repo, number: pr.number };
    setShared(`pull-requests.session.${key}`, state);
  }
  const target = state.target;
  let terminalPane = panes().find(pane => pane.terminal === state.terminal && pane.tab === state.tab);
  for (let attempt = 0; !terminalPane && attempt < 20; attempt++) {
    await new Promise(resolve => cx.timer.after(50, resolve));
    terminalPane = panes().find(pane => pane.terminal === state.terminal && pane.tab === state.tab);
  }
  if (!terminalPane) throw new Error("The PR terminal was created; its pane has not appeared. Its tab is kept.");
  if (!state.reviewPane || !panes().some(pane => pane.pane === state.reviewPane && pane.tab === state.tab)) {
    let split;
    try { split = await command("pane.split", { pane: terminalPane.pane, direction: "right", mod: "pull-requests", props: { role: "review", repo, number: pr.number, target, sessionKey: key } }); }
    catch (error) {
      if (error.uncertain) {
        state.setupStage = "uncertain"; state.warning = "The PR tab is kept. Check its panes: Herdr did not acknowledge the review split.";
        setShared(`pull-requests.session.${key}`, state);
      }
      throw error;
    }
    if (!split.pane) throw new Error("Herdr did not return the review pane identity");
    state.reviewPane = split.pane; state.terminalPane = terminalPane.pane; state.setupStage = "split";
    setShared(`pull-requests.session.${key}`, state);
  }
  const advance = stage => {
    const current = session(repo, pr.number);
    if (current?.tab === state.tab) state.target = current.target;
    state.setupStage = stage; delete state.warning; setShared(`pull-requests.session.${key}`, state);
  };
  try {
    if (state.setupStage === "split") { await command("pane.swap", { pane: state.terminalPane, target: state.reviewPane }); advance("swapped"); }
    if (state.setupStage === "swapped") { await command("layout.resize", { id: state.reviewPane, weight: 7 }); advance("review-sized"); }
    if (state.setupStage === "review-sized") { await command("layout.resize", { id: state.terminalPane, weight: 3 }); advance("ready"); }
  } catch (error) {
    if (error.uncertain) {
      state.setupStage = "uncertain"; state.warning = "The review tab is kept. Herdr did not acknowledge its layout; check the pane arrangement before continuing.";
      setShared(`pull-requests.session.${key}`, state);
    }
    throw error;
  }
  await command("pane.focus", { pane: state.reviewPane });
  return state;
}
