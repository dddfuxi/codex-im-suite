from __future__ import annotations

import importlib.util
import os
import stat
import sys
sys.dont_write_bytecode = True
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace


MODULE_PATH = Path(__file__).parents[1] / "speech" / "sidecar" / "backends.py"
SPEC = importlib.util.spec_from_file_location("cti_speech_backends", MODULE_PATH)
assert SPEC and SPEC.loader
BACKENDS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BACKENDS
SPEC.loader.exec_module(BACKENDS)


def write_wav(target: Path, seconds: float = 0.1) -> None:
    with wave.open(str(target), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * int(16000 * seconds))


class FakeModel:
    sample_rate = 16000

    def __init__(self) -> None:
        self.calls = []

    def list_available_spks(self):
        return ["中文女"]

    def inference_sft(self, text, speaker, stream=False):
        self.calls.append(("sft", text, speaker, stream))
        return [{"tts_speech": "a"}, {"tts_speech": "b"}]

    def inference_zero_shot(self, text, prompt_text, prompt_wav, stream=False):
        self.calls.append(("reference", text, prompt_text, prompt_wav, stream))
        return [{"tts_speech": "a"}]


class FakeTorch:
    @staticmethod
    def cat(chunks, dim):
        assert dim == 1
        return list(chunks)


class FakeAudio:
    calls = []

    @staticmethod
    def save(target, combined, sample_rate):
        FakeAudio.calls.append((target, combined, sample_rate))
        write_wav(Path(target), 0.2)


class SpeechBackendTests(unittest.TestCase):
    def test_dependency_ready_is_probe_pending_until_a_real_probe_succeeds(self):
        registry = BACKENDS.BackendRegistry(
            BACKENDS.SenseVoiceBackend(None, None, "ready", ""),
            BACKENDS.CosyVoiceBackend(None, None, "ready", ""),
        )

        health = registry.health()

        self.assertEqual(health["status"], "optional_missing")
        self.assertEqual(health["capabilities"], {"asr": False, "tts": False})
        self.assertEqual(health["diagnosticCode"], "sensevoice_probe_pending")

    def test_health_snapshot_stays_non_blocking_while_requests_wait_for_the_same_probe(self):
        with tempfile.TemporaryDirectory(prefix="cti-sidecar-probe-race-") as root:
            root_path = Path(root)
            binary = root_path / ("sensevoice.exe" if os.name == "nt" else "sensevoice")
            binary.write_bytes(b"fake")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            model = root_path / "model.gguf"
            model.write_bytes(b"GGUF")
            audio = root_path / "input.wav"
            write_wav(audio, 0.2)
            probe_started = threading.Event()
            allow_probe = threading.Event()
            calls = []

            def runner(argv, **kwargs):
                calls.append((argv, kwargs))
                if len(calls) == 1:
                    probe_started.set()
                    self.assertTrue(allow_probe.wait(2))
                return SimpleNamespace(
                    returncode=0,
                    stdout="<|zh|><|NEUTRAL|><|Speech|><|woitn|>并发探针完成\n",
                    stderr="",
                )

            backend = BACKENDS.SenseVoiceBackend(str(binary), str(model), "ready", "", runner=runner)
            probe_thread = threading.Thread(target=backend.probe)
            probe_thread.start()
            self.assertTrue(probe_started.wait(1))

            snapshot_result = []
            snapshot_thread = threading.Thread(target=lambda: snapshot_result.append(backend.snapshot()))
            snapshot_thread.start()
            snapshot_thread.join(0.2)
            self.assertFalse(snapshot_thread.is_alive(), "health snapshot 不应等待慢模型探针")
            self.assertEqual(snapshot_result[0].state, "optional_missing")
            self.assertEqual(snapshot_result[0].diagnostic_code, "sensevoice_probe_pending")

            transcript_result = []
            transcript_thread = threading.Thread(target=lambda: transcript_result.append(backend.transcribe(str(audio))))
            transcript_thread.start()
            transcript_thread.join(0.05)
            self.assertTrue(transcript_thread.is_alive(), "请求必须等待正在运行的同一探针")

            allow_probe.set()
            probe_thread.join(2)
            transcript_thread.join(2)
            self.assertFalse(probe_thread.is_alive())
            self.assertFalse(transcript_thread.is_alive())
            self.assertEqual(transcript_result[0]["text"], "并发探针完成")
            self.assertEqual(len(calls), 2, "一个探针调用加一个真实转写调用，不能重复探针")

    def test_sensevoice_uses_fixed_argv_and_parses_last_stdout_line(self):
        with tempfile.TemporaryDirectory(prefix="cti-sidecar-asr-") as root:
            root_path = Path(root)
            binary = root_path / ("llama-funasr-sensevoice.exe" if os.name == "nt" else "llama-funasr-sensevoice")
            binary.write_bytes(b"fake")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            model = root_path / "sensevoice-small-q8.gguf"
            model.write_bytes(b"GGUF")
            audio = root_path / "input.wav"
            write_wav(audio, 1.0)
            calls = []

            def runner(argv, **kwargs):
                calls.append((argv, kwargs))
                return SimpleNamespace(
                    returncode=0,
                    stdout="probe\n<|zh|><|NEUTRAL|><|Speech|><|woitn|>最终识别文本\n",
                    stderr="",
                )

            backend = BACKENDS.SenseVoiceBackend(str(binary), str(model), "ready", "", runner=runner)
            result = backend.transcribe(str(audio))
            self.assertEqual(result["text"], "最终识别文本")
            self.assertEqual(result["language"], "zh")
            self.assertEqual(
                calls[-1][0],
                [str(binary.resolve()), "-m", str(model.resolve()), "-a", str(audio.resolve()), "--keep-tags"],
            )
            self.assertFalse(calls[-1][1]["shell"])

    def test_sensevoice_rejects_nospeech_and_tag_only_results(self):
        for output in (
            "<|nospeech|><|NEUTRAL|><|Speech|><|woitn|>",
            "<|zh|><|NEUTRAL|><|Speech|><|woitn|>",
        ):
            with self.subTest(output=output):
                with self.assertRaises(BACKENDS.BackendFailure) as context:
                    BACKENDS._parse_sensevoice_stdout(output)
                self.assertEqual(context.exception.code, "asr_no_speech")

    def test_cosyvoice_supports_opaque_preset_and_reference_and_writes_one_wav(self):
        with tempfile.TemporaryDirectory(prefix="cti-sidecar-tts-") as root:
            root_path = Path(root)
            model_dir = root_path / "model"
            model_dir.mkdir()
            (model_dir / "cosyvoice.yaml").write_text("model", encoding="utf-8")
            reference = root_path / "reference.wav"
            write_wav(reference, 3.0)
            model = FakeModel()
            loader = lambda _path: (model, FakeTorch, FakeAudio)
            backend = BACKENDS.CosyVoiceBackend(str(model_dir), str(model_dir), "ready", "", loader=loader)
            FakeAudio.calls.clear()

            preset_output = root_path / "preset.wav"
            backend.synthesize("第一句。Second sentence!第三句？", str(preset_output), preset_speaker_id="cosyvoice.sft.zh_female")
            self.assertTrue(preset_output.is_file())
            self.assertEqual(
                model.calls[:3],
                [
                    ("sft", "第一句。", "中文女", False),
                    ("sft", "Second sentence!", "中文女", False),
                    ("sft", "第三句？", "中文女", False),
                ],
            )
            self.assertEqual(len(FakeAudio.calls), 1)
            self.assertEqual(FakeAudio.calls[0][1], ["a", "b", "a", "b", "a", "b"])

            reference_output = root_path / "reference-output.wav"
            backend.synthesize("继续。再来！", str(reference_output), reference_path=str(reference), reference_transcript="参考文本")
            self.assertTrue(reference_output.is_file())
            self.assertEqual(
                model.calls[3:],
                [
                    ("reference", "继续。", "参考文本", str(reference.resolve()), False),
                    ("reference", "再来！", "参考文本", str(reference.resolve()), False),
                ],
            )
            self.assertEqual(len(FakeAudio.calls), 2)

    def test_tts_splitter_filters_empty_blocks_and_caps_long_segments(self):
        segments = BACKENDS._split_tts_text("  第一段。\n\nSecond sentence!  " + ("长" * 301))
        self.assertEqual(segments[:2], ["第一段。", "Second sentence!"])
        self.assertTrue(all(0 < len(segment) <= BACKENDS.MAX_TTS_SEGMENT_CHARS for segment in segments))
        self.assertEqual("".join(segments[2:]), "长" * 301)

    def test_cosyvoice_removes_partial_output_after_failure(self):
        class FailingAudio:
            @staticmethod
            def save(target, _combined, _sample_rate):
                Path(target).write_bytes(b"partial")
                raise RuntimeError("boom")

        with tempfile.TemporaryDirectory(prefix="cti-sidecar-cleanup-") as root:
            root_path = Path(root)
            model_dir = root_path / "model"
            model_dir.mkdir()
            (model_dir / "cosyvoice.yaml").write_text("model", encoding="utf-8")
            model = FakeModel()
            backend = BACKENDS.CosyVoiceBackend(
                str(model_dir), None, "ready", "", loader=lambda _path: (model, FakeTorch, FailingAudio)
            )
            output = root_path / "failed.wav"
            with self.assertRaises(BACKENDS.BackendFailure):
                backend.synthesize("失败清理", str(output), preset_speaker_id="cosyvoice.sft.zh_female")
            self.assertFalse(output.exists())
            self.assertEqual(list(root_path.glob("*.tmp.wav")), [])


if __name__ == "__main__":
    unittest.main()
