#!/usr/bin/env python3
"""Create-only installer for the agent lifecycle. It never edits, replaces or deletes a file the
target already has; for those it writes proposals into .lifecycle-adoption/ for a human (ADR 0015).

  adopt.py install --target T --template H [--owner O | --owner-pending] [--commands JSON]
                   [--source-glob G]... [--dry-run]
  adopt.py undo --target T      # removes exactly what install created, from a validated MANIFEST
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

FOLDER = ".lifecycle-adoption"
START, END = "<!-- agent-lifecycle:start -->", "<!-- agent-lifecycle:end -->"
SKILLS = ["adversarial-panel", "consistency-read", "risk-tier"]
HOOKS = ["guard-approval", "stop-check"]
MANAGED = ["scripts/check-change.sh", "scripts/sync-skills.sh", "scripts/lib/check_change.py",
           "scripts/lib/adopt.py", ".claude/hooks/guard-approval.sh", ".claude/hooks/stop-check.sh"]
INSTALL = ["AGENTS.md", "CLAUDE.md", ".pre-commit-config.yaml", ".claude/settings.json",
           ".github/workflows/lifecycle.yml", ".github/workflows/release.yml", ".github/dependabot.yml",
           ".github/pull_request_template.md", "docs/lifecycle.md", "docs/security.md", "docs/templates",
           "docs/decisions", *MANAGED]
CODEOWNERS_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
GUIDES = ["AGENTS.md", "CLAUDE.md", ".claude/settings.json", "openspec/config.yaml"]


def clean(value) -> str:
    """Target-controlled text is shown as data: control characters become '?'."""
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "?", str(value))


def inside(root_real: str, path: Path | str) -> bool:
    real = os.path.realpath(path)
    return real == root_real or real.startswith(root_real + os.sep)


# ---------------------------------------------------------------- proposals (pure functions)

def hook_referenced(data: dict, name: str) -> bool:
    ref = re.compile(rf"(?:^|[/\s\"']){re.escape(f'.claude/hooks/{name}.sh')}(?:[\"'\s]|$)")
    return any(ref.search(str(h.get("command", "")))
               for groups in (data.get("hooks") or {}).values() if isinstance(groups, list)
               for g in groups if isinstance(g, dict) for h in g.get("hooks", []) if isinstance(h, dict))


def propose_settings(text: str, tpl: dict, hook_ok: dict) -> tuple[dict | None, str | None]:
    """The target's settings with the template's deny rules, sandbox and hooks merged in."""
    try:
        data = json.loads(text)
    except ValueError as e:
        return None, f"not strict JSON ({e})"
    perms, sandbox, hooks = (data.get(k, {}) if isinstance(data, dict) else None
                             for k in ("permissions", "sandbox", "hooks"))
    if not all(isinstance(x, dict) for x in (data, perms, sandbox, hooks)):
        return None, "settings, permissions, sandbox and hooks must be JSON objects"
    if not all(isinstance(v, list) and all(isinstance(i, str) for i in v)
               for k, v in perms.items() if k in ("allow", "ask", "deny")):
        return None, "permission lists must be lists of strings"
    data = json.loads(text)  # fresh copy to modify
    deny = data.setdefault("permissions", {}).setdefault("deny", [])
    deny += [r for r in tpl["permissions"]["deny"] if r not in deny]
    data.setdefault("sandbox", {}).setdefault("enabled", True)
    for event, groups in tpl.get("hooks", {}).items():
        for group in groups:
            for hook in group["hooks"]:
                name = re.search(r"\.claude/hooks/([\w-]+)\.sh", hook["command"]).group(1)
                if hook_ok.get(name) and not hook_referenced(data, name):
                    data.setdefault("hooks", {}).setdefault(event, []).append({**group, "hooks": [hook]})
    return data, None


def risks(data: dict, differing_hooks: list[str]) -> list[str]:
    perms = data.get("permissions") if isinstance(data.get("permissions"), dict) else {}
    sandbox = data.get("sandbox") if isinstance(data.get("sandbox"), dict) else {}
    out = []
    if "bypassPermissions" in (perms.get("defaultMode"), data.get("defaultMode")):
        out.append("defaultMode is bypassPermissions: permission prompts and deny-by-ask are off")
    if data.get("disableAllHooks"):
        out.append("disableAllHooks is true: the Stop and approval hooks never run")
    if sandbox.get("allowUnsandboxedCommands"):
        out.append("sandbox.allowUnsandboxedCommands is true: commands can leave the sandbox")
    if sandbox.get("enabled") is False:
        out.append("sandbox.enabled is false: no filesystem or network isolation")
    for rule in perms.get("allow") or []:
        if isinstance(rule, str) and (re.fullmatch(r"[A-Za-z]+", rule) or rule.endswith("(*)")):
            out.append(f"broad allow rule {clean(rule)}: allows every use of that tool")
    out += [f".claude/hooks/{h}.sh already exists and differs from the template: not wired"
            for h in differing_hooks]
    return out


def top_level_blocks(text: str) -> dict[str, str]:
    """Split YAML text into its top-level key blocks (comments go with the block above)."""
    blocks, key = {}, None
    for line in text.splitlines(keepends=True):
        m = re.match(r"^([A-Za-z_][\w-]*):", line)
        if m:
            key = m.group(1)
        if key:
            blocks[key] = blocks.get(key, "") + line
    return blocks


def config_snippet(target_text: str, tpl_text: str, lifecycle: dict) -> tuple[str | None, list[str], str | None]:
    """Missing top-level sections to append by hand, plus lifecycle keys an existing block lacks."""
    try:
        data = yaml.safe_load(target_text)
    except yaml.YAMLError as e:
        return None, [], f"not valid YAML ({clean(e).splitlines()[0]})"
    if not isinstance(data, dict):
        return None, [], "top level is not a mapping"
    tpl = top_level_blocks(tpl_text)
    parts = [tpl[k].rstrip() + "\n" for k in ("context", "rules", "operations") if k not in data and k in tpl]
    if "lifecycle" not in data:
        parts.append(yaml.safe_dump({"lifecycle": lifecycle}, sort_keys=False, width=100))
        return "\n".join(parts), [], None
    have = data["lifecycle"] if isinstance(data["lifecycle"], dict) else {}
    return "\n".join(parts), [k for k in lifecycle if k not in have], None


def guide_blocks() -> tuple[str, str]:
    precedence = ("On conflict with other guidance in this repo, the lifecycle gates win; "
                  "tell the human so they can reconcile.")
    agents = "\n".join([
        START, "## Agent lifecycle", "",
        "This repo follows the agent lifecycle in docs/agent-lifecycle.md. Read it before any change.",
        "- A human approves every tier 1-2 change before code (`Approved-by:` in proposal.md).",
        "- CI must be green before merge; run `scripts/check-change.sh`.",
        precedence, END]) + "\n"
    claude = "\n".join([START, "@docs/agent-lifecycle.md", "", precedence, END]) + "\n"
    return agents, claude


def render_lifecycle(tpl_cfg: dict, commands: dict, source_globs: list[str]) -> dict:
    lc = dict(tpl_cfg["lifecycle"])
    lc["commands"] = {k: commands.get(k, "") for k in lc["commands"]}  # the template's own: never copied
    lc["source_globs"] = source_globs
    lc["managed_paths"] = list(MANAGED)
    lc["grandfathered_changes"] = []
    return lc


# ---------------------------------------------------------------- install

class Installer:
    def __init__(self, target: Path, template: Path, dry: bool):
        self.t, self.h, self.dry = target, template, dry
        self.real = os.path.realpath(target)
        self.created: list[str] = []
        self.skipped: list[str] = []
        self.outside: list[str] = []

    def record(self, rel: str) -> None:
        self.created.append(rel)
        if not self.dry:
            with open(self.t / FOLDER / "MANIFEST", "a") as f:
                f.write(rel + "\n")

    def allowed(self, rel: str) -> bool:
        probe = self.t / rel
        while not os.path.lexists(probe):  # nearest existing ancestor decides where we'd write
            probe = probe.parent
        if not inside(self.real, probe):
            self.outside.append(rel)
            return False
        return True

    def write(self, rel: str, data: bytes, mode: int = 0o644) -> bool:
        if os.path.lexists(self.t / rel):
            self.skipped.append(rel)
            return False
        if not self.allowed(rel):
            return False
        if self.dry:
            self.created.append(rel)
            return True
        parts = Path(rel).parts
        for i in range(1, len(parts)):  # create and record missing parents one level at a time
            d = Path(*parts[:i])
            if not os.path.lexists(self.t / d):
                os.mkdir(self.t / d)
                self.record(str(d))
        with open(self.t / rel, "xb") as f:  # exclusive: never replaces
            f.write(data)
        os.chmod(self.t / rel, mode)
        self.record(rel)
        return True

    def copy(self, src_rel: str, dest_rel: str | None = None) -> None:
        src = self.h / src_rel
        files = sorted(p for p in src.rglob("*") if p.is_file()) if src.is_dir() else [src]
        for p in files:
            rel = str(Path(dest_rel or src_rel) / p.relative_to(src)) if src.is_dir() else (dest_rel or src_rel)
            self.write(rel, p.read_bytes(), p.stat().st_mode & 0o777)


def generated_openspec(t: Path) -> bool:
    return any(os.path.lexists(t / p) for p in ("openspec", ".claude/commands/opsx")) or any(
        (t / d).is_dir() and any(c.name.startswith("openspec-") for c in (t / d).iterdir())
        for d in (".claude/skills", ".agents/skills"))


def install(a) -> int:
    t, h = Path(a.target), Path(a.template)
    if os.path.lexists(t / FOLDER):
        print(f"adopt: {FOLDER}/ already exists; run `adopt.py undo` or remove it first", file=sys.stderr)
        return 1
    ins = Installer(t, h, a.dry_run)
    existing = [g for g in GUIDES if os.path.lexists(t / g)]
    run_openspec = not generated_openspec(t)
    existing_codeowners = next((c for c in CODEOWNERS_LOCATIONS if os.path.lexists(t / c)), None)
    tpl_cfg_text = (h / "openspec/config.yaml").read_text()
    lifecycle = render_lifecycle(yaml.safe_load(tpl_cfg_text), json.loads(a.commands or "{}"), a.source_glob)

    if not a.dry_run:
        os.mkdir(t / FOLDER)
        (t / FOLDER / ".gitignore").write_text("*\n")  # git, the gates and `git add -A` ignore it
        (t / FOLDER / "MANIFEST").write_text("")
    for rel in INSTALL:
        ins.copy(rel)
    for skill in SKILLS:  # create-only into both skill dirs; the target's own sync script never runs
        ins.copy(f".claude/skills/{skill}")
        ins.copy(f".claude/skills/{skill}", f".agents/skills/{skill}")
    if "AGENTS.md" in existing:
        ins.copy("AGENTS.md", "docs/agent-lifecycle.md")
    if a.owner and not existing_codeowners:
        text = (h / "scripts/templates/CODEOWNERS.tmpl").read_text().replace("@OWNER", a.owner)
        ins.write(".github/CODEOWNERS", text.encode())
    if not os.path.lexists(t / "openspec/config.yaml"):
        head = tpl_cfg_text.split("\n# Read by scripts/check-change.sh", 1)[0].split("\nlifecycle:", 1)[0]
        body = head.rstrip() + "\n\n" + yaml.safe_dump({"lifecycle": lifecycle}, sort_keys=False, width=100)
        ins.write("openspec/config.yaml", body.encode())
    if run_openspec and not a.dry_run:
        watch = (".claude", ".agents", "openspec")
        snap = lambda: {str(p.relative_to(t)) for d in watch if (t / d).exists() for p in (t / d).rglob("*")}
        before = snap()
        subprocess.run(["openspec", "init", "--tools", "claude,codex", "--no-animation",
                        "--no-copilot-cloud", "."], cwd=t, check=True, stdout=subprocess.DEVNULL)
        for rel in sorted(snap() - before, key=lambda r: (r.count("/"), r)):
            ins.record(rel)

    hook_ok = {n: (t / f".claude/hooks/{n}.sh").is_file() and
               (t / f".claude/hooks/{n}.sh").read_bytes() == (h / f".claude/hooks/{n}.sh").read_bytes()
               for n in HOOKS}
    notes = proposals(t, h, a.dry_run, existing, hook_ok, tpl_cfg_text, lifecycle)
    found_risks: list[str] = []
    if ".claude/settings.json" in existing:
        try:
            found_risks = risks(json.loads((t / ".claude/settings.json").read_text()),
                                [n for n in HOOKS if not hook_ok[n]])
        except ValueError:
            pass  # unparseable settings are reported as a README note instead
    summary(a, ins, existing, existing_codeowners, run_openspec, notes, found_risks)
    return 0


def proposals(t, h, dry, existing, hook_ok, tpl_cfg_text, lifecycle) -> list[str]:
    out: dict[str, str] = {}
    notes: list[str] = []
    if ".claude/settings.json" in existing:
        data, why = propose_settings((t / ".claude/settings.json").read_text(),
                                     json.loads((h / ".claude/settings.json").read_text()), hook_ok)
        if data is None:
            notes.append(f"No settings.json proposal: .claude/settings.json is {why}. Merge by hand.")
        else:
            out["settings.json"] = json.dumps(data, indent=2) + "\n"
            notes.append("Review settings.json and copy it to .claude/settings.json to wire the hooks.")
    if "openspec/config.yaml" in existing:
        snippet, missing, why = config_snippet((t / "openspec/config.yaml").read_text(), tpl_cfg_text, lifecycle)
        if snippet is None:
            notes.append(f"No config snippet: openspec/config.yaml is {why}.")
        else:
            if snippet:
                out["openspec-config.snippet.yaml"] = snippet
                notes.append("Append openspec-config.snippet.yaml to openspec/config.yaml.")
            if missing:
                notes.append(f"Your lifecycle block lacks: {', '.join(missing)}. Values: "
                             + json.dumps({k: lifecycle[k] for k in missing}))
    agents, claude = guide_blocks()
    for guide, block, name in (("AGENTS.md", agents, "AGENTS.block.md"), ("CLAUDE.md", claude, "CLAUDE.block.md")):
        if guide in existing:
            text = (t / guide).read_text(errors="replace")
            out[name] = block
            how = "replace the existing marked block" if START in text else "append it"
            notes.append(f"Add {name} to {guide}: {how}.")
            if guide == "AGENTS.md":
                limit = int(lifecycle.get("agent_guide_max_lines") or 150)
                total = len(text.splitlines()) + len(block.splitlines())
                if total > limit:
                    notes.append(f"AGENTS.md would be {total} lines, over the {limit}-line budget: trim it first.")
    if not dry:
        for name, text in out.items():
            (t / FOLDER / name).write_text(text)
    return notes


def summary(a, ins, existing, existing_codeowners, run_openspec, notes, found_risks) -> None:
    dry = a.dry_run
    print("would copy:" if dry else "copied:")
    for rel in ins.created:
        print(f"  {rel}")
    skipped = ins.skipped + ([existing_codeowners] if existing_codeowners else [])
    if skipped:
        print("would skip (exists):" if dry else "skipped (already exists, merge by hand):")
        for rel in skipped:
            print(f"  {rel}")
    if ins.outside:
        print("skipped (outside the repo through a symlink):")
        for rel in ins.outside:
            print(f"  {clean(rel)}")
    if dry:
        print("would run: openspec init --tools claude,codex" if run_openspec
              else "OpenSpec files exist: openspec init won't run")
        print(f"would render .github/CODEOWNERS for {a.owner}" if a.owner and not existing_codeowners
              else f"would skip CODEOWNERS: {existing_codeowners} exists" if existing_codeowners
              else "CODEOWNERS depends on the owner prompt" if a.owner_pending
              else "would skip CODEOWNERS: no owner")
    if found_risks:
        print("\nRisks in your existing settings (review before merging):")
        for r in found_risks:
            print(f"  - {r}")
    readme = ["# Lifecycle adoption", "",
              "For a human reviewer. Agents: do not apply these files.", "",
              "init.sh never modified your existing files. Review each item and merge it yourself.", ""]
    readme += [f"- [ ] {n}" for n in notes] + [f"- [ ] Risk: {r}" for r in found_risks]
    if not dry:
        (Path(a.target) / FOLDER / "README.md").write_text("\n".join(readme) + "\n")

    steps = []
    if ".claude/settings.json" in existing:
        steps.append(f"The lifecycle hooks are not active until you merge {FOLDER}/settings.json "
                     "into .claude/settings.json.")
    tmpl = Path(a.template) / "scripts/templates/CODEOWNERS.tmpl"
    owned = "".join(f"       {line}\n" for line in tmpl.read_text().splitlines() if not line.startswith("#"))
    if existing_codeowners:
        steps.append(f"CODEOWNERS: {existing_codeowners} was kept. Add these lifecycle paths to it by hand:\n" + owned.rstrip())
    elif a.owner:
        steps.append(f'CODEOWNERS names {a.owner}. Keep "Require review from Code Owners" on in the main ruleset.')
    else:
        steps.append("CODEOWNERS was NOT written (no owner), so code owner review protects nothing.\n"
                     "     Rerun with --owner, or create .github/CODEOWNERS with these paths:\n" + owned.rstrip())
    if notes:
        steps.append(f"Work through {FOLDER}/README.md ({len(notes)} item(s)).")
    if not run_openspec:
        steps.append("OpenSpec files already exist, so `openspec init` didn't run; run `openspec update` yourself if needed.")
    in_flight = sorted(p.name for p in (Path(a.target) / "openspec/changes").glob("*")
                       if p.is_dir() and p.name != "archive") if (Path(a.target) / "openspec/changes").is_dir() else []
    if in_flight:
        steps.append(f"Changes in flight: {', '.join(map(clean, in_flight))}. To finish them under the lifecycle, "
                     "see docs/lifecycle.md \"Grandfathering in-flight changes\".")
    steps += ['Add your toolchain setup to .github/workflows/lifecycle.yml and release.yml ("Stack setup").',
              "Main ruleset: require a PR, code owner review, and the gates / secrets / dependency-review checks.",
              "Turn on secret scanning push protection and the dependency graph.",
              "pre-commit install --hook-type pre-commit --hook-type pre-push",
              "Run scripts/check-change.sh and commit the result as a tier 2 change."]
    if dry:
        return
    print("\nNext steps (a human does these; see docs/lifecycle.md#setup):")
    for i, s in enumerate(steps, 1):
        print(f"  {i}. {s}")
    print(f"\nUndo: python3 {Path(a.template) / 'scripts/lib/adopt.py'} undo --target {a.target}")


# ---------------------------------------------------------------- undo

def undo(a) -> int:
    t = Path(a.target)
    real = os.path.realpath(t)
    manifest = t / FOLDER / "MANIFEST"
    if not manifest.is_file():
        print(f"adopt: no {FOLDER}/MANIFEST in {t}", file=sys.stderr)
        return 1
    lines = [line for line in manifest.read_text().splitlines() if line]
    bad = [line for line in lines
           if os.path.isabs(line) or os.path.normpath(line) != line
           or {"..", ".git", FOLDER} & set(Path(line).parts) or not inside(real, t / line)]
    if bad:
        print(f"adopt: refusing to undo; invalid MANIFEST lines: {[clean(b) for b in bad[:5]]}", file=sys.stderr)
        return 1
    present = [line for line in lines if os.path.lexists(t / line)]
    for line in present:
        if not (t / line).is_dir() or (t / line).is_symlink():
            os.remove(t / line)
    for line in sorted((x for x in present if (t / x).is_dir()), key=lambda x: -x.count("/")):
        if not any((t / line).iterdir()):  # a user's later files keep their directory
            os.rmdir(t / line)
    shutil.rmtree(t / FOLDER)
    print(f"removed {len(present)} path(s) created by the install")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("install")
    i.add_argument("--target", required=True)
    i.add_argument("--template", required=True)
    i.add_argument("--owner")
    i.add_argument("--owner-pending", action="store_true")
    i.add_argument("--commands", help="JSON object of lifecycle.commands values")
    i.add_argument("--source-glob", action="append", default=[])
    i.add_argument("--dry-run", action="store_true")
    u = sub.add_parser("undo")
    u.add_argument("--target", required=True)
    a = ap.parse_args()
    return install(a) if a.cmd == "install" else undo(a)


if __name__ == "__main__":
    sys.exit(main())
