export const GROUPS = [
  { id: "queue", label: "Merge queue", icon: "git-pull-request-16.svg", color: "ansi5", matches: pr => pr.state === "In queue" },
  { id: "ready", label: "Ready for review", icon: "git-pull-request-16.svg", color: "ansi2", matches: pr => pr.state === "Open" },
  { id: "drafts", label: "Drafts", icon: "git-pull-request-draft-16.svg", color: "muted", matches: pr => pr.state === "Draft" },
];

export function checksSummary(value = {}) {
  const result = Object.fromEntries(["total", "passed", "failed", "running", "waiting", "skipped", "neutral", "unknown"].map(key => [key, Number(value[key] ?? 0)]));
  result.status = result.running ? "running" : result.failed ? "failed" : result.waiting ? "waiting" : result.unknown ? "unknown" : result.total > 0 ? "passed" : "neutral";
  result.description = result.total ? ["passed", "failed", "running", "waiting", "skipped", "neutral", "unknown"].filter(key => result[key]).map(key => `${result[key]} ${key}`).join(" · ") : "No checks reported";
  result.label = result.running ? `${result.running} checks running` : result.failed ? `${result.failed} checks failed` : result.waiting ? `${result.waiting} checks waiting` : result.unknown ? `${result.unknown} checks unknown` : result.total ? `${result.passed}/${result.total} checks passed` : "No checks";
  return result;
}

export function reviewDecision(value) {
  if (value === "APPROVED") return { label: "Review approved", status: "passed" };
  if (value === "CHANGES_REQUESTED") return { label: "Changes requested", status: "failed" };
  if (value === "REVIEW_REQUIRED") return { label: "Review required", status: "waiting" };
  return { label: "No review decision", status: "neutral" };
}

export function orderedPrs(prs) {
  return [...prs].sort((a, b) => a.state === "In queue" && b.state === "In queue" ? (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity) || b.number - a.number : b.number - a.number);
}

export async function collectPages(read, field = "items") {
  const result = [], cursors = new Set();
  let cursor = null;
  for (;;) {
    const page = await read(cursor);
    if (!Array.isArray(page[field])) throw new Error(`The server did not return ${field}`);
    result.push(...page[field]);
    const next = page.pageInfo ? page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null : page.nextCursor;
    if (next === null || next === undefined) {
      if (page.pageInfo?.hasNextPage) throw new Error("The server did not return the next page cursor");
      return result;
    }
    const identity = String(next);
    if (cursors.has(identity)) throw new Error("The server repeated a page cursor");
    cursors.add(identity); cursor = next;
  }
}

export function selectionThread(rows, selection, path, body) {
  const selected = rows.slice(Math.min(selection.anchor, selection.end), Math.max(selection.anchor, selection.end) + 1);
  if (!body.trim()) throw new Error("Write a comment before adding it");
  if (!selected.length || selected.some(row => row.kind === "@")) throw new Error("Select code lines within one diff hunk");
  const deleted = selected.some(row => row.kind === "-"), added = selected.some(row => row.kind === "+");
  if (deleted && added) throw new Error("Select lines from one side of the change");
  const side = deleted ? "LEFT" : "RIGHT", field = deleted ? "old" : "next";
  const lines = selected.map(row => row[field]).filter(line => Number.isInteger(line) && line > 0);
  if (lines.length !== selected.length) throw new Error("The selected lines have no review location");
  return { path, body: body.trim(), side, line: lines[lines.length - 1], ...(lines.length > 1 ? { startLine: lines[0], startSide: side } : {}) };
}

export function sessionKey(repo, number, machine = "local") { return `${machine}:${repo.key}#${number}`; }
export function draftKey(repo, number, comparisonKey) {
  if (typeof comparisonKey !== "string" || !comparisonKey) throw new Error("The review comparison is missing");
  return `${repo.key}#${number}@${comparisonKey}`;
}
