"""Local TLS launch configuration and executor shutdown regression checks."""
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from heyuna.app import create_app
from heyuna.cli import main


def test_application_shutdown_closes_its_executor(tmp_path):
    executor = Mock()
    with TestClient(create_app(tmp_path, "test-token-" + "x" * 48, model=Mock(), sandbox=executor)):
        executor.close.assert_not_called()
    executor.close.assert_called_once_with()


def test_cli_passes_tls_files_to_uvicorn(monkeypatch, tmp_path):
    launch = Mock()
    monkeypatch.setenv("HEYUNA_LOCAL_TOKEN", "test-token-" + "x" * 48)
    monkeypatch.setenv("HEYUNA_TLS_CERT", str(tmp_path / "certificate.pem"))
    monkeypatch.setenv("HEYUNA_TLS_KEY", str(tmp_path / "private-key.pem"))
    monkeypatch.setattr("uvicorn.run", launch)
    monkeypatch.setattr("sys.argv", ["heyuna", "serve", "--state-dir", str(tmp_path)])
    main()
    assert launch.call_args.kwargs["ssl_certfile"] == str(tmp_path / "certificate.pem")
    assert launch.call_args.kwargs["ssl_keyfile"] == str(tmp_path / "private-key.pem")
    assert launch.call_args.kwargs["host"] == "127.0.0.1"


def test_cli_rejects_incomplete_tls_identity(monkeypatch, tmp_path):
    launch = Mock()
    monkeypatch.setenv("HEYUNA_TLS_CERT", str(tmp_path / "certificate.pem"))
    monkeypatch.delenv("HEYUNA_TLS_KEY", raising=False)
    monkeypatch.setattr("uvicorn.run", launch)
    monkeypatch.setattr("sys.argv", ["heyuna", "serve"])
    with pytest.raises(SystemExit):
        main()
    launch.assert_not_called()
