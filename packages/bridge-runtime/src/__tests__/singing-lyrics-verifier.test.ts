import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import { FireRedAsr2WslLyricsVerifier } from '../speech/singing-lyrics-verifier.js';

describe('FireRed WSL 演唱歌词验收器', () => {
  it('仅将受管路径转换后交给无 shell 的 WSL 命令，并验证结构化转写回执', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-firered-verifier-'));
    const audioPath = path.join(root, 'candidate.wav');
    const modelPath = path.join(root, 'model');
    const scriptPath = path.join(root, 'firered_lyrics_verifier.py');
    fs.mkdirSync(modelPath);
    fs.writeFileSync(audioPath, 'wav', 'utf8');
    fs.writeFileSync(scriptPath, '# script', 'utf8');
    const calls: string[][] = [];
    const config = loadSpeechRuntimeConfig(new Map([
      ['CTI_SINGING_LYRICS_VERIFIER', 'fireredasr2_aed_wsl'],
      ['CTI_SINGING_LYRICS_VERIFIER_WSL_DISTRO', 'UbuntuFireRed'],
      ['CTI_SINGING_LYRICS_VERIFIER_MODEL_PATH', modelPath],
    ]));
    const verifier = new FireRedAsr2WslLyricsVerifier({
      config,
      scriptCandidates: [scriptPath],
      runner: async (executable, argv) => {
        assert.equal(executable, 'wsl.exe');
        calls.push([...argv]);
        if (argv.includes('wslpath')) return { code: 0, stdout: `/mnt/f/${calls.length}\n`, stderr: '' };
        return {
          code: 0,
          stdout: JSON.stringify({
            text: '这是合格的中文唱词', language: 'zh', model: 'fireredasr2-aed', provider: 'fireredasr2_aed_wsl',
          }),
          stderr: '',
        };
      },
    });
    try {
      const result = await verifier.transcribe({ candidatePath: audioPath });
      assert.deepEqual(result, {
        text: '这是合格的中文唱词', language: 'zh', model: 'fireredasr2-aed', provider: 'fireredasr2_aed_wsl',
      });
      assert.equal(calls.filter((call) => call.includes('wslpath')).length, 3);
      assert.deepEqual(calls.at(-1), [
        '--distribution', 'UbuntuFireRed', '--exec', 'python3', '/mnt/f/3',
        '--audio-path', '/mnt/f/1', '--model-path', '/mnt/f/2',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('拒绝 WSL 返回的非可信 Provider 或空歌词，避免把错误模型输出当验收事实', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-firered-verifier-invalid-'));
    const audioPath = path.join(root, 'candidate.wav');
    const modelPath = path.join(root, 'model');
    const scriptPath = path.join(root, 'firered_lyrics_verifier.py');
    fs.mkdirSync(modelPath);
    fs.writeFileSync(audioPath, 'wav', 'utf8');
    fs.writeFileSync(scriptPath, '# script', 'utf8');
    const config = loadSpeechRuntimeConfig(new Map([
      ['CTI_SINGING_LYRICS_VERIFIER', 'fireredasr2_aed_wsl'],
      ['CTI_SINGING_LYRICS_VERIFIER_MODEL_PATH', modelPath],
    ]));
    const verifier = new FireRedAsr2WslLyricsVerifier({
      config,
      scriptCandidates: [scriptPath],
      runner: async (_executable, argv) => argv.includes('wslpath')
        ? { code: 0, stdout: '/mnt/f/input\n', stderr: '' }
        : { code: 0, stdout: '{"text":"","language":"zh","model":"fireredasr2-aed","provider":"other"}', stderr: '' },
    });
    try {
      await assert.rejects(
        verifier.transcribe({ candidatePath: audioPath }),
        /singing_lyrics_verifier_response_invalid/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
