import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from resuma.config import LLMConfig
from resuma.jobs import JobManager
from resuma.llm import LLM, LLMCancelled, MockLLM


def test_cancel_closes_inflight_http_before_any_response_and_never_retries():
    received, disconnected = threading.Event(), threading.Event()
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            calls.append(self.path)
            received.set()
            self.connection.settimeout(5)
            if self.connection.recv(1) == b"":
                disconnected.set()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    llm = LLM(LLMConfig(base_url=f"http://127.0.0.1:{server.server_port}/v1", model="test", timeout=30))
    errors = []

    def request():
        try:
            llm.chat("system", "a request that must be aborted")
        except LLMCancelled as exc:
            errors.append(exc)

    worker = threading.Thread(target=request, daemon=True)
    try:
        worker.start()
        assert received.wait(3)
        llm.cancel()
        worker.join(2)
        assert not worker.is_alive(), "cancel must not wait for the model response or timeout"
        assert disconnected.wait(2), "server must see the request connection close"
        assert len(errors) == 1
        with pytest.raises(LLMCancelled):
            llm.chat("system", "must not start another generation")
        assert calls == ["/v1/chat/completions"]
    finally:
        llm.cancel()
        server.shutdown()
        server.server_close()


def test_cancel_running_job_releases_worker_for_next_and_never_publishes_result(monkeypatch, tmp_path):
    from resuma import pipeline

    started, next_started = threading.Event(), threading.Event()
    visited = []

    class Pipeline:
        def __init__(self, jd, llm, **kwargs):
            self.llm = llm

        def run(self, company, out_root):
            visited.append(company)
            if company == "first":
                started.set()
                assert self.llm.cancelled.wait(3)
                self.llm.check_cancelled()
                pytest.fail("cancelled run continued")
            next_started.set()
            return {"company": company, "pdf": str(tmp_path / company / "resume.pdf")}

    monkeypatch.setattr(pipeline, "Tailor", Pipeline)
    manager = JobManager(out_root=tmp_path, llm_factory=lambda _: MockLLM(lambda *_: {}))
    monkeypatch.setattr(manager, "_write_job_file", lambda _: None)
    first = manager.submit("job posting " * 20, company="first")
    assert started.wait(2)
    second = manager.submit("another posting " * 20, company="second")
    assert manager.cancel(first.id)
    assert first.done.wait(2)
    assert next_started.wait(2)
    assert second.done.wait(2)
    assert first.status == "cancelled" and first.report is None and first.finished
    assert second.status == "done"
    assert visited == ["first", "second"]
    assert manager.current is None
    assert not manager.cancel(second.id), "finished results must be preserved"


def test_cancel_queued_job_never_calls_model_and_repeated_cancel_is_safe(monkeypatch, tmp_path):
    from resuma import pipeline

    started = threading.Event()
    models = []

    def factory(_):
        llm = MockLLM(lambda *_: {})
        models.append(llm)
        return llm

    class Pipeline:
        def __init__(self, jd, llm, **kwargs):
            self.llm = llm

        def run(self, **kwargs):
            started.set()
            assert self.llm.cancelled.wait(3)
            self.llm.check_cancelled()

    monkeypatch.setattr(pipeline, "Tailor", Pipeline)
    manager = JobManager(out_root=tmp_path, llm_factory=factory)
    first = manager.submit("posting " * 20)
    assert started.wait(2)
    queued = manager.submit("posting " * 20)
    assert manager.cancel(queued.id)
    assert manager.cancel(queued.id)
    assert queued.done.is_set() and queued.status == "cancelled"
    assert manager.cancel(first.id)
    assert first.done.wait(2)
    assert len(models) == 1
    assert not manager.cancel("missing")


def test_cancel_during_retry_wait_does_not_retry():
    llm = LLM(LLMConfig(model="test"))
    started = threading.Event()

    def wait():
        started.set()
        with pytest.raises(LLMCancelled):
            llm._retry_wait(30)

    thread = threading.Thread(target=wait, daemon=True)
    thread.start()
    assert started.wait(1)
    llm.cancel()
    thread.join(1)
    assert not thread.is_alive()
