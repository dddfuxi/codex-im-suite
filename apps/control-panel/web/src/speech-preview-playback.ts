export type SpeechPreviewAudioTarget = {
  muted: boolean;
  volume: number;
  load: () => void;
  play: () => Promise<void>;
};

/**
 * Runtime 试听通常要等待模型推理，浏览器的短暂点击手势会在音频到达前失效。
 * 宿主允许本机试听自动播放后，这里仍显式解除静音并捕获播放失败，供 UI 回退到手动按钮。
 */
export async function startSpeechPreviewPlayback(target: SpeechPreviewAudioTarget): Promise<boolean> {
  try {
    target.muted = false;
    target.volume = 1;
    target.load();
    await target.play();
    return true;
  } catch {
    return false;
  }
}
