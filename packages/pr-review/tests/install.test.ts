import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../install.py", import.meta.url));
const stock = readFileSync(new URL("../../../defaults/mods/tabs/main.js", import.meta.url), "utf8");
const originalLayout = JSON.parse(readFileSync(new URL("../../../defaults/layouts/main.json", import.meta.url), "utf8"));

function patch(source: string) {
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("pr_installer",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.tabs_with_prs(json.load(sys.stdin),"pull-requests")))`;
  const result = Bun.spawnSync(["python3", "-c", script, installer], { stdin: Buffer.from(JSON.stringify(source)) });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

const patched = patch(stock);

function find(node: any, id: string): any {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
}

function element() {
  const node: any = { children: [] };
  let proxy: any;
  proxy = new Proxy({}, { get: (_target, method) => {
    if (method === "node") return node;
    return (...args: any[]) => {
      if (method === "child") node.children.push(args[0]?.node ?? args[0]);
      else if (method === "children") node.children.push(...args[0].map((child: any) => child?.node ?? child));
      else if (method === "when" && args[0]) args[1](proxy);
      else if (method === "id") node.id = args[0];
      else if (method === "on_click") node.click = args[0];
      return proxy;
    };
  } });
  return proxy;
}

function nodes(node: any): any[] {
  return [node, ...(node?.children ?? []).flatMap((child: any) => typeof child === "object" ? nodes(child) : [])];
}

function render(preferences: string[] | undefined, withPr = true) {
  const layout = structuredClone(originalLayout);
  if (withPr) find(layout, "panel-body").children.push({ id: "pull-requests", type: "block", content: { mod: "pull-requests", props: { role: "list" } } });
  const storage = new Map<string, string>(), calls: any[] = [];
  const theme = new Proxy({}, { get: () => "#888888" });
  const source = patched.replace(/^import .*;\n/gm, "").replace("export default class Tabs", "class Tabs");
  const Tabs = new Function("View", "div", "svg", "image", "h_flex", "ScrollHandle", "spaces", "panes", "run", "openOverlay", "theme", "window", "shared", "layout", "settings", "localStorage", source + "\nreturn Tabs;")(
    class {}, element, element, element, element, { new: () => ({ scroll_to_item() {} }) },
    () => [{ id: "space", active: true, tabs: [] }], () => [], (name: string, args: any) => calls.push({ name, args }),
    () => {}, () => theme, () => ({ platform: "macos", titlebar: "none", buttons: false }),
    (key: string) => key === "workspace.panels" ? preferences : undefined, () => layout, () => ({ zoom: 1 }),
    { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  );
  const tabs = new Tabs();
  tabs.init();
  const all = nodes(tabs.render().node);
  calls.length = 0;
  return { all, calls };
}

test("fresh stock panel preferences still show and open the installed PR panel", () => {
  const preferences = ["files", "changes"];
  const { all, calls } = render(preferences);
  const button = all.find(node => node.id === "panel-pull-requests");
  expect(button).toBeDefined();
  button.click();
  expect(calls).toEqual([
    { name: "layout.select", args: { stack: "panel-body", child: "pull-requests" } },
    { name: "layout.show", args: { id: "panel" } },
  ]);
  expect(preferences).toEqual(["files", "changes"]);
});

test("the PR layout respects disabled built-in panels", () => {
  const ids = render(["changes"]).all.map(node => node.id);
  expect(ids).not.toContain("panel-files");
  expect(ids).toContain("panel-changes");
  expect(ids).toContain("panel-pull-requests");
});

test("a missing PR slot cannot produce a PR button from stale shared preferences", () => {
  const ids = render(["files", "changes", "pull-requests"], false).all.map(node => node.id);
  expect(ids).not.toContain("panel-pull-requests");
  expect(ids).toContain("panel-files");
  expect(ids).toContain("panel-changes");
});

test("the installed personal tab bar can be repaired without duplicating the PR button", () => {
  expect(patch(patched)).toBe(patched);
  expect(render(undefined).all.filter(node => node.id === "panel-pull-requests")).toHaveLength(1);
});
