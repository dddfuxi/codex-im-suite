"""受控本地语音后端。

该模块不下载模型、不扫描任意工作区，也不接受命令字符串。所有二进制和模型
路径都必须由 Node Runtime 验证后通过环境变量注入。
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import threading
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping


PRESET_SPEAKERS = {"cosyvoice.sft.zh_female": "中文女"}
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SENSEVOICE_TAG = re.compile(r"<\|([^|<>\r\n]{1,64})\|>")
SENSEVOICE_LANGUAGES = frozenset({"zh", "en", "yue", "ja", "ko", "nospeech"})
TTS_SENTENCE_END = frozenset("。！？!?；;")
TTS_SOFT_BREAK = frozenset("，,、：:")
MAX_TTS_SEGMENT_CHARS = 300


class BackendFailure(RuntimeError):
    def __init__(self, code: str, status: str = "error") -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class BackendSnapshot:
    state: str
    diagnostic_code: str | None = None


class _ProbeLifecycle:
    """单次探针状态机：health 快照不等待慢加载，请求则复用同一探针结果。"""

    def __init__(
        self,
        dependency_state: str,
        dependency_diagnostic: str,
        pending_diagnostic: str,
    ) -> None:
        if dependency_state == "ready":
            self._snapshot = BackendSnapshot("optional_missing", pending_diagnostic)
            self._complete = False
        else:
            self._snapshot = BackendSnapshot(dependency_state, dependency_diagnostic)
            self._complete = True
        self._started = False
        self._condition = threading.Condition()

    def snapshot(self) -> BackendSnapshot:
        # 慢模型加载在锁外执行，因此 health 永远只做一次短状态读取。
        with self._condition:
            return self._snapshot

    def run(
        self,
        operation: Callable[[], BackendSnapshot],
        failure_diagnostic: str,
    ) -> BackendSnapshot:
        with self._condition:
            if self._complete:
                return self._snapshot
            if self._started:
                while not self._complete:
                    self._condition.wait()
                return self._snapshot
            self._started = True
        try:
            result = operation()
        except Exception:
            result = BackendSnapshot("error", failure_diagnostic)
        with self._condition:
            self._snapshot = result
            self._complete = True
            self._condition.notify_all()
            return self._snapshot


def _safe_file(raw_path: str | None, code: str) -> Path:
    if not raw_path:
        raise BackendFailure(code, "optional_missing")
    candidate = Path(raw_path)
    if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_file():
        raise BackendFailure(code, "blocked")
    return candidate.resolve(strict=True)


def _safe_directory(raw_path: str | None, code: str) -> Path:
    if not raw_path:
        raise BackendFailure(code, "optional_missing")
    candidate = Path(raw_path)
    if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_dir():
        raise BackendFailure(code, "blocked")
    return candidate.resolve(strict=True)


def _validate_pcm16_mono_16k(raw_path: str) -> tuple[Path, int]:
    audio_path = _safe_file(raw_path, "asr_audio_invalid")
    try:
        with wave.open(str(audio_path), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000:
                raise BackendFailure("asr_audio_not_16k_mono_pcm16", "blocked")
            frames = source.getnframes()
            duration_ms = round(frames * 1000 / source.getframerate())
    except BackendFailure:
        raise
    except (EOFError, wave.Error):
        raise BackendFailure("asr_audio_invalid", "blocked") from None
    return audio_path, duration_ms


def _write_silence_probe(target: str) -> None:
    with wave.open(target, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 1600)


def _parse_sensevoice_stdout(stdout: str) -> tuple[str, str]:
    cleaned = CONTROL_CHARS.sub("", ANSI_ESCAPE.sub("", stdout or ""))
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if not lines:
        raise BackendFailure("asr_no_speech")
    # 官方 CLI 将最终转写打印为最后一个非空 stdout 行；--keep-tags 保留首部语言等元标签。
    tagged_text = lines[-1]
    tags = [match.group(1).strip().lower() for match in SENSEVOICE_TAG.finditer(tagged_text)]
    language = next((tag for tag in tags if tag in SENSEVOICE_LANGUAGES), None)
    text = SENSEVOICE_TAG.sub("", tagged_text).strip()
    if language == "nospeech" or not text:
        raise BackendFailure("asr_no_speech")
    if language is None:
        raise BackendFailure("asr_language_tag_missing")
    if len(text) > 100_000:
        raise BackendFailure("asr_transcript_too_large", "blocked")
    return text, language


class SenseVoiceBackend:
    def __init__(
        self,
        binary_path: str | None,
        model_path: str | None,
        dependency_state: str = "optional_missing",
        dependency_diagnostic: str = "sensevoice_dependency_missing",
        timeout_seconds: int = 120,
        runner: Callable[..., Any] = subprocess.run,
    ) -> None:
        self.binary_path = binary_path
        self.model_path = model_path
        self.timeout_seconds = timeout_seconds
        self.runner = runner
        self._probe_lifecycle = _ProbeLifecycle(
            dependency_state,
            dependency_diagnostic,
            "sensevoice_probe_pending",
        )

    def snapshot(self) -> BackendSnapshot:
        return self._probe_lifecycle.snapshot()

    def _invoke(self, audio_path: Path) -> Any:
        binary = _safe_file(self.binary_path, "sensevoice_binary_missing")
        model = _safe_file(self.model_path, "sensevoice_model_missing")
        argv = [str(binary), "-m", str(model), "-a", str(audio_path), "--keep-tags"]
        return self.runner(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=self.timeout_seconds,
            check=False,
            shell=False,
        )

    def probe(self) -> BackendSnapshot:
        def execute() -> BackendSnapshot:
            try:
                with tempfile.TemporaryDirectory(prefix="cti-sensevoice-probe-") as root:
                    probe_path = os.path.join(root, "probe.wav")
                    _write_silence_probe(probe_path)
                    completed = self._invoke(Path(probe_path))
                if int(getattr(completed, "returncode", -1)) != 0:
                    raise BackendFailure("sensevoice_probe_failed")
                return BackendSnapshot("ready")
            except BackendFailure as error:
                return BackendSnapshot(error.status, error.code)
            except (OSError, subprocess.SubprocessError):
                return BackendSnapshot("error", "sensevoice_probe_failed")

        return self._probe_lifecycle.run(execute, "sensevoice_probe_failed")

    def transcribe(self, audio_path: str) -> dict[str, Any]:
        if self.probe().state != "ready":
            snapshot = self.snapshot()
            raise BackendFailure(snapshot.diagnostic_code or "asr_backend_optional_missing", snapshot.state)
        source, duration_ms = _validate_pcm16_mono_16k(audio_path)
        try:
            completed = self._invoke(source)
        except subprocess.TimeoutExpired:
            raise BackendFailure("sensevoice_timeout") from None
        except (OSError, subprocess.SubprocessError):
            raise BackendFailure("sensevoice_execution_failed") from None
        if int(getattr(completed, "returncode", -1)) != 0:
            raise BackendFailure("sensevoice_execution_failed")
        text, language = _parse_sensevoice_stdout(str(getattr(completed, "stdout", "")))
        return {
            "text": text,
            "language": language,
            "durationMs": duration_ms,
            "provider": "sensevoice_gguf",
            "model": _safe_file(self.model_path, "sensevoice_model_missing").name,
        }


def _load_cosyvoice_runtime(model_dir: str) -> tuple[Any, Any, Any]:
    # AutoModel 仅在路径不存在时触发 snapshot_download；前置严格要求本地目录存在。
    from cosyvoice.cli.cosyvoice import AutoModel  # type: ignore[import-not-found]
    import torch  # type: ignore[import-not-found]
    import torchaudio  # type: ignore[import-not-found]

    return AutoModel(model_dir=model_dir, fp16=True), torch, torchaudio


def _split_tts_text(text: str, max_chars: int = MAX_TTS_SEGMENT_CHARS) -> list[str]:
    """按中英文句界切分，并对超长句做有界软切分；不重排、不生成空块。"""
    if max_chars < 1:
        raise ValueError("tts_segment_limit_invalid")
    normalized = CONTROL_CHARS.sub(" ", text).strip()
    sentences: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        sentence = "".join(buffer).strip()
        buffer.clear()
        if sentence:
            sentences.append(sentence)

    for index, character in enumerate(normalized):
        if character in "\r\n":
            flush()
            continue
        buffer.append(character)
        next_character = normalized[index + 1] if index + 1 < len(normalized) else ""
        if character in TTS_SENTENCE_END or (character == "." and (not next_character or next_character.isspace())):
            flush()
    flush()

    segments: list[str] = []
    for sentence in sentences:
        remaining = sentence
        while len(remaining) > max_chars:
            cut = max_chars
            for cursor in range(max_chars, max(max_chars // 2, 1), -1):
                if remaining[cursor - 1].isspace() or remaining[cursor - 1] in TTS_SOFT_BREAK:
                    cut = cursor
                    break
            segment = remaining[:cut].strip()
            if segment:
                segments.append(segment)
            remaining = remaining[cut:].strip()
        if remaining:
            segments.append(remaining)
    return segments


class CosyVoiceBackend:
    def __init__(
        self,
        sft_model_path: str | None,
        reference_model_path: str | None,
        dependency_state: str = "optional_missing",
        dependency_diagnostic: str = "cosyvoice_dependency_missing",
        loader: Callable[[str], tuple[Any, Any, Any]] = _load_cosyvoice_runtime,
    ) -> None:
        self.sft_model_path = sft_model_path
        self.reference_model_path = reference_model_path
        self.loader = loader
        self._probe_lifecycle = _ProbeLifecycle(
            dependency_state,
            dependency_diagnostic,
            "cosyvoice_probe_pending",
        )
        self._sft_runtime: tuple[Any, Any, Any] | None = None
        self._reference_runtime: tuple[Any, Any, Any] | None = None

    def snapshot(self) -> BackendSnapshot:
        return self._probe_lifecycle.snapshot()

    def probe(self) -> BackendSnapshot:
        def execute() -> BackendSnapshot:
            diagnostics: list[str] = []
            if self.sft_model_path:
                try:
                    model_dir = _safe_directory(self.sft_model_path, "cosyvoice_sft_model_missing")
                    runtime = self.loader(str(model_dir))
                    speakers = runtime[0].list_available_spks()
                    if PRESET_SPEAKERS["cosyvoice.sft.zh_female"] not in speakers:
                        raise BackendFailure("cosyvoice_preset_speaker_missing", "blocked")
                    self._sft_runtime = runtime
                except BackendFailure as error:
                    diagnostics.append(error.code)
                except (ImportError, ModuleNotFoundError):
                    diagnostics.append("cosyvoice_runtime_missing")
                except Exception:  # 第三方模型异常不得把原始路径/堆栈外发。
                    diagnostics.append("cosyvoice_sft_model_load_failed")
            if self.reference_model_path:
                try:
                    model_dir = _safe_directory(self.reference_model_path, "cosyvoice_reference_model_missing")
                    if self.sft_model_path and os.path.normcase(str(model_dir)) == os.path.normcase(str(Path(self.sft_model_path).resolve())):
                        self._reference_runtime = self._sft_runtime
                    if self._reference_runtime is None:
                        self._reference_runtime = self.loader(str(model_dir))
                except BackendFailure as error:
                    diagnostics.append(error.code)
                except (ImportError, ModuleNotFoundError):
                    diagnostics.append("cosyvoice_runtime_missing")
                except Exception:
                    diagnostics.append("cosyvoice_reference_model_load_failed")
            if self._sft_runtime is not None or self._reference_runtime is not None:
                return BackendSnapshot("ready")
            return BackendSnapshot(
                "optional_missing" if not diagnostics else "error",
                diagnostics[0] if diagnostics else "cosyvoice_dependency_missing",
            )

        return self._probe_lifecycle.run(execute, "cosyvoice_model_load_failed")

    @staticmethod
    def _safe_output_path(raw_path: str) -> tuple[Path, Path]:
        output = Path(raw_path)
        if not output.is_absolute() or output.suffix.lower() != ".wav":
            raise BackendFailure("tts_output_path_invalid", "blocked")
        parent = output.parent
        if parent.is_symlink() or not parent.is_dir() or output.exists() or output.is_symlink():
            raise BackendFailure("tts_output_path_unsafe", "blocked")
        temporary = parent / f".{output.stem}.{uuid.uuid4().hex}.tmp.wav"
        return output, temporary

    @staticmethod
    def _write_chunks(runtime: tuple[Any, Any, Any], chunks: Iterable[Any], temporary: Path) -> int:
        model, torch_module, torchaudio_module = runtime
        tensors = []
        for chunk in chunks:
            if not isinstance(chunk, Mapping) or chunk.get("tts_speech") is None:
                raise BackendFailure("cosyvoice_chunk_invalid")
            tensors.append(chunk["tts_speech"])
        if not tensors:
            raise BackendFailure("cosyvoice_empty_output")
        combined = torch_module.cat(tensors, dim=1)
        torchaudio_module.save(str(temporary), combined, int(model.sample_rate))
        try:
            with wave.open(str(temporary), "rb") as generated:
                if generated.getnchannels() < 1 or generated.getframerate() <= 0 or generated.getnframes() <= 0:
                    raise BackendFailure("cosyvoice_output_invalid")
                return round(generated.getnframes() * 1000 / generated.getframerate())
        except BackendFailure:
            raise
        except (EOFError, wave.Error):
            raise BackendFailure("cosyvoice_output_invalid") from None

    def synthesize(
        self,
        text: str,
        output_path: str,
        preset_speaker_id: str | None = None,
        reference_path: str | None = None,
        reference_transcript: str | None = None,
    ) -> dict[str, Any]:
        if not isinstance(text, str) or not text.strip() or len(text) > 20_000:
            raise BackendFailure("tts_text_invalid", "blocked")
        text_segments = _split_tts_text(text)
        if not text_segments:
            raise BackendFailure("tts_text_invalid", "blocked")
        if self.probe().state != "ready":
            snapshot = self.snapshot()
            raise BackendFailure(snapshot.diagnostic_code or "tts_backend_optional_missing", snapshot.state)
        output, temporary = self._safe_output_path(output_path)
        completed = False
        try:
            if reference_path is not None or reference_transcript is not None:
                if not reference_path or not isinstance(reference_transcript, str) or not reference_transcript.strip():
                    raise BackendFailure("tts_reference_invalid", "blocked")
                reference = _safe_file(reference_path, "tts_reference_invalid")
                runtime = self._reference_runtime
                if runtime is None:
                    raise BackendFailure("cosyvoice_reference_backend_missing", "optional_missing")
                generated_chunks = []
                for segment in text_segments:
                    generated_chunks.extend(runtime[0].inference_zero_shot(
                        segment, reference_transcript.strip(), str(reference), stream=False
                    ))
            else:
                speaker_id = preset_speaker_id or "cosyvoice.sft.zh_female"
                speaker = PRESET_SPEAKERS.get(speaker_id)
                if speaker is None:
                    raise BackendFailure("tts_preset_unknown", "blocked")
                runtime = self._sft_runtime
                if runtime is None:
                    raise BackendFailure("cosyvoice_sft_backend_missing", "optional_missing")
                generated_chunks = []
                for segment in text_segments:
                    generated_chunks.extend(runtime[0].inference_sft(segment, speaker, stream=False))
            duration_ms = self._write_chunks(runtime, generated_chunks, temporary)
            os.replace(temporary, output)
            completed = True
            return {"durationMs": duration_ms, "provider": "cosyvoice", "model": "cosyvoice"}
        except BackendFailure:
            raise
        except Exception:
            raise BackendFailure("cosyvoice_synthesis_failed") from None
        finally:
            for candidate in (temporary, output if not completed else None):
                if candidate is None:
                    continue
                try:
                    candidate.unlink(missing_ok=True)
                except OSError:
                    pass


class BackendRegistry:
    def __init__(self, sensevoice: SenseVoiceBackend, cosyvoice: CosyVoiceBackend) -> None:
        self.sensevoice = sensevoice
        self.cosyvoice = cosyvoice
        # Sidecar 虽使用 ThreadingHTTPServer，模型执行仍严格串行，和 Node 侧单槽门禁互为防线。
        self._execution_lock = threading.Lock()

    @staticmethod
    def from_environment(env: Mapping[str, str]) -> "BackendRegistry":
        timeout = 120
        try:
            timeout = max(10, min(600, int(env.get("CTI_SPEECH_BACKEND_TIMEOUT_SECONDS", "120"))))
        except ValueError:
            pass
        return BackendRegistry(
            SenseVoiceBackend(
                env.get("CTI_SPEECH_SENSEVOICE_BINARY"),
                env.get("CTI_SPEECH_ASR_MODEL_PATH"),
                env.get("CTI_SPEECH_ASR_DEPENDENCY_STATE", "optional_missing"),
                env.get("CTI_SPEECH_ASR_DIAGNOSTIC", "sensevoice_dependency_missing"),
                timeout,
            ),
            CosyVoiceBackend(
                env.get("CTI_SPEECH_TTS_MODEL_PATH"),
                env.get("CTI_SPEECH_TTS_REFERENCE_MODEL_PATH"),
                env.get("CTI_SPEECH_TTS_DEPENDENCY_STATE", "optional_missing"),
                env.get("CTI_SPEECH_TTS_DIAGNOSTIC", "cosyvoice_dependency_missing"),
            ),
        )

    def start_probe(self) -> None:
        for backend in (self.sensevoice, self.cosyvoice):
            threading.Thread(target=backend.probe, daemon=True, name="cti-speech-backend-probe").start()

    def health(self) -> dict[str, Any]:
        asr = self.sensevoice.snapshot()
        tts = self.cosyvoice.snapshot()
        capabilities = {"asr": asr.state == "ready", "tts": tts.state == "ready"}
        if capabilities["asr"] or capabilities["tts"]:
            state = "ready"
            diagnostic = None
        elif "error" in (asr.state, tts.state):
            state = "error"
            diagnostic = asr.diagnostic_code if asr.state == "error" else tts.diagnostic_code
        elif "blocked" in (asr.state, tts.state):
            state = "blocked"
            diagnostic = asr.diagnostic_code if asr.state == "blocked" else tts.diagnostic_code
        else:
            state = "optional_missing"
            diagnostic = asr.diagnostic_code or tts.diagnostic_code or "speech_backend_optional_missing"
        return {"status": state, "capabilities": capabilities, "diagnosticCode": diagnostic}

    def transcribe(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if payload.get("provider") != "sensevoice_gguf" or not isinstance(payload.get("audioPath"), str):
            raise BackendFailure("asr_request_invalid", "blocked")
        with self._execution_lock:
            return self.sensevoice.transcribe(payload["audioPath"])

    def synthesize(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if payload.get("provider") != "cosyvoice" or not isinstance(payload.get("outputPath"), str):
            raise BackendFailure("tts_request_invalid", "blocked")
        with self._execution_lock:
            return self.cosyvoice.synthesize(
                payload.get("text") if isinstance(payload.get("text"), str) else "",
                payload["outputPath"],
                payload.get("presetSpeakerId") if isinstance(payload.get("presetSpeakerId"), str) else None,
                payload.get("voiceReferencePath") if isinstance(payload.get("voiceReferencePath"), str) else None,
                payload.get("voiceReferenceTranscript") if isinstance(payload.get("voiceReferenceTranscript"), str) else None,
            )
