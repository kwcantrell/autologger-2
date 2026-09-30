#!/usr/bin/env python3
"""Lifecycle gates. The same code runs in CI, in pre-commit and in the agent's Stop hook.

Stages pick which checks run:
  commit  fast, file-only checks (no stack commands)
  hook    what an agent must pass before it may stop: commit checks + stack commands
  pr      everything, including gates that only make sense at merge time

Configuration lives under `lifecycle:` in openspec/config.yaml.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("check-change: PyYAML is required (pip install pyyaml)")

ROOT = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                           text=True, check=True).stdout.strip())
CHANGES = "openspec/changes"
ARCHIVE = "openspec/changes/archive"

STAGES = {
    "commit": ["openspec", "yaml", "workflows", "skills-sync", "guide-size", "change", "risk-floor"],
    "hook": ["openspec", "yaml", "workflows", "skills-sync", "guide-size", "change", "risk-floor",
             "evidence", "size", "commands"],
    "pr": ["openspec", "yaml", "workflows", "skills-sync", "guide-size", "change", "risk-floor",
           "approval", "panel", "tasks", "evidence", "artifacts-first", "tests-with-code",
           "size", "commands", "audit"],
}


# ---------------------------------------------------------------- helpers

def git(*args: str, check: bool = True) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          check=check).stdout


def glob_re(pattern: str) -> re.Pattern[str]:
    """Git-style glob: `**/` spans directories, `*` stays within one."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r"\Z")


def matches(path: str, patterns: list[str]) -> bool:
    return any(glob_re(p).match(path) for p in patterns)


@dataclass
class Context:
    cfg: dict
    base: str | None
    changed: list[str]
    pr_body: str = ""
    labels: set[str] = field(default_factory=set)
    in_ci: bool = False
    stage: str = "pr"
    change_dir: Path | None = None
    tier: int | None = None
    grandfathered: bool = False
    overrides: set[str] = field(default_factory=set)


def load_config() -> dict:
    path = ROOT / "openspec/config.yaml"
    data = yaml.safe_load(path.read_text()) if path.exists() else {}
    return (data or {}).get("lifecycle") or {}


# Settings that exempt files from gates. A PR can change them, but its own gates use the base's.
EXEMPTION_KEYS = ("managed_paths", "test_globs", "size_exclude", "size_budget")


def with_base_exemptions(cfg: dict, base: str | None) -> dict:
    if not base:
        return cfg
    r = subprocess.run(["git", "show", f"{base}:openspec/config.yaml"], cwd=ROOT,
                       capture_output=True, text=True)
    base_lc = (yaml.safe_load(r.stdout) or {}).get("lifecycle") if r.returncode == 0 else None
    if not isinstance(base_lc, dict):  # no lifecycle on the base yet (e.g. the install PR)
        return cfg
    return {**cfg, **{k: base_lc.get(k) for k in EXEMPTION_KEYS}}


def base_grandfathered(base: str | None) -> list[str]:
    """Change ids grandfathered on the merge-base. Never the PR's own list; malformed means none."""
    if not base:
        return []
    r = subprocess.run(["git", "show", f"{base}:openspec/config.yaml"], cwd=ROOT,
                       capture_output=True, text=True)
    lc = (yaml.safe_load(r.stdout) or {}).get("lifecycle") if r.returncode == 0 else None
    value = lc.get("grandfathered_changes") if isinstance(lc, dict) else None
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def on_base(base: str | None, path: str) -> bool:
    return bool(base) and subprocess.run(["git", "cat-file", "-e", f"{base}:{path}"], cwd=ROOT,
                                         capture_output=True).returncode == 0


def change_id(change_dir: str) -> str:
    """openspec/changes/<id> -> <id>; openspec/changes/archive/YYYY-MM-DD-<id> -> <id>."""
    name = change_dir.rstrip("/").split("/")[-1]
    return re.sub(r"^\d{4}-\d{2}-\d{2}-", "", name) if change_dir.startswith(ARCHIVE + "/") else name


def resolve_base(explicit: str | None) -> str | None:
    candidates = [explicit] if explicit else []
    if os.environ.get("GITHUB_BASE_REF"):
        candidates.append("origin/" + os.environ["GITHUB_BASE_REF"])
    candidates += ["origin/main", "main"]
    for ref in candidates:
        if ref and subprocess.run(["git", "rev-parse", "--verify", "-q", ref], cwd=ROOT,
                                  capture_output=True).returncode == 0:
            mb = git("merge-base", ref, "HEAD", check=False).strip()
            if mb:
                return mb
    return None


def changed_files(base: str | None) -> list[str]:
    # NUL-separated so a path is read whole; --no-renames so a move lists its old path too.
    files: set[str] = set()
    if base:
        files.update(git("diff", "--name-only", "--no-renames", "-z", base).split("\0"))
    else:  # no base (fresh repo): everything tracked counts as changed
        files.update(git("ls-files", "-z").split("\0"))
    files.update(git("diff", "--name-only", "--no-renames", "-z", "--cached").split("\0"))
    files.update(git("ls-files", "--others", "--exclude-standard", "-z").split("\0"))
    return sorted(f for f in files if f)


ARCHIVE_NAME = re.compile(r"\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*")


def exempt_archives(base: str | None) -> set[str]:
    """Archived change dirs on the merge-base whose only difference is an in-place tasks.md edit.

    Those edits maintain history; they are not the branch's change. Read from raw records so a
    move, a type change or a whitespace-laden name can't pass for a tasks.md edit.
    """
    if not base:
        return set()
    records: dict[str, list[tuple[str, str, str, str]]] = {}
    fields = git("diff", "--raw", "--no-renames", "-z", base).split("\0")
    for meta, path in zip(fields[0::2], fields[1::2]):
        old_mode, new_mode, _, _, status = meta.lstrip(":").split(" ")
        parts = path.split("/")
        if path.startswith(ARCHIVE + "/") and len(parts) > 4:
            records.setdefault("/".join(parts[:4]), []).append((status, path, old_mode, new_mode))
    untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0")
    exempt = set()
    for d, recs in records.items():
        if (ARCHIVE_NAME.fullmatch(d.split("/")[-1]) and on_base(base, d)
                and recs == [("M", f"{d}/tasks.md", "100644", "100644")]
                and not any(f.startswith(d + "/") for f in untracked)):
            exempt.add(d)
    return exempt


def pr_event() -> tuple[str, set[str]]:
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path or not Path(path).exists():
        return "", set()
    pr = json.loads(Path(path).read_text()).get("pull_request") or {}
    return pr.get("body") or "", {label["name"] for label in pr.get("labels", [])}


def item_blocks(text: str) -> list[tuple[str, str]]:
    """Split a markdown checklist into (mark, block) pairs; block includes indented lines."""
    blocks, current = [], None
    for line in text.splitlines():
        m = re.match(r"^\s*[-*]\s*\[([ xX])\]\s", line)
        if m:
            current = [m.group(1).lower(), line]
            blocks.append(current)
        elif current and (line.startswith((" ", "\t")) and line.strip()):
            current[1] += "\n" + line
        else:
            current = None
    return [(mark, block) for mark, block in blocks]


# ---------------------------------------------------------------- checks
# Each check returns (status, message); status is PASS, FAIL, WARN or SKIP.

def check_change(ctx: Context):
    exempt = exempt_archives(ctx.base)
    status, msg = _check_change(ctx, exempt)
    if exempt:  # on every result, so a reviewer always sees history edits
        msg += f"; not counted: tasks.md-only edits to existing archive(s) {sorted(exempt)}"
    return status, msg


def _check_change(ctx: Context, exempt: set[str]):
    dirs = set()
    for f in ctx.changed:
        parts = f.split("/")
        if f.startswith(ARCHIVE + "/") and len(parts) > 4:
            dirs.add("/".join(parts[:4]))
        elif f.startswith(CHANGES + "/") and len(parts) > 3 and parts[2] != "archive":
            dirs.add("/".join(parts[:3]))
    dirs = {d for d in dirs if (ROOT / d).is_dir()} - exempt
    if len(dirs) > 1:
        return "FAIL", f"one change per branch; found {sorted(dirs)}"
    if dirs:
        rel = dirs.pop()
        ctx.change_dir = ROOT / rel
        cid = change_id(rel)
        # Grandfathering comes before the Tier line: changes that predate the lifecycle have none.
        if cid in base_grandfathered(ctx.base) and on_base(ctx.base, f"{CHANGES}/{cid}"):
            ctx.grandfathered = True
            if os.environ.get("GITHUB_EVENT_PATH") and not re.search(
                    rf"^\s*Grandfathered:\s*{re.escape(cid)}\s*$", ctx.pr_body, re.M):
                return "FAIL", f"grandfathered change; declare `Grandfathered: {cid}` in the PR body"
            return "WARN", f"grandfathered: {cid} predates the lifecycle ({rel})"
        proposal = ctx.change_dir / "proposal.md"
        m = re.search(r"^Tier:\s*([012])\b", proposal.read_text(), re.M) if proposal.exists() else None
        if not m:
            hint = ""
            if cid in ((ctx.cfg.get("grandfathered_changes") or []) if isinstance(ctx.cfg.get("grandfathered_changes"), list) else []):
                hint = (" (listed, but not grandfathered: the merge-base lacks it in its config"
                        " or lacks the change dir; merge main)")
            return "FAIL", f"{proposal.relative_to(ROOT)} must declare `Tier: 0|1|2`{hint}"
        ctx.tier = int(m.group(1))
    body_tier = re.search(r"^\s*Tier:\s*([012])\b", ctx.pr_body, re.M)
    if body_tier:
        if ctx.tier is not None and int(body_tier.group(1)) != ctx.tier:
            return "FAIL", f"PR says tier {body_tier.group(1)}, proposal says tier {ctx.tier}"
        ctx.tier = int(body_tier.group(1))
    if ctx.tier is None:
        ctx.tier = 0
    if ctx.tier == 0 and ctx.change_dir is not None:
        return "FAIL", "tier 0 needs no OpenSpec change; use tier 1 or drop the change dir"
    if ctx.tier >= 1 and ctx.change_dir is None:
        return "FAIL", f"tier {ctx.tier} needs an OpenSpec change under {CHANGES}/"
    where = ctx.change_dir.relative_to(ROOT) if ctx.change_dir else "no change dir"
    return "PASS", f"tier {ctx.tier} ({where})"


def check_risk_floor(ctx: Context):
    risky = [f for f in ctx.changed if matches(f, ctx.cfg.get("high_risk_paths", []))]
    if ctx.grandfathered:
        return ("WARN", f"grandfathered; high-risk paths touched: {risky[:10]}") if risky \
            else ("PASS", "grandfathered; no high-risk paths touched")
    if risky and (ctx.tier or 0) < 2:
        return "FAIL", f"touches high-risk paths, so tier must be 2: {risky[:5]}"
    return "PASS", f"{len(risky)} high-risk path(s) touched"


def check_approval(ctx: Context):
    if (ctx.tier or 0) == 0:
        return "SKIP", "tier 0"
    text = (ctx.change_dir / "proposal.md").read_text()
    if not re.search(r"^Approved-by:\s*\S+", text, re.M):
        return "FAIL", "proposal.md has no `Approved-by:` line from the human"
    return "PASS", "approval recorded"


PANEL_ITEM = re.compile(r"^[-*] \[([ xX])\] ?(.*)$")
PANEL_TAG = re.compile(r"^\[(critical|major|minor)\](?=\s|$)")


def panel_findings(text: str) -> tuple[list[tuple[str, str | None, str]], bool]:
    """Findings are column-0 checklist items outside code fences and HTML comments.

    Returns ([(mark, tag or None, line)], has_no_findings_line).
    """
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    findings, no_findings, in_fence = [], False, False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = PANEL_ITEM.match(line)
        if m:
            tag = PANEL_TAG.match(m.group(2))
            findings.append((m.group(1).lower(), tag.group(1) if tag else None, line.strip()))
        elif line.strip() == "No findings.":
            no_findings = True
    return findings, no_findings


def check_panel(ctx: Context):
    if ctx.change_dir is None:
        return "SKIP", "no change"
    panel = ctx.change_dir / "panel.md"
    if not panel.exists():
        return ("FAIL", "tier 2 needs panel.md") if ctx.tier == 2 else ("SKIP", "no panel.md")
    findings, no_findings = panel_findings(panel.read_text())
    if not findings:
        return ("PASS", "No findings.") if no_findings else \
            ("FAIL", "no findings in checklist format (`- [ ] [critical|major|minor] ...`, or `No findings.`)")
    untagged = [line for _, tag, line in findings if tag is None]
    if untagged:
        return "FAIL", f"untagged finding(s), need [critical|major|minor] first: {untagged[:3]}"
    open_critical = [line for mark, tag, line in findings if mark == " " and tag == "critical"]
    if open_critical:
        return "FAIL", f"{len(open_critical)} open critical finding(s) in panel.md"
    unresolved = [line for mark, tag, line in findings
                  if mark == "x" and tag in ("critical", "major")
                  and not re.search(r"Resolved:|Declined", line)]
    if unresolved:
        return "FAIL", f"ticked critical/major finding(s) without Resolved: or Declined: {unresolved[:3]}"
    return "PASS", f"{len(findings)} finding(s), no open criticals"


def check_tasks(ctx: Context):
    if ctx.change_dir is None:
        return "SKIP", "no change"
    tasks = ctx.change_dir / "tasks.md"
    if not tasks.exists():
        return "FAIL", "change has no tasks.md"
    open_items = [b for mark, b in item_blocks(tasks.read_text()) if mark == " "]
    if open_items:
        return "FAIL", f"{len(open_items)} unticked task(s) in tasks.md"
    return "PASS", "all tasks ticked"


def check_evidence(ctx: Context):
    if ctx.change_dir is None or not (ctx.change_dir / "tasks.md").exists():
        return "SKIP", "no tasks.md"
    missing = [b.splitlines()[0].strip() for mark, b in item_blocks((ctx.change_dir / "tasks.md").read_text())
               if mark == "x" and not re.search(r"evidence:", b, re.I)]
    if missing:
        return "FAIL", f"ticked without `Evidence:`: {missing[:3]}"
    return "PASS", "every ticked task cites evidence"


def check_artifacts_first(ctx: Context):
    if (ctx.tier or 0) == 0 or not ctx.base:
        return "SKIP", "tier 0 or no base"
    commits = git("rev-list", "--topo-order", "--reverse", "--no-merges", f"{ctx.base}..HEAD").split()
    if not commits:
        return "SKIP", "no commits on branch"
    first = [f for f in git("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commits[0]).split("\0") if f]
    stray = [f for f in first if not f.startswith(CHANGES + "/")]
    if stray:
        return "FAIL", f"first commit must hold only the approved artifacts; also has {stray[:3]}"
    return "PASS", "plan pinned before code"


def overridden(ctx: Context, key: str) -> bool:
    label = (ctx.cfg.get("override_labels") or {}).get(key)
    return key in ctx.overrides or (label is not None and label in ctx.labels)


def check_tests_with_code(ctx: Context):
    src_globs, test_globs = ctx.cfg.get("source_globs") or [], ctx.cfg.get("test_globs") or []
    if not src_globs:
        return "WARN", "lifecycle.source_globs is empty; gate not active"
    managed = ctx.cfg.get("managed_paths") or []
    tests = [f for f in ctx.changed if matches(f, test_globs)]
    source = [f for f in ctx.changed if matches(f, src_globs) and f not in tests and not matches(f, managed)]
    if source and not tests:
        if overridden(ctx, "tests_with_code"):
            return "WARN", "source changed without tests (overridden)"
        return "FAIL", f"source changed but no test changed: {source[:3]}"
    return "PASS", f"{len(source)} source / {len(tests)} test file(s)"


def untracked_lines(path: Path, cap: int) -> int:
    """Lines as git numstat counts them for a new file; 0 for binary or non-regular; stops past cap."""
    if path.is_symlink():
        return 1  # git counts a symlink's target path as one line
    try:
        if not stat.S_ISREG(path.stat().st_mode):
            return 0
        with open(path, "rb") as f:
            head = f.read(8000)
            if b"\0" in head:
                return 0  # binary, as git decides it
            count, last, chunk = 0, b"", head
            while chunk:
                count += chunk.count(b"\n")
                last = chunk
                if count > cap:
                    return count
                chunk = f.read(1 << 20)
            return count + (1 if last and not last.endswith(b"\n") else 0)
    except OSError:
        return 0


def committed_lines(base: str, exclude: list[str]) -> int:
    """Changed lines against base, every count git's own. A move between two counted paths costs
    its edits; any other move keeps its delete + add counts, so it's priced by where it lands."""
    def cost(added: str, deleted: str) -> int:
        return 0 if added == "-" else int(added) + int(deleted)  # binary counts 0

    plain: dict[str, int] = {}
    for rec in git("diff", "--numstat", "-z", "--no-renames", base).split("\0"):
        if rec:
            added, deleted, path = rec.split("\t", 2)
            plain[path] = cost(added, deleted)
    total = sum(n for path, n in plain.items() if not matches(path, exclude))
    fields = git("diff", "--numstat", "-z", "-M", base).split("\0")  # -M: whatever diff.renames says
    i = 0
    while i < len(fields) and fields[i]:
        added, deleted, path = fields[i].split("\t", 2)
        if path:  # plain record
            i += 1
            continue
        old, new = fields[i + 1], fields[i + 2]  # rename record: empty path, then old and new
        i += 3
        if not matches(old, exclude) and not matches(new, exclude):
            total += cost(added, deleted) - plain.get(old, 0) - plain.get(new, 0)
    return total


def check_size(ctx: Context):
    if not ctx.base:
        return "SKIP", "no base to diff against"
    budget = int(ctx.cfg.get("size_budget") or 0)
    if not budget:
        return "SKIP", "no size_budget"
    exclude = ((ctx.cfg.get("size_exclude") or []) + (ctx.cfg.get("test_globs") or [])
               + (ctx.cfg.get("managed_paths") or []) + ["openspec/**"])
    total = committed_lines(ctx.base, exclude)
    if not ctx.in_ci:  # CI counts committed diffs only; locally, new files count before commit
        for path in git("ls-files", "-z", "--others", "--exclude-standard").split("\0"):
            if path and not matches(path, exclude):
                total += untracked_lines(ROOT / path, budget - total)
    if total > budget:
        if overridden(ctx, "size_budget"):
            return "WARN", f"{total} changed lines > {budget} (overridden)"
        if ctx.stage == "hook":
            return "WARN", (f"{total} changed lines > budget {budget}; the PR gate will fail: split, "
                            "or ask the human for `size-override`")
        return "FAIL", f"{total} changed lines > budget {budget}; split the change"
    return "PASS", f"{total}/{budget} changed lines"


class TolerantLoader(yaml.SafeLoader):
    """SafeLoader that reads unknown `!tags` (CloudFormation, Ansible) as plain values.

    `!!python/...` tags resolve to tag:yaml.org,2002:python/*, not `!`, so they stay rejected.
    """


def _any_tag(loader: yaml.SafeLoader, suffix: str, node: yaml.Node):
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_scalar(node)


TolerantLoader.add_multi_constructor("!", _any_tag)
YAML_MAX_BYTES = 1 << 20


def yaml_problem(path: Path, rel: str) -> str | None:
    """None if the file parses (and, for the pre-commit config, has a loadable shape)."""
    try:
        docs = list(yaml.load_all(path.read_text(encoding="utf-8"), Loader=TolerantLoader))
    except yaml.MarkedYAMLError as e:
        mark = e.problem_mark or e.context_mark
        line = f":{mark.line + 1}" if mark else ""
        return f"{rel}{line}: {e.problem or e.context}"
    except Exception as e:  # constructor errors, RecursionError, UnicodeDecodeError, ...
        return f"{rel}: {type(e).__name__}: {str(e)[:120]}"
    if rel == ".pre-commit-config.yaml":
        cfg = docs[0] if docs else None
        repos = cfg.get("repos") if isinstance(cfg, dict) else None
        if not isinstance(repos, list):
            return f"{rel}: pre-commit needs a top-level `repos` list"
        for i, repo in enumerate(repos):
            if not (isinstance(repo, dict) and "repo" in repo and isinstance(repo.get("hooks"), list)):
                return f"{rel}: repos[{i}] needs `repo` and a `hooks` list"
            if not all(isinstance(h, dict) and "id" in h for h in repo["hooks"]):
                return f"{rel}: every hook in repos[{i}] needs an `id`"
    return None


def check_yaml(ctx: Context):
    spec = ["--", "*.yml", "*.yaml"]
    paths = git("ls-files", "-z", *spec).split("\0")
    if not ctx.in_ci:  # locally, new files are checked before they're committed
        paths += git("ls-files", "-z", "--others", "--exclude-standard", *spec).split("\0")
    problems, skipped, too_big, checked = [], 0, [], 0
    for rel in sorted(set(filter(None, paths))):
        path = ROOT / rel
        if path.is_symlink() or not path.is_file():
            skipped += 1
            continue
        if path.stat().st_size > YAML_MAX_BYTES:
            too_big.append(rel)
            continue
        checked += 1
        problem = yaml_problem(path, rel)
        if problem:
            problems.append((rel, problem))
    strict = ctx.stage not in ("commit", "hook")  # pr, CI and --only: any broken file fails
    touched = [p for rel, p in problems if strict or rel in ctx.changed]
    untouched = [p for rel, p in problems if not (strict or rel in ctx.changed)]
    if touched:
        return "FAIL", "; ".join(touched[:5]) + (f" (+{len(touched) - 5} more)" if len(touched) > 5 else "")
    notes = []
    if untouched:
        notes.append("pre-existing broken YAML, fix in its own change: " + "; ".join(untouched[:5]))
    if too_big:
        notes.append(f"too large to check (> 1 MiB): {too_big[:5]}")
    if notes:
        return "WARN", " | ".join(notes)
    return "PASS", f"{checked} YAML file(s) parse" + (f"; {skipped} symlink/non-file skipped" if skipped else "")


def check_workflows(ctx: Context):
    wf_dir = ROOT / ".github/workflows"
    problems = []
    for wf in sorted(list(wf_dir.glob("*.yml")) + list(wf_dir.glob("*.yaml"))):
        text = wf.read_text()
        for ref in re.findall(r"^\s*-?\s*uses:\s*['\"]?([^\s'\"#]+)", text, re.M):
            if ref.startswith("./") or re.search(r"@[0-9a-f]{40}$", ref) \
                    or re.match(r"docker://.+@sha256:[0-9a-f]{64}$", ref):
                continue
            problems.append(f"{wf.name}: `{ref}` not pinned to a full SHA")
        if "permissions" not in (yaml.safe_load(text) or {}):
            problems.append(f"{wf.name}: no top-level `permissions:`")
    return ("FAIL", "; ".join(problems)) if problems else ("PASS", "actions pinned, token scoped")


def tree(path: Path) -> dict[str, bytes]:
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob("*") if p.is_file()}


def check_skills_sync(ctx: Context):
    src, dst = ROOT / ".claude/skills", ROOT / ".agents/skills"
    if not src.exists():
        return "SKIP", "no .claude/skills"
    ours = {p.name for p in src.iterdir() if p.is_dir() and not p.name.startswith("openspec-")}
    theirs = {p.name for p in dst.iterdir() if p.is_dir() and not p.name.startswith("openspec-")} \
        if dst.exists() else set()
    drift = sorted(n for n in ours | theirs
                   if n not in ours or n not in theirs or tree(src / n) != tree(dst / n))
    if drift:
        return "FAIL", f".agents/skills out of sync for {drift}; run scripts/sync-skills.sh"
    return "PASS", f"{len(ours)} skill(s) in sync"


def check_guide_size(ctx: Context):
    guide = ROOT / "AGENTS.md"
    if not guide.exists():
        return "FAIL", "AGENTS.md missing"
    limit = int(ctx.cfg.get("agent_guide_max_lines") or 150)
    n = len(guide.read_text().splitlines())
    return ("FAIL" if n > limit else "PASS"), f"AGENTS.md {n}/{limit} lines"


def check_openspec(ctx: Context):
    if not shutil.which("openspec"):
        return ("FAIL" if ctx.in_ci else "WARN"), "openspec CLI not installed"
    for args in (["validate", "--all", "--strict", "--no-interactive"],
                 ["validate", "--archived", "--no-interactive"]):
        r = subprocess.run(["openspec", *args], cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            return "FAIL", f"openspec {' '.join(args)}:\n{(r.stdout + r.stderr).strip()}"
    return "PASS", "openspec validate --strict"


def run_commands(ctx: Context, names: list[str]):
    cmds = ctx.cfg.get("commands") or {}
    ran, empty = [], []
    for name in names:
        cmd = (cmds.get(name) or "").strip()
        if not cmd:
            empty.append(name)
            continue
        r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-30:])
            return "FAIL", f"`{cmd}` exited {r.returncode}:\n{tail}"
        ran.append(name)
    if empty and not ran:
        return "WARN", f"no commands configured for {empty} in lifecycle.commands"
    return "PASS", f"ran {ran}" + (f"; not configured: {empty}" if empty else "")


CHECKS = {
    "change": check_change,
    "risk-floor": check_risk_floor,
    "approval": check_approval,
    "panel": check_panel,
    "tasks": check_tasks,
    "evidence": check_evidence,
    "artifacts-first": check_artifacts_first,
    "tests-with-code": check_tests_with_code,
    "size": check_size,
    "workflows": check_workflows,
    "yaml": check_yaml,
    "skills-sync": check_skills_sync,
    "guide-size": check_guide_size,
    "openspec": check_openspec,
    "commands": lambda ctx: run_commands(ctx, ["lint", "typecheck", "test"]),
    "audit": lambda ctx: run_commands(ctx, ["audit"]),
    "build": lambda ctx: run_commands(ctx, ["build"]),  # release workflow only
}


# Checks that read the tier or change directory `change` resolves.
NEEDS_CHANGE = {"risk-floor", "approval", "panel", "tasks", "evidence", "artifacts-first"}
# Skipped for a grandfathered change; risk-floor still runs and warns.
GRANDFATHER_SKIPS = {"approval", "panel", "tasks", "evidence", "artifacts-first", "size"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", choices=STAGES, default="pr")
    ap.add_argument("--only", help="comma-separated checks to run")
    ap.add_argument("--base", help="base ref (default: PR base, origin/main or main)")
    ap.add_argument("--quiet", action="store_true", help="print failures only")
    args = ap.parse_args()

    if args.only is not None:
        names = list(dict.fromkeys(n.strip() for n in args.only.split(",")))
        unknown = [n for n in names if n not in CHECKS]
        if unknown or not names:
            print(f"check-change: unknown check {unknown or ['']}; valid checks: {', '.join(CHECKS)}",
                  file=sys.stderr)
            return 2
    else:
        names = STAGES[args.stage]

    body, labels = pr_event()
    ctx = Context(cfg=load_config(), base=resolve_base(args.base), changed=[], pr_body=body,
                  labels=labels, in_ci=bool(os.environ.get("CI")))
    ctx.stage = "custom" if args.only else args.stage
    ctx.cfg = with_base_exemptions(ctx.cfg, ctx.base)
    ctx.changed = changed_files(ctx.base)
    # Local override, e.g. LIFECYCLE_OVERRIDE="size_budget: generated client"; CI uses PR labels.
    if os.environ.get("LIFECYCLE_OVERRIDE") and not ctx.in_ci:
        ctx.overrides = {os.environ["LIFECYCLE_OVERRIDE"].split(":")[0].strip()}

    # Resolve the change once, up front, so no check's result depends on --only order.
    change_result = check_change(ctx)
    change_failed = change_result[0] == "FAIL"
    if change_failed and "change" not in names and NEEDS_CHANGE.intersection(names):
        names = ["change", *names]  # a failure that blocks requested checks is never hidden
    failed = False
    for name in names:
        if name == "change":
            status, msg = change_result
        elif ctx.grandfathered and name in GRANDFATHER_SKIPS:
            status, msg = "SKIP", "grandfathered"
        elif change_failed and name in NEEDS_CHANGE:
            status, msg = "SKIP", "blocked: change failed"
        else:
            status, msg = CHECKS[name](ctx)
        failed |= status == "FAIL"
        if not args.quiet or status == "FAIL" or (status == "WARN" and name in ("size", "yaml")):
            print(f"{status:<4}  {name:<16} {msg}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
