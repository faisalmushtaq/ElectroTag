"""The Firebase set-up: firebase.json publishes the application with Firebase Hosting, the predeploy
step runs on every system, no study's config.json is committed, and the guide gives every command
that differs on Windows in a PowerShell version beside the macOS and Linux one."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GUIDE = REPO / "docs" / "web" / "firebase.md"


def firebase_json() -> dict:
    return json.loads((REPO / "firebase.json").read_text(encoding="utf-8"))


def test_hosting_publishes_the_application_without_a_config_json():
    hosting = firebase_json()["hosting"]
    public = REPO / hosting["public"]
    assert (public / "index.html").is_file()
    assert public == REPO / "electrotag" / "web" / "static"
    # A config.json beside the application would point the project's own copy at another project.
    assert "config.json" in hosting["ignore"]


def test_the_predeploy_step_runs_with_node_and_names_existing_scripts():
    (functions,) = firebase_json()["functions"]
    (step,) = functions["predeploy"]
    assert step.startswith("node "), "Node.js is there wherever Firebase's tool runs; python3 is not on Windows"
    script = re.search(r'"\$PROJECT_DIR/([^"]+)"', step).group(1)
    assert REPO / script == REPO / "scripts" / "predeploy_functions.mjs"
    assert (REPO / script).is_file() and (REPO / "scripts" / "vendor_functions.py").is_file()


def test_no_predeploy_command_climbs_folders():
    # On Windows, Firebase's tool runs a hook through cross-env, which tidies the whole command
    # line as one path: each ".." then removes the text before it, and the command is cut short
    # ("spawn ..\\..\\..\\scripts\\predeploy_functions.mjs ... ENOENT"). Name files from
    # $PROJECT_DIR instead.
    config = firebase_json()
    hooks = [cmd for target in ("functions", "hosting", "firestore")
             for block in (config.get(target) if isinstance(config.get(target), list) else [config.get(target) or {}])
             for key in ("predeploy", "postdeploy") for cmd in block.get(key, [])]
    assert hooks
    for cmd in hooks:
        assert ".." not in cmd, cmd


def test_no_config_json_is_committed():
    assert "/electrotag/web/static/config.json" in (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()
    try:
        tracked = subprocess.run(["git", "ls-files", "electrotag/web/static/config.json"], cwd=REPO,
                                 capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):  # not a git checkout (a source archive)
        return
    assert tracked == "", "the end-to-end tests serve electrotag/web/static and expect the demonstration"


def code_blocks(text: str) -> list[tuple[str, str, str]]:
    """(language, the line of text before the block, the block's contents) for each fenced block."""
    out = []
    for m in re.finditer(r"^```(\w*)\n(.*?)^```", text, flags=re.MULTILINE | re.DOTALL):
        before = [line for line in text[:m.start()].splitlines() if line.strip()]
        out.append((m.group(1), before[-1] if before else "", m.group(2)))
    return out


def test_the_guide_pairs_every_macos_and_linux_block_with_a_powershell_one():
    blocks = code_blocks(GUIDE.read_text(encoding="utf-8"))
    for i, (lang, before, body) in enumerate(blocks):
        if lang == "bash":
            assert before == "macOS and Linux (Terminal):", body
            nxt = blocks[i + 1]
            assert nxt[0] == "powershell" and nxt[1] == "Windows (PowerShell):", f"no PowerShell version after:\n{body}"
            assert len(nxt[2].splitlines()) == len(body.splitlines())
        if lang == "powershell":
            assert before == "Windows (PowerShell):"
            assert blocks[i - 1][0] == "bash"
    unlabelled = "\n".join(body for lang, _, body in blocks if lang == "")
    # A block shown once works as it stands in both terminals: no variables set the Unix way,
    # no ~ (which PowerShell does not expand for other programs) and no Unix-only commands.
    for bad in ("export ", "~/", "source ", "cp ", "python3", "/bin/"):
        assert bad not in unlabelled, bad


def test_the_guide_quotes_the_deploy_list_and_signs_in_before_the_admin_area():
    text = GUIDE.read_text(encoding="utf-8")
    deploys = re.findall(r"firebase-tools deploy --only (\S+)", text)
    assert deploys and all(d == '"functions,firestore,hosting"' for d in deploys), deploys
    steps = re.findall(r"^## (\d+)\. (.+)$", text, flags=re.MULTILINE)
    assert [int(n) for n, _ in steps] == list(range(1, 15))
    titles = {title: int(n) for n, title in steps}
    assert titles["Sign in to the application"] < titles["Set the study up in the admin area"]
    assert "config.json first" not in text
