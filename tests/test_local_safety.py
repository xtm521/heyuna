import json
import threading

import pytest
from heyuna.agent import parse_action
from heyuna.projects import apply_changes, safe_file, text_files
from heyuna.sandbox import Sandbox


@pytest.mark.parametrize("path", ["../private", "/tmp/file", "sub/../../secret", "C:\\Windows\\file", ".env", ".ssh/id_rsa"])
def test_project_scope_rejects_escape_and_credentials(tmp_path, path):
    with pytest.raises(ValueError):
        safe_file(tmp_path, path)


def test_symlink_is_not_read_or_copied(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    secret = tmp_path / "secret"
    secret.write_text("private")
    (root / "link.py").symlink_to(secret)
    assert text_files(root) == {}
    with pytest.raises(ValueError):
        safe_file(root, "link.py")


def test_conflict_aborts_all_writes_and_revert_preserves_user_changes(tmp_path):
    (tmp_path / "a.py").write_text("a")
    (tmp_path / "b.py").write_text("user edit")
    changes = [{"path": "a.py", "before": "a", "after": "new"},
               {"path": "b.py", "before": "b", "after": "new"}]
    with pytest.raises(ValueError):
        apply_changes(tmp_path, changes)
    assert (tmp_path / "a.py").read_text() == "a"
    apply_changes(tmp_path, changes[:1])
    apply_changes(tmp_path, changes[:1], reverse=True)
    assert (tmp_path / "a.py").read_text() == "a"


def test_model_has_no_wallet_or_host_tool():
    for tool in ["sign_transaction", "host_shell", "read_private_key"]:
        with pytest.raises(ValueError):
            parse_action(json.dumps({"tool": tool, "arguments": {}}))


def test_docker_policy_and_no_host_fallback(tmp_path):
    sandbox = Sandbox("/known/docker")
    command = sandbox.command(tmp_path, ["python", "-m", "unittest"], "test")
    for required in ["--network=none", "--read-only", "--cap-drop=ALL", "--pids-limit=128", "--user=65532:65532"]:
        assert required in command
    assert "docker.sock" not in " ".join(command)
    assert "--privileged" not in command
    sandbox.docker = None
    with pytest.raises(RuntimeError):
        sandbox.run(tmp_path, ["touch", "never"], threading.Event())
    assert not (tmp_path / "never").exists()
