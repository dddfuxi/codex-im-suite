"""FireRedASR2-AED 的一次性演唱歌词验收入口。

该脚本仅由 Windows Runtime 经 WSL ``--exec`` 调用：不监听端口、不下载模型、
不读取任意工作区，也不输出路径、歌词或堆栈。模型和已归一化的 16k 单声道 WAV
均由 Node Runtime 在受管根内复验后以绝对路径提供。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import wave
from pathlib import Path
from typing import Any


MODEL_NAME = "fireredasr2-aed"
PROVIDER = "fireredasr2_aed_wsl"
LANGUAGE = "zh"


def fail(code: str) -> "None":
    # 对 Windows 上层只暴露稳定错误码；不得泄露模型路径、用户音频路径或堆栈。
    raise SystemExit(code)


def regular_file(value: str, code: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_file():
        fail(code)
    return candidate.resolve(strict=True)


def regular_directory(value: str, code: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_dir():
        fail(code)
    return candidate.resolve(strict=True)


def validate_audio(source: Path) -> None:
    try:
        with wave.open(str(source), "rb") as audio:
            if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
                fail("singing_lyrics_verifier_audio_format_invalid")
            # FireRed AED 官方建议单段不超过 60 秒；上游已按歌声限制裁决，
            # 这里再次收口，避免模型位置编码异常或非预期资源消耗。
            if audio.getnframes() <= 0 or audio.getnframes() > 60 * 16000:
                fail("singing_lyrics_verifier_audio_duration_invalid")
    except (EOFError, wave.Error):
        fail("singing_lyrics_verifier_audio_invalid")


def result_text(result: Any) -> str:
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
        fail("singing_lyrics_verifier_response_invalid")
    text = result[0].get("text")
    if not isinstance(text, str):
        fail("singing_lyrics_verifier_response_invalid")
    normalized = text.strip()
    if not normalized or len(normalized) > 100_000 or "\x00" in normalized:
        fail("singing_lyrics_verifier_response_invalid")
    return normalized


def transcribe(audio_path: Path, model_path: Path) -> str:
    # 仅在模型目录已存在时导入；from_pretrained 传入本地绝对目录，禁止快照下载。
    try:
        from fireredasr2s.fireredasr2 import FireRedAsr2, FireRedAsr2Config  # type: ignore[import-not-found]
    except (ImportError, ModuleNotFoundError):
        fail("singing_lyrics_verifier_runtime_missing")
    try:
        use_gpu = os.environ.get("CTI_FIRERED_USE_GPU", "true").strip().lower() == "true"
        config = FireRedAsr2Config(
            use_gpu=use_gpu,
            use_half=False,
            beam_size=3,
            nbest=1,
            decode_max_len=0,
            softmax_smoothing=1.25,
            aed_length_penalty=0.6,
            eos_penalty=1.0,
            return_timestamp=True,
        )
        model = FireRedAsr2.from_pretrained("aed", str(model_path), config)
        return result_text(model.transcribe(["singing"], [str(audio_path)]))
    except SystemExit:
        raise
    except Exception:
        fail("singing_lyrics_verifier_execution_failed")


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--audio-path", required=True)
    parser.add_argument("--model-path", required=True)
    args = parser.parse_args()
    if not isinstance(args.audio_path, str) or not isinstance(args.model_path, str):
        fail("singing_lyrics_verifier_request_invalid")
    source = regular_file(args.audio_path, "singing_lyrics_verifier_audio_invalid")
    model = regular_directory(args.model_path, "singing_lyrics_verifier_model_missing")
    validate_audio(source)
    text = transcribe(source, model)
    sys.stdout.write(json.dumps({
        "text": text,
        "language": LANGUAGE,
        "model": MODEL_NAME,
        "provider": PROVIDER,
    }, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
