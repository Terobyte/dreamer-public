import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch
import aiohttp
import pytest

import rt


def _make_text_msg(data):
    m = MagicMock()
    m.type = aiohttp.WSMsgType.TEXT
    m.data = data
    return m


def _setup_ws_mock(messages):
    ws = MagicMock()
    ws.prepare = AsyncMock()
    # async-for over ws yields messages
    async def _aiter(self):
        for m in messages:
            yield m
    ws.__aiter__ = _aiter
    return ws


def _setup_request(ws):
    req = MagicMock()
    req.headers = {"Origin": "http://localhost:8091"}
    req.query = {"asr": "meta"}
    return req, ws


async def _run_handler_with_text(payload: str):
    ws = _setup_ws_mock([_make_text_msg(payload)])
    req, _ = _setup_request(ws)
    with patch.object(rt.web, "WebSocketResponse", return_value=ws), \
         patch.object(rt.aiohttp, "ClientSession") as sess_cls, \
         patch.object(rt, "MetaTurns") as turns_cls:
        sess = MagicMock()
        sess_cls.return_value.__aenter__ = AsyncMock(return_value=MagicMock())
        sess_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        bg = MagicMock()
        bg.cancel = MagicMock()
        turns = MagicMock()
        turns.watch.return_value = asyncio.sleep(10)
        turns.feed = AsyncMock()
        turns_cls.return_value = turns
        # run with timeout guard so infinite loops fail fast
        await asyncio.wait_for(rt.ws_handler(req), timeout=5)
    return ws, turns


@pytest.mark.asyncio
async def test_invalid_json_text_frame_does_not_kill_handler():
    """'ping' is not JSON: handler must ignore it, not raise JSONDecodeError."""
    try:
        await _run_handler_with_text("ping")
    except json.JSONDecodeError as e:
        assert False, f"ws_handler crashed on non-JSON text frame: {e}"
    except AttributeError as e:
        assert False, f"ws_handler crashed with AttributeError: {e}"


@pytest.mark.asyncio
async def test_non_dict_json_text_frame_does_not_kill_handler():
    """'[1, 2]' / 'null' decode ok but have no .get: must be ignored."""
    for payload in ("[1, 2]", "null", '"hello"'):
        try:
            await _run_handler_with_text(payload)
        except (AttributeError, TypeError) as e:
            assert False, f"ws_handler crashed on non-dict JSON {payload!r}: {e}"
        except json.JSONDecodeError as e:
            assert False, f"ws_handler crashed with JSONDecodeError on {payload!r}: {e}"
