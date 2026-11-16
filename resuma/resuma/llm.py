"""Minimal OpenAI-compatible chat client (works with the local Halogen/Qwen server, Ollama, LM Studio, vLLM...)."""
from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .config import LLMConfig

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


class LLMCancelled(BaseException):
    """Cancellation must escape repair/retry handlers instead of starting another request."""


@dataclass
class LLMResponse:
    content: str
    reasoning: str
    usage: dict
    seconds: float


def extract_json(text: str):
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        s, e = t.find(opener), t.rfind(closer)
        if s != -1 and e > s:
            frag = t[s:e + 1]
            for candidate in (frag, re.sub(r",\s*([}\]])", r"\1", frag)):
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    continue
    raise ValueError("no JSON object found in model output")


class BaseLLM:
    calls: list[dict]

    def __init__(self):
        self.cancelled = threading.Event()

    def cancel(self) -> None:
        self.cancelled.set()

    def check_cancelled(self) -> None:
        if self.cancelled.is_set():
            raise LLMCancelled("resume job cancelled")

    def chat_json(self, system: str, user: str, schema: type[T], *, temperature: float = 0.3, tag: str = "call",
                  retries: int = 2, max_tokens: int | None = None, thinking: bool | None = None) -> T:
        raise NotImplementedError

    def dump_calls(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        for i, c in enumerate(self.calls, 1):
            (out_dir / f"{i:02d}_{c['tag']}.json").write_text(json.dumps(c, indent=1, ensure_ascii=False), encoding="utf-8")

    def total_usage(self) -> dict:
        tot = {"prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0, "calls": len(self.calls), "seconds": 0.0}
        for c in self.calls:
            u = c.get("usage") or {}
            tot["prompt_tokens"] += u.get("prompt_tokens", 0)
            tot["completion_tokens"] += u.get("completion_tokens", 0)
            tot["reasoning_tokens"] += (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
            tot["seconds"] += c.get("seconds", 0.0)
        return tot


class LLM(BaseLLM):
    def __init__(self, cfg: LLMConfig | None = None, thinking: bool | None = None):
        super().__init__()
        self.cfg = cfg or LLMConfig()
        if not self.cfg.model:
            raise LLMError("RESUMA_MODEL is not set (see .env)")
        # None = per-call choice ("auto"); True/False forces thinking on/off for every call
        self.thinking = thinking
        self._request_lock = threading.Lock()
        self._active_request = None
        self.json_mode_supported: bool | None = None
        self.calls = []

    def cancel(self) -> None:
        with self._request_lock:
            if self.cancelled.is_set():
                return
            super().cancel()
            if self._active_request:
                loop, task = self._active_request
                loop.call_soon_threadsafe(task.cancel)

    async def _post(self, body: dict):
        # Cancelling this task closes the HTTP connection, including while waiting for the
        # first token. The model server sees the disconnected request; no retry follows it.
        with self._request_lock:
            self.check_cancelled()
            self._active_request = (asyncio.get_running_loop(), asyncio.current_task())
        try:
            async with httpx.AsyncClient(base_url=self.cfg.base_url, timeout=self.cfg.timeout,
                                         headers={"Authorization": f"Bearer {self.cfg.api_key or 'none'}"}) as client:
                return await client.post("/chat/completions", json=body)
        except asyncio.CancelledError:
            raise LLMCancelled("resume job cancelled") from None
        finally:
            with self._request_lock:
                self._active_request = None

    def _retry_wait(self, seconds: float) -> None:
        self.cancelled.wait(seconds)
        self.check_cancelled()

    def chat(self, system: str, user: str, *, temperature: float = 0.3, max_tokens: int | None = None,
             tag: str = "call", json_mode: bool = True, history: list[dict] | None = None,
             thinking: bool | None = None) -> LLMResponse:
        messages = [{"role": "system", "content": system}, *(history or []), {"role": "user", "content": user}]
        body: dict = {"model": self.cfg.model, "messages": messages, "temperature": temperature,
                      "max_tokens": max_tokens or self.cfg.max_tokens}
        think = self.thinking if self.thinking is not None else thinking
        if think is not None:
            body["chat_template_kwargs"] = {"enable_thinking": think}
        if json_mode and self.json_mode_supported is not False:
            body["response_format"] = {"type": "json_object"}
        last_err: Exception | None = None
        t0 = time.time()
        data = None
        for attempt in range(4):
            self.check_cancelled()
            try:
                r = asyncio.run(self._post(body))
            except httpx.HTTPError as e:
                self.check_cancelled()
                last_err = e
                self._retry_wait(2 * (attempt + 1))
                continue
            self.check_cancelled()
            if r.status_code == 400 and "response_format" in body:
                self.json_mode_supported = False
                body.pop("response_format")
                continue
            if r.status_code >= 500:
                last_err = LLMError(f"server {r.status_code}: {r.text[:300]}")
                self._retry_wait(2 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise LLMError(f"request failed {r.status_code}: {r.text[:500]}")
            data = r.json()
            if self.json_mode_supported is None and "response_format" in body:
                self.json_mode_supported = True
            break
        if data is None:
            raise LLMError(f"LLM unreachable after retries: {last_err}")
        msg = data["choices"][0]["message"]
        content = msg.get("content") or ""
        reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
        m = re.search(r"<think>(.*?)</think>", content, flags=re.S)
        if m:
            reasoning = reasoning or m.group(1)
            content = content.replace(m.group(0), "").strip()
        if not content.strip() and reasoning:
            content = reasoning  # ran out of tokens before answering; the JSON may be in the reasoning
        resp = LLMResponse(content, reasoning, data.get("usage") or {}, time.time() - t0)
        self.calls.append({"tag": tag, "system": system, "user": user, "content": content, "reasoning": reasoning,
                           "usage": resp.usage, "seconds": round(resp.seconds, 2),
                           "finish_reason": data["choices"][0].get("finish_reason")})
        return resp

    def chat_json(self, system: str, user: str, schema: type[T], *, temperature: float = 0.3, tag: str = "call",
                  retries: int = 2, max_tokens: int | None = None, thinking: bool | None = None) -> T:
        prompt = user
        history: list[dict] = []
        err_text = ""
        tokens = max_tokens or self.cfg.max_tokens
        think = thinking
        for attempt in range(retries + 1):
            resp = self.chat(system, prompt, temperature=temperature, tag=f"{tag}{'' if attempt == 0 else f'_retry{attempt}'}",
                             history=history, max_tokens=tokens, thinking=think)
            try:
                return schema.model_validate(extract_json(resp.content))
            except (ValueError, ValidationError) as e:
                err_text = str(e)[:800]
                truncated = self.calls[-1].get("finish_reason") == "length" or not resp.content.rstrip().endswith(("}", "]"))
                if truncated:
                    # the answer was cut off (thinking ate the budget or the JSON is long): ask again from scratch
                    # with twice the room and no thinking instead of feeding the broken reply back
                    tokens, think, history, prompt = tokens * 2, False, [], user
                    err_text = f"reply truncated at {resp.usage.get('completion_tokens', '?')} tokens; {err_text}"
                    continue
                history = [{"role": "user", "content": user}, {"role": "assistant", "content": resp.content[:4000]}]
                prompt = (f"Your previous reply was not valid for the requested JSON shape:\n{err_text}\n"
                          f"Reply again with ONLY the corrected JSON object.")
        raise LLMError(f"{tag}: model never returned valid JSON ({err_text})")


class MockLLM(BaseLLM):
    """Deterministic stand-in for tests: `handler(tag, system, user) -> dict`."""

    def __init__(self, handler: Callable[[str, str, str], dict]):
        super().__init__()
        self.handler = handler
        self.calls = []

    def chat_json(self, system: str, user: str, schema: type[T], *, temperature: float = 0.3, tag: str = "call",
                  retries: int = 2, max_tokens: int | None = None, thinking: bool | None = None) -> T:
        self.check_cancelled()
        data = self.handler(tag, system, user)
        self.check_cancelled()
        self.calls.append({"tag": tag, "system": system, "user": user, "content": json.dumps(data), "reasoning": "",
                           "usage": {}, "seconds": 0.0})
        return schema.model_validate(data)
