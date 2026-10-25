
import pytest
from fastapi.testclient import TestClient
from heyuna.app import create_app

TOKEN = "local-test-authorization-" + "x" * 32


class MissingModel:
    def snapshot(self):
        return {"id": "test-model", "ready": False, "state": "missing"}


class MissingSandbox:
    def status(self):
        return {"available": False, "reason": "test has no container"}


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path, TOKEN, MissingModel(), MissingSandbox())
    with TestClient(app) as client:
        yield client


def auth():
    return {"Authorization": "Bearer " + TOKEN}


def test_authorization_and_origin_fail_closed(client):
    assert client.get("/api/status").status_code == 401
    assert client.get("/api/status", headers={**auth(), "Origin": "https://evil.invalid"}).status_code == 403
    result = client.get("/api/status", headers=auth())
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["sandbox"]["available"] is False


def test_settings_validate_and_persist(client):
    data = client.get("/api/settings", headers=auth()).json()
    data.pop("detail"); data.pop("supported_limits")
    data["max_upload_mb_day"] = 64
    assert client.put("/api/settings", headers=auth(), json=data).status_code == 200
    assert client.get("/api/settings", headers=auth()).json()["max_upload_mb_day"] == 64
    data["start_time"] = "25:70"
    assert client.put("/api/settings", headers=auth(), json=data).status_code == 422


def test_unavailable_services_never_fabricate_results(client, tmp_path):
    project = tmp_path / "project"; project.mkdir(); (project / "test.py").write_text("assert True")
    opened = client.post("/api/projects/open", headers=auth(), json={"path": str(project)}).json()
    result = client.post("/api/agent/tasks", headers=auth(), json={"project_id": opened["id"], "prompt": "test"})
    assert result.status_code == 409
    rewards = client.get("/api/rewards/config", headers=auth()).json()
    assert rewards["state"] == "not_deployed" and rewards["token_address"] is None


def test_body_limit_counts_bytes_and_handles_invalid_length(client):
    assert client.post("/api/chat", headers={**auth(), "Content-Length": "invalid"}, content=b"{}").status_code == 413
    assert client.post("/api/chat", headers=auth(), content=b"x" * (2 * 1024 * 1024 + 1)).status_code == 413


def test_no_weak_auth_mode(tmp_path):
    with pytest.raises(RuntimeError):
        create_app(tmp_path, "short")
