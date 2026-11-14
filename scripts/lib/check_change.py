#!/usr/bin/env python3
"""Repository gates. The same code runs in CI, in pre-commit and in the agent's Stop hook.

Stages pick which checks run:
  commit  fast, file-only checks (no stack commands)
  hook    what an agent must pass before it may stop: commit checks + stack commands
  pr      everything, including gates that only make sense at merge time

Work arrives as factory jobs (task.md is the plan, ship.md the PR body), so no gate reads the PR
body or an OpenSpec change directory. openspec/specs/ stays the living spec and is validated.
Configuration lives under `lifecycle:` in openspec/config.yaml.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("check-change: PyYAML is required (pip install pyyaml)")

ROOT = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                           text=True, check=True).stdout.strip())
FILE_GATES = ["openspec", "yaml", "workflows", "skills-sync", "guide-size"]
STAGES = {
    "commit": FILE_GATES,
    "hook": [*FILE_GATES, "commands"],
    "pr": [*FILE_GATES, "tests-with-code", "commands", "audit"],
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
    labels: set[str] = field(default_factory=set)
    in_ci: bool = False
    stage: str = "pr"
    overrides: set[str] = field(default_factory=set)


def load_config() -> dict:
    path = ROOT / "openspec/config.yaml"
    data = yaml.safe_load(path.read_text()) if path.exists() else {}
    return (data or {}).get("lifecycle") or {}


# Settings that exempt files from gates (or tests). A PR can change them, but its own gates use the
# base's.
EXEMPTION_KEYS = ("managed_paths", "test_globs", "db_test_paths")


def with_base_exemptions(cfg: dict, base: str | None) -> dict:
    if not base:
        return cfg
    r = subprocess.run(["git", "show", f"{base}:openspec/config.yaml"], cwd=ROOT,
                       capture_output=True, text=True)
    base_lc = (yaml.safe_load(r.stdout) or {}).get("lifecycle") if r.returncode == 0 else None
    if not isinstance(base_lc, dict):  # no lifecycle on the base yet (e.g. the install PR)
        return cfg
    return {**cfg, **{k: base_lc.get(k) for k in EXEMPTION_KEYS}}


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


def pr_labels() -> set[str]:
    """The PR's labels, for overrides. The PR body is never read: any body passes, a ship.md too."""
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path or not Path(path).exists():
        return set()
    pr = json.loads(Path(path).read_text()).get("pull_request") or {}
    return {label["name"] for label in pr.get("labels", [])}


# ---------------------------------------------------------------- checks
# Each check returns (status, message); status is PASS, FAIL, WARN or SKIP.

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
    # Specs only: openspec/specs/ is the living description of behavior. Changes are not a
    # lifecycle step any more, and archived ones are history.
    args = ["validate", "--specs", "--strict", "--no-interactive"]
    r = subprocess.run(["openspec", *args], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        return "FAIL", f"openspec {' '.join(args)}:\n{(r.stdout + r.stderr).strip()}"
    return "PASS", "openspec validate --specs --strict"


def db_selection(ctx: Context) -> tuple[bool, str]:
    """(run the pg/integration tests?, why). Anything unclear means run (ci-db-test-selection D3)."""
    if os.environ.get("FULL_TESTS") == "1":
        return True, "FULL_TESTS=1"
    event = os.environ.get("GITHUB_EVENT_NAME")
    if ctx.in_ci and event != "pull_request":
        return True, f"CI event {event or 'unknown'} is not a pull request"
    if not ctx.base:
        return True, "no base"
    paths = ctx.cfg.get("db_test_paths")
    paths = [p for p in paths if isinstance(p, str)] if isinstance(paths, list) else []
    if not paths:
        return True, "no db_test_paths on the base"
    hit = next((f for f in ctx.changed if matches(f, paths)), None)
    if hit:
        return True, f"{hit} matches db_test_paths"
    return False, "no db_test_paths changed"


def test_env(ctx: Context) -> tuple[dict[str, str], str]:
    """The test command's environment, and a note saying which DB tests it runs."""
    env = {k: v for k, v in os.environ.items() if k != "SKIP_DB_TESTS"}  # never inherited
    if ctx.in_ci and os.environ.get("DB_TESTS_IN_SHARDS") == "1":  # CI runs them in db-shard (D5)
        return {**env, "SKIP_DB_TESTS": "1"}, "pg/integration: db-tests job"
    if os.environ.get("FULL_TESTS") == "1":
        return env, "full: FULL_TESTS=1"
    if not ctx.in_ci:  # the full DB suite is CI's job on the PR; TDD runs the targeted test (D3a)
        return {**env, "SKIP_DB_TESTS": "1"}, \
            "pg/integration skipped: local run; CI runs them on the PR, FULL_TESTS=1 runs them here"
    run, reason = db_selection(ctx)
    if not run:
        return {**env, "SKIP_DB_TESTS": "1"}, f"pg/integration skipped: {reason}"
    return env, f"full: {reason}"


# Enough for scripts/run-steps.mjs's failed-step excerpts (up to 22 lines each, see EXCERPT_MATCHES
# and EXCERPT_TAIL there) for three failing steps, plus its summary of every step.
COMMAND_TAIL_LINES = 100


def run_commands(ctx: Context, names: list[str]):
    """Runs the configured commands concurrently; the first failure in `names` order is reported."""
    cmds = ctx.cfg.get("commands") or {}
    todo, empty, note = [], [], ""
    for name in names:
        cmd = (cmds.get(name) or "").strip()
        if not cmd:
            empty.append(name)
            continue
        env = None
        if name == "test":
            env, note = test_env(ctx)
        todo.append((name, cmd, env))

    def run_one(item):
        _, cmd, env = item
        return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, env=env)

    with ThreadPoolExecutor(max_workers=max(1, len(todo))) as pool:
        results = list(pool.map(run_one, todo))
    for (_, cmd, _), r in zip(todo, results):
        if r.returncode != 0:
            tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-COMMAND_TAIL_LINES:])
            return "FAIL", f"`{cmd}` exited {r.returncode}" + (f" ({note})" if note else "") + f":\n{tail}"
    ran = [name for name, _, _ in todo]
    if empty and not ran:
        return "WARN", f"no commands configured for {empty} in lifecycle.commands"
    return "PASS", f"ran {ran}" + (f" ({note})" if note else "") + (f"; not configured: {empty}" if empty else "")


CHECKS = {
    "tests-with-code": check_tests_with_code,
    "workflows": check_workflows,
    "yaml": check_yaml,
    "skills-sync": check_skills_sync,
    "guide-size": check_guide_size,
    "openspec": check_openspec,
    "commands": lambda ctx: run_commands(ctx, ["lint", "typecheck", "test"]),
    "audit": lambda ctx: run_commands(ctx, ["audit"]),
    "build": lambda ctx: run_commands(ctx, ["build"]),  # release workflow only
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", choices=STAGES, default="pr")
    ap.add_argument("--only", help="comma-separated checks to run")
    ap.add_argument("--base", help="base ref (default: PR base, origin/main or main)")
    ap.add_argument("--quiet", action="store_true", help="print failures only")
    ap.add_argument("--db-selection", action="store_true",
                    help="print `run: <why>` or `skip: <why>` for the pg/integration tests, run no gates")
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

    ctx = Context(cfg=load_config(), base=resolve_base(args.base), changed=[],
                  labels=pr_labels(), in_ci=bool(os.environ.get("CI")))
    ctx.stage = "custom" if args.only else args.stage
    ctx.cfg = with_base_exemptions(ctx.cfg, ctx.base)
    ctx.changed = changed_files(ctx.base)
    if args.db_selection:  # one line on stdout; CI's db-shard parses it (ci-db-test-selection D5)
        run, reason = db_selection(ctx)
        print(f"{'run' if run else 'skip'}: {reason}")
        return 0
    # Local override, e.g. LIFECYCLE_OVERRIDE="tests_with_code: generated client"; CI uses PR labels.
    if os.environ.get("LIFECYCLE_OVERRIDE") and not ctx.in_ci:
        ctx.overrides = {os.environ["LIFECYCLE_OVERRIDE"].split(":")[0].strip()}

    failed = False
    for name in names:
        status, msg = CHECKS[name](ctx)
        failed |= status == "FAIL"
        skipped_db = name == "commands" and "pg/integration skipped" in msg
        if not args.quiet or status == "FAIL" or (status == "WARN" and name == "yaml") or skipped_db:
            print(f"{status:<4}  {name:<16} {msg}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
