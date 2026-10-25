import os
import subprocess
import sys

import pytest
from heyuna.projects import read_text_file, safe_file
from heyuna.sandbox import workspace_violation


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="FIFO is a POSIX artifact")
def test_malicious_test_fifo_never_blocks_scanning_or_reading(tmp_path):
    path = tmp_path / "test-output"
    os.mkfifo(path)
    with pytest.raises(ValueError):
        safe_file(tmp_path, path.name)
    with pytest.raises(ValueError):
        read_text_file(path)
    assert workspace_violation(tmp_path)
    result = subprocess.run([sys.executable, "-c", "from pathlib import Path; from heyuna.projects import text_files; text_files(Path(__import__('sys').argv[1]))", str(tmp_path)],
                            timeout=3, capture_output=True, check=False)
    assert result.returncode != 0 and b"ValueError" in result.stderr


def test_sparse_oversized_artifact_is_detected(tmp_path):
    with (tmp_path / "large-output").open("wb") as file:
        file.truncate(65 * 1024 * 1024)
    assert "64 MiB" in workspace_violation(tmp_path)
