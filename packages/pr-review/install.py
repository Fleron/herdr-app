#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

PACKAGE = Path(__file__).resolve().parent


class Herdr:
    def __init__(self, home):
        self.home = home.resolve()
        self.cli = shutil.which("herdr-app")
        if not self.cli:
            raise RuntimeError("Install Herdr's herdr-app command before installing this mod.")
        self.env = dict(os.environ, HERDR_APP_HOME=str(self.home))

    def call(self, *args):
        result = subprocess.run([self.cli, *args], env=self.env, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"Herdr exited {result.returncode}")
        data = json.loads(result.stdout)
        if isinstance(data, dict) and data.get("ok") is False:
            raise RuntimeError(data.get("error", "Herdr rejected the command"))
        return data

    def do(self, command, **args):
        return self.call("do", command, json.dumps(args))


def find(node, name):
    if node.get("id") == name:
        return node
    for child in node.get("children", []):
        result = find(child, name)
        if result is not None:
            return result
    return None


def available(folder, stem, suffix=""):
    candidate = stem
    number = 2
    while (folder / (candidate + suffix)).exists():
        candidate = f"{stem}-{number}"
        number += 1
    return candidate


def install(app, source_layout):
    status = app.call("status")
    original_layout = status["layout"]
    source_layout = source_layout or original_layout
    layout = json.loads((app.home / "layouts" / f"{source_layout}.json").read_text())
    tabs = find(layout, "tabs")
    body = find(layout, "panel-body")
    if not tabs or not body or body.get("type") != "stack":
        raise RuntimeError("This layout has no standard tabs/panel-body stack. It has not been changed.")
    if any(child.get("id") == "pull-requests" for child in body.get("children", [])):
        raise RuntimeError("This layout already has a PR panel. Choose --layout main to install a separate copy.")
    tabs_source = tabs.get("content", {}).get("mod")
    if not tabs_source:
        raise RuntimeError("This layout's tabs are not supplied by a mod. It has not been changed.")
    source_tabs = (app.home / "mods" / tabs_source / "main.js").read_text()
    anchor = '.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))'
    if source_tabs.count(anchor) != 1:
        raise RuntimeError("This tab-bar version has a different panel structure. It has not been changed.")

    subprocess.run(["cargo", "build", "--manifest-path", str(PACKAGE / "helper/Cargo.toml"), "--release", "--locked"], check=True)
    mod = available(app.home / "mods", "pull-requests")
    tabs_name = available(app.home / "mods", "pull-requests-tabs")
    layout_name = available(app.home / "layouts", "pr-review", ".json")
    destination = app.home / "mods" / mod
    switched = False
    try:
        (app.home / "data" / mod).mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copytree(PACKAGE / "mods/pull-requests", destination,
                        ignore=shutil.ignore_patterns("gpui-kit.d.ts", "jsconfig.json"))
        if mod != "pull-requests":
            for path in destination.rglob("*"):
                if path.suffix in {".js", ".json"}:
                    path.write_text(path.read_text().replace("pull-requests", mod))
        shutil.copy2(PACKAGE / "helper/target/release/herdr-pr", destination / "herdr-pr")
        (destination / "herdr-pr").chmod(0o755)
        record = {"home": str(app.home), "cli": app.cli, "originalLayout": original_layout,
                  "layout": layout_name, "tabs": tabs_name, "mod": mod}
        (destination / "installation.json").write_text(json.dumps(record, indent=2) + "\n")
        checked = subprocess.run([app.cli, "check", str(destination)], env=app.env, capture_output=True, text=True, timeout=60)
        if checked.returncode:
            raise RuntimeError(checked.stderr.strip() or checked.stdout.strip())
        app.do("mod.clone", name=tabs_source, **{"as": tabs_name})
        tabs_path = app.home / "mods" / tabs_name / "main.js"
        text = tabs_path.read_text()
        if text.count(anchor) != 1:
            raise RuntimeError("Cloning changed the tab-bar structure; installation stopped.")
        addition = f'.when(enabled.includes("pull-requests"), el => el.child(panelButton("pull-requests", "PRs", "mods/{mod}/git-pull-request-16.svg")))'
        tabs_path.write_text(text.replace(anchor, anchor + "\n      " + addition))
        app.do("layout.clone", name=source_layout, **{"as": layout_name})
        switched = True
        layout_path = app.home / "layouts" / f"{layout_name}.json"
        personal = json.loads(layout_path.read_text())
        find(personal, "tabs")["content"]["mod"] = tabs_name
        find(personal, "panel-body")["children"].append({
            "id": "pull-requests", "type": "block", "content": {"mod": mod, "props": {"role": "list"}}
        })
        layout_path.write_text(json.dumps(personal, indent=2) + "\n")
        app.do("layout.set", layout=personal)
        app.do("layout.select", stack="panel-body", child="pull-requests")
        app.do("layout.show", id="panel")
        print(json.dumps(record, indent=2))
        print(f"Restore the previous layout: python3 {PACKAGE / 'install.py'} --home {app.home} --restore {mod}")
    except Exception:
        if switched:
            try:
                app.do("layout.switch", name=original_layout)
            except Exception as error:
                print(f"Restore {original_layout} from Herdr's layout menu: {error}", file=sys.stderr)
        raise


def main():
    parser = argparse.ArgumentParser(description="Install the personal Herdr PR review package without overwriting existing files.")
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app")))
    parser.add_argument("--layout", help="Layout to copy; defaults to the currently selected layout")
    parser.add_argument("--restore", metavar="MOD", help="Switch back to the layout recorded by this installation; retain work and drafts")
    args = parser.parse_args()
    app = Herdr(args.home)
    if args.restore:
        if not args.restore.replace("-", "").replace("_", "").isalnum():
            raise RuntimeError("Invalid installation name")
        record = json.loads((app.home / "mods" / args.restore / "installation.json").read_text())
        if Path(record["home"]).resolve() != app.home:
            raise RuntimeError("This installation belongs to a different Herdr home")
        app.do("layout.switch", name=record["originalLayout"])
        print(f"Restored {record['originalLayout']}; PR tabs, drafts and checkouts were retained.")
    else:
        install(app, args.layout)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"PR mod installation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
