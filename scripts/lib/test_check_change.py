"""Tests for scripts/lib/check_change.py (the gates behind scripts/check-change.sh).

Run: python3 -m unittest discover -s scripts/lib -p 'test_*.py'   (part of the root `npm test`)

Each case builds a throwaway git repo (a `main` base commit plus a feature branch), copies the gate
script into it and runs it the way CI and the hooks do, with a clean environment. The `openspec`
CLI is a stub on PATH that logs its arguments, except in the one case that runs the real CLI.

CHECK_CHANGE_UNDER_TEST=<path> runs the cases against another copy of the script (used to show
that each case fails when the behavior it pins is reverted).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SCRIPT = Path(os.environ.get("CHECK_CHANGE_UNDER_TEST") or HERE / "check_change.py")
REAL_OPENSPEC = shutil.which("openspec")

FILE_GATES = ["openspec", "yaml", "workflows", "skills-sync", "guide-size"]
RETIRED = ["change", "risk-floor", "approval", "panel", "tasks", "evidence", "artifacts-first"]

# The base config mirrors main's: it still carries the OpenSpec-era keys, as main will until this
# lands. Stack commands are stubbed with `true` so stage runs stay fast.
BASE_CONFIG = {
    "schema": "spec-driven",
    "lifecycle": {
        "commands": {"test": "true", "lint": "", "typecheck": "true", "audit": "true"},
        "source_globs": ["src/**", "server/src/**"],
        "test_globs": ["**/test/**", "**/*.test.*", "**/test_*"],
        "managed_paths": ["scripts/lib/check_change.py"],
        "grandfathered_changes": [],
        "db_test_paths": ["server/**", "package.json"],
        "high_risk_paths": [".github/**", "scripts/**", "openspec/config.yaml"],
        "agent_guide_max_lines": 150,
        "override_labels": {"tests_with_code": "no-test-needed"},
    },
}

# Shaped like a real factory ship.md: no Tier, Change or Grandfathered line.
SHIP_MD = textwrap.dedent("""\
    # Ship: 012 Rework something

    **Recommendation:** merge. The verifier proved all criteria first-hand.

    ## What changed

    Branch `factory/012-rework-something`, base `b04d446c`.

    ## How each criterion was proven (verifier, `proof.md`)

    1. **Gates.** `scripts/check-change.sh --stage pr` exits 0.

    ## Remaining risks / look at by hand

    - None.
    """)

VALID_SPEC = textwrap.dedent("""\
    # widgets Specification

    ## Purpose
    Widgets are listed in creation order so the operator can find the newest one.

    ## Requirements
    ### Requirement: Widget listing
    The system SHALL list widgets in creation order.

    #### Scenario: Two widgets
    - **WHEN** two widgets are created
    - **THEN** the list shows them in the order they were created
    """)


def clean_env(**extra: str) -> dict[str, str]:
    """No CI, GitHub, lifecycle or git-hook variables leak in from whoever runs the tests."""
    drop = ("CI", "FULL_TESTS", "LIFECYCLE_OVERRIDE", "SKIP_DB_TESTS", "DB_TESTS_IN_SHARDS")
    env = {k: v for k, v in os.environ.items()
           if k not in drop and not k.startswith(("GITHUB_", "GIT_"))}
    env.update(extra)
    return env


class Repo:
    """A temp git repo: `main` holds the base files, `feature` adds the branch's files."""

    def __init__(self, tmp: Path, branch_files: dict[str, str], base_files: dict[str, str] | None = None,
                 config: dict | None = None):
        self.root = tmp / "repo"
        self.root.mkdir()
        self.git("init", "-q", "-b", "main")
        files = {
            "AGENTS.md": "# Agents\n",
            "README.md": "readme\n",
            "openspec/config.yaml": yaml.safe_dump(config or BASE_CONFIG),
            "openspec/specs/widgets/spec.md": VALID_SPEC,
            **(base_files or {}),
        }
        self.write(files)
        self.commit("base")
        self.git("checkout", "-q", "-b", "feature")
        self.write(branch_files)
        self.commit("feature")
        lib = self.root / "scripts/lib"
        lib.mkdir(parents=True, exist_ok=True)
        shutil.copy(SCRIPT, lib / "check_change.py")  # untracked, like a local edit; in managed_paths
        self.stub_dir = tmp / "bin"
        self.stub_dir.mkdir()
        self.openspec_log = tmp / "openspec.log"
        stub = self.stub_dir / "openspec"
        stub.write_text('#!/bin/sh\necho "$*" >> "$OPENSPEC_LOG"\nexit "${OPENSPEC_EXIT:-0}"\n')
        stub.chmod(0o755)

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
             "-c", "core.hooksPath=/dev/null", *args],
            cwd=self.root, env=clean_env(), capture_output=True, text=True, check=True).stdout

    def write(self, files: dict[str, str]) -> None:
        for rel, text in files.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def commit(self, msg: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", msg)

    def run(self, *args: str, real_openspec: bool = False, **env: str) -> subprocess.CompletedProcess:
        path = os.environ.get("PATH", "")
        if not real_openspec:
            path = f"{self.stub_dir}{os.pathsep}{path}"
        full_env = clean_env(PATH=path, OPENSPEC_LOG=str(self.openspec_log), **env)
        return subprocess.run([sys.executable, "scripts/lib/check_change.py", *args], cwd=self.root,
                              env=full_env, capture_output=True, text=True)

    def pr_event(self, body: str, labels: list[str] = ()) -> str:
        path = self.root.parent / "event.json"
        path.write_text(json.dumps({"pull_request": {"body": body,
                                                     "labels": [{"name": n} for n in labels]}}))
        return str(path)


def gate_lines(out: str) -> dict[str, str]:
    """`STATUS  name  message` lines -> {name: STATUS}."""
    gates = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in ("PASS", "FAIL", "WARN", "SKIP"):
            gates[parts[1]] = parts[0]
    return gates


class RepoCase(unittest.TestCase):
    def make(self, branch_files: dict[str, str], **kw) -> Repo:
        tmp = Path(tempfile.mkdtemp(prefix="check-change-test-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        return Repo(tmp, branch_files, **kw)

    def assertExit(self, r: subprocess.CompletedProcess, code: int) -> None:
        self.assertEqual(r.returncode, code, f"exit {r.returncode}\n{r.stdout}\n{r.stderr}")


class StageGateLists(RepoCase):
    """Each stage runs exactly the gates the factory lifecycle keeps, in order."""

    EXPECTED = {
        "commit": FILE_GATES,
        "hook": [*FILE_GATES, "commands"],
        "pr": [*FILE_GATES, "tests-with-code", "commands", "audit"],
    }

    def test_each_stage_runs_its_gate_list(self):
        repo = self.make({"docs/notes.md": "notes\n"})
        for stage, expected in self.EXPECTED.items():
            with self.subTest(stage=stage):
                r = repo.run("--stage", stage)
                self.assertExit(r, 0)
                self.assertEqual(list(gate_lines(r.stdout)), expected, r.stdout)

    def test_retired_gates_are_gone(self):
        repo = self.make({"docs/notes.md": "notes\n"})
        for name in RETIRED:
            with self.subTest(gate=name):
                r = repo.run("--only", name)
                self.assertExit(r, 2)
                self.assertIn("unknown check", r.stderr)


class TestsWithCode(RepoCase):
    def test_source_with_a_test_passes(self):
        repo = self.make({"src/widget.ts": "export {}\n", "src/widget.test.ts": "test\n"})
        r = repo.run("--only", "tests-with-code")
        self.assertExit(r, 0)
        self.assertIn("PASS  tests-with-code  1 source / 1 test file(s)", r.stdout)

    def test_source_without_a_test_fails(self):
        repo = self.make({"src/widget.ts": "export {}\n"})
        r = repo.run("--only", "tests-with-code")
        self.assertExit(r, 1)
        self.assertIn("FAIL  tests-with-code  source changed but no test changed: ['src/widget.ts']",
                      r.stdout)

    def test_no_test_needed_label_overrides_in_ci(self):
        repo = self.make({"src/widget.ts": "export {}\n"})
        r = repo.run("--only", "tests-with-code", CI="true",
                     GITHUB_EVENT_PATH=repo.pr_event(SHIP_MD, ["no-test-needed"]))
        self.assertExit(r, 0)
        self.assertIn("WARN  tests-with-code  source changed without tests (overridden)", r.stdout)

    def test_other_labels_do_not_override(self):
        repo = self.make({"src/widget.ts": "export {}\n"})
        r = repo.run("--only", "tests-with-code", CI="true",
                     GITHUB_EVENT_PATH=repo.pr_event(SHIP_MD, ["documentation"]))
        self.assertExit(r, 1)

    def test_local_override_env(self):
        repo = self.make({"src/widget.ts": "export {}\n"})
        r = repo.run("--only", "tests-with-code", LIFECYCLE_OVERRIDE="tests_with_code: generated")
        self.assertExit(r, 0)
        self.assertIn("(overridden)", r.stdout)


class OpenspecGate(RepoCase):
    def test_validates_specs_only(self):
        repo = self.make({"docs/notes.md": "notes\n"})
        r = repo.run("--only", "openspec")
        self.assertExit(r, 0)
        self.assertEqual(repo.openspec_log.read_text().splitlines(),
                         ["validate --specs --strict --no-interactive"])

    def test_spec_validation_failure_fails_the_gate(self):
        repo = self.make({"docs/notes.md": "notes\n"})
        r = repo.run("--only", "openspec", OPENSPEC_EXIT="1")
        self.assertExit(r, 1)
        self.assertIn("FAIL  openspec", r.stdout)

    @unittest.skipUnless(REAL_OPENSPEC, "openspec CLI not installed")
    def test_real_cli_ignores_changes_and_catches_broken_specs(self):
        # A change dir that fails `openspec validate --changes` (no proposal, no deltas) and an
        # archive with unticked tasks: neither is the gate's business any more.
        broken_change = {
            "openspec/changes/half-done/tasks.md": "- [ ] 1.1 something\n",
            "openspec/changes/archive/2026-01-01-old/tasks.md": "- [ ] 1.1 never ticked\n",
            "openspec/changes/archive/2026-01-01-old/proposal.md": "# old\n",
        }
        repo = self.make(broken_change)
        r = repo.run("--only", "openspec", real_openspec=True)
        self.assertExit(r, 0)
        self.assertIn("PASS  openspec", r.stdout)

        repo.write({"openspec/specs/widgets/spec.md": "# widgets\n\nNo requirements here.\n"})
        r = repo.run("--only", "openspec", real_openspec=True)
        self.assertExit(r, 1)
        self.assertIn("FAIL  openspec", r.stdout)


class CommandsGate(RepoCase):
    """The `commands` gate runs its configured commands concurrently."""

    def make_cmds(self, **cmds: str) -> Repo:
        cfg = json.loads(json.dumps(BASE_CONFIG))
        cfg["lifecycle"]["commands"] = cmds
        return self.make({"docs/notes.md": "notes\n"}, config=cfg)

    def test_typecheck_and_test_overlap(self):
        # Each command waits for the other's marker file: only concurrent runs can both finish.
        rendezvous = lambda mine, other: (
            f"touch {mine}; for i in $(seq 100); do [ -e {other} ] && exit 0; sleep 0.1; done; exit 1")
        tmp = tempfile.mkdtemp(prefix="rendezvous-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        repo = self.make_cmds(typecheck=rendezvous(f"{tmp}/a", f"{tmp}/b"),
                              test=rendezvous(f"{tmp}/b", f"{tmp}/a"))
        r = repo.run("--only", "commands")
        self.assertExit(r, 0)
        self.assertEqual(gate_lines(r.stdout), {"commands": "PASS"})
        self.assertIn("ran ['typecheck', 'test']", r.stdout)

    def test_failing_command_is_named_with_its_output_tail(self):
        repo = self.make_cmds(typecheck="true", test="echo the-test-output; echo bad >&2; exit 7")
        r = repo.run("--only", "commands")
        self.assertExit(r, 1)
        self.assertEqual(gate_lines(r.stdout), {"commands": "FAIL"})
        self.assertIn("`echo the-test-output; echo bad >&2; exit 7` exited 7", r.stdout)
        self.assertIn("the-test-output", r.stdout)
        self.assertIn("bad", r.stdout)

    def test_a_failure_in_typecheck_fails_the_gate_while_test_passes(self):
        repo = self.make_cmds(typecheck="echo tsc-error; exit 2", test="true")
        r = repo.run("--only", "commands")
        self.assertExit(r, 1)
        self.assertIn("exited 2", r.stdout)
        self.assertIn("tsc-error", r.stdout)

    def test_skip_db_tests_and_full_tests_handling_is_unchanged(self):
        repo = self.make_cmds(typecheck="true",
                              test='echo "t=[$SKIP_DB_TESTS]"; exit 1')
        r = repo.run("--only", "commands", GITHUB_EVENT_NAME="pull_request", SKIP_DB_TESTS="0")
        self.assertIn("t=[1]", r.stdout)  # local run: skipped, an inherited value is dropped
        self.assertIn("pg/integration skipped: local run", r.stdout)
        full = repo.run("--only", "commands", FULL_TESTS="1")
        self.assertIn("t=[]", full.stdout)
        self.assertIn("full: FULL_TESTS=1", full.stdout)


class DbSelection(RepoCase):
    def test_skip_when_no_db_path_changed(self):
        repo = self.make({"docs/notes.md": "notes\n"})
        r = repo.run("--db-selection", CI="true", GITHUB_EVENT_NAME="pull_request")
        self.assertExit(r, 0)
        self.assertEqual(r.stdout, "skip: no db_test_paths changed\n")

    def test_run_when_a_db_path_changed(self):
        repo = self.make({"server/src/db.ts": "export {}\n"})
        r = repo.run("--db-selection", CI="true", GITHUB_EVENT_NAME="pull_request")
        self.assertExit(r, 0)
        self.assertEqual(r.stdout, "run: server/src/db.ts matches db_test_paths\n")

    def test_run_on_push_and_full_tests(self):
        repo = self.make({"docs/notes.md": "notes\n"})
        r = repo.run("--db-selection", CI="true", GITHUB_EVENT_NAME="push")
        self.assertEqual(r.stdout, "run: CI event push is not a pull request\n")
        r = repo.run("--db-selection", FULL_TESTS="1")
        self.assertEqual(r.stdout, "run: FULL_TESTS=1\n")


class PrBody(RepoCase):
    """A factory PR's body is its ship.md; nothing in it is required or read."""

    # Touches paths main's config lists as high-risk, as every factory PR to the process does.
    BRANCH = {".github/workflows/ci.yml": "name: ci\npermissions: {}\non: push\njobs: {}\n",
              "scripts/tool.sh": "echo hi\n", "src/widget.ts": "export {}\n",
              "src/widget.test.ts": "test\n"}

    def test_ship_md_body_passes_the_pr_stage(self):
        repo = self.make(self.BRANCH)
        r = repo.run("--stage", "pr", CI="true", GITHUB_EVENT_NAME="pull_request",
                     GITHUB_EVENT_PATH=repo.pr_event(SHIP_MD))
        self.assertExit(r, 0)
        self.assertNotIn("Tier", r.stdout)

    def test_empty_body_and_stray_header_lines_pass(self):
        repo = self.make(self.BRANCH)
        for body in ("", SHIP_MD + "\nTier: 0\nChange: none\n"):
            with self.subTest(body=body[-20:]):
                r = repo.run("--stage", "pr", CI="true", GITHUB_EVENT_NAME="pull_request",
                             GITHUB_EVENT_PATH=repo.pr_event(body))
                self.assertExit(r, 0)


class RepoWiring(unittest.TestCase):
    """CI and pre-commit call the reworked stages, under the required check names."""

    def test_workflow_keeps_required_check_names_and_runs_the_stages(self):
        wf = yaml.safe_load((REPO / ".github/workflows/lifecycle.yml").read_text())
        jobs = wf["jobs"]
        for name in ("gates", "secrets", "dependency-review", "db-tests", "db-shard"):
            self.assertIn(name, jobs)
        gates = json.dumps(jobs["gates"])
        self.assertIn("scripts/check-change.sh --stage pr", gates)
        self.assertIn("@fission-ai/openspec@1.13.2", gates)
        self.assertIn("scripts/check-change.sh --db-selection", json.dumps(jobs["db-shard"]))

    def test_pre_commit_keeps_guards_and_calls_the_stages(self):
        cfg = yaml.safe_load((REPO / ".pre-commit-config.yaml").read_text())
        hooks = {h["id"]: h for repo in cfg["repos"] for h in repo["hooks"]}
        self.assertEqual(hooks["no-commit-to-branch"]["args"], ["--branch", "main"])
        for hook_id in ("gitleaks", "check-yaml", "check-json", "check-merge-conflict"):
            self.assertIn(hook_id, hooks)
        self.assertEqual(hooks["lifecycle-commit"]["entry"], "scripts/check-change.sh --stage commit --quiet")
        self.assertEqual(hooks["lifecycle-commit"]["stages"], ["pre-commit"])
        self.assertEqual(hooks["lifecycle-push"]["entry"], "scripts/check-change.sh --stage hook --quiet")
        self.assertEqual(hooks["lifecycle-push"]["stages"], ["pre-push"])


if __name__ == "__main__":
    unittest.main()
