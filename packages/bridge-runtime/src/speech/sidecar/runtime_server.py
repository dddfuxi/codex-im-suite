#!/usr/bin/env python3
"""Versioned loopback-only speech sidecar with optional real local backends."""

from __future__ import annotations

import argparse
import hmac
import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# 受管 CPython 使用隔离 _pth，不会自动把入口脚本目录加入 sys.path。
# 只加入当前发布目录，确保同包 backends.py 可导入，同时不恢复外部 PYTHONPATH。
SIDECAR_MODULE_ROOT = str(Path(__file__).resolve().parent)
if SIDECAR_MODULE_ROOT not in sys.path:
    sys.path.insert(0, SIDECAR_MODULE_ROOT)

from backends import BackendFailure, BackendRegistry


PROTOCOL = "cti-speech-sidecar/v1"
RESULT_PROTOCOL = "cti-speech-sidecar-result/v1"
VERSION = "1.2.0"
MAX_REQUEST_BYTES = 64 * 1024


def health_payload(backends: BackendRegistry) -> dict[str, Any]:
    payload = backends.health()
    result = {
        "protocol": PROTOCOL,
        "status": payload["status"],
        "version": VERSION,
        "capabilities": payload["capabilities"],
        "diagnosticCode": payload.get("diagnosticCode"),
    }
    if payload.get("tts"):
        result["tts"] = payload["tts"]
    return result


class SpeechHandler(BaseHTTPRequestHandler):
    server_version = "CtiSpeechSidecar/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    @property
    def expected_token(self) -> str:
        return str(getattr(self.server, "speech_token", ""))

    @property
    def backends(self) -> BackendRegistry:
        return getattr(self.server, "speech_backends")

    def authorized(self) -> bool:
        token = self.headers.get("x-cti-speech-token", "")
        protocol = self.headers.get("x-cti-speech-protocol", "")
        return protocol == PROTOCOL and bool(token) and hmac.compare_digest(token, self.expected_token)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reject_auth(self) -> None:
        self.send_json(HTTPStatus.UNAUTHORIZED, {
            "protocol": RESULT_PROTOCOL,
            "ok": False,
            "status": "blocked",
            "errorCode": "sidecar_auth_failed",
        })

    def do_GET(self) -> None:  # noqa: N802
        if not self.authorized():
            self.reject_auth()
            return
        if self.path != "/v1/health":
            self.send_json(HTTPStatus.NOT_FOUND, {"protocol": RESULT_PROTOCOL, "ok": False, "status": "blocked", "errorCode": "route_not_found"})
            return
        self.send_json(HTTPStatus.OK, health_payload(self.backends))

    def do_POST(self) -> None:  # noqa: N802
        if not self.authorized():
            self.reject_auth()
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"protocol": RESULT_PROTOCOL, "ok": False, "status": "blocked", "errorCode": "request_size_invalid"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"protocol": RESULT_PROTOCOL, "ok": False, "status": "blocked", "errorCode": "request_json_invalid"})
            return
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"protocol": RESULT_PROTOCOL, "ok": False, "status": "blocked", "errorCode": "request_shape_invalid"})
            return
        try:
            if self.path == "/v1/transcribe":
                result = self.backends.transcribe(payload)
            elif self.path == "/v1/synthesize":
                result = self.backends.synthesize(payload)
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"protocol": RESULT_PROTOCOL, "ok": False, "status": "blocked", "errorCode": "route_not_found"})
                return
        except BackendFailure as error:
            status = HTTPStatus.SERVICE_UNAVAILABLE if error.status == "optional_missing" else HTTPStatus.BAD_REQUEST if error.status == "blocked" else HTTPStatus.INTERNAL_SERVER_ERROR
            self.send_json(status, {
                "protocol": RESULT_PROTOCOL,
                "ok": False,
                "status": error.status,
                "errorCode": error.code,
            })
            return
        self.send_json(HTTPStatus.OK, {
            "protocol": RESULT_PROTOCOL,
            "ok": True,
            "status": "ready",
            "result": result,
        })


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--protocol", required=True)
    args = parser.parse_args()
    token = os.environ.get("CTI_SPEECH_SIDECAR_TOKEN", "")
    if args.host != "127.0.0.1" or args.protocol != PROTOCOL or len(token) < 32:
        raise SystemExit(2)
    backends = BackendRegistry.from_environment(os.environ)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), SpeechHandler)
    setattr(server, "speech_token", token)
    setattr(server, "speech_backends", backends)
    print(json.dumps({"protocol": PROTOCOL, "status": "ready", "port": server.server_port}, separators=(",", ":")), flush=True)
    backends.start_probe()
    server.serve_forever(poll_interval=0.25)


if __name__ == "__main__":
    main()
