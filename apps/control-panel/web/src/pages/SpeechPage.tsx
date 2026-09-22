import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Mic,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Save,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';

import type {
  SpeechPanelStateContract,
  SpeechPreviewReceiptContract,
  SpeechSelectionContract,
  SpeechSettingsContract,
  SpeechStatusContract,
  SpeechVoiceAcceptanceContract,
  SpeechVoiceProfileContract,
} from '@codex-im-suite/contracts/speech';
import {
  canImportSpeechReferenceVoice,
  canInstallSpeechComponent,
  canSaveSpeechSettings,
  createSpeechSettingsDraft,
  decodeSpeechPreviewReceipt,
  describeReferenceVoiceMissing,
  describeSpeechDiagnostic,
  describeSpeechDisplayState,
  getSpeechAction,
  getSpeechCommandNotice,
  getSpeechFeatureSummaries,
  getSpeechPanelDiagnostic,
  updateSpeechChannelIds,
  type SpeechReferenceVoiceDraft,
} from '../speech-view-model.js';
import { startSpeechPreviewPlayback } from '../speech-preview-playback.js';

type SpeechPageProps = {
  state: SpeechPanelStateContract;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
  pending: Record<string, boolean>;
};

const emptyReferenceVoice: SpeechReferenceVoiceDraft = {
  displayName: '',
  transcript: '',
  transcriptConfirmed: false,
  sourceLabel: '',
  license: '',
  authorizationConfirmed: false,
  cleanSingleSpeakerConfirmed: false,
};

const providerCapabilityLabels: Record<string, string> = {
  'speech.text': '文本转语音',
  'speech.emotion': '语气与情感',
  'speech.prosody_reference': '参考韵律',
  'singing.text_to_singing': '按歌词演唱',
  'singing.melody': '外部旋律',
  'singing.voice_conversion': '歌声音色转换',
  'voice.zero_shot_clone': '零样本音色复刻',
  'voice.cross_mode_identity': '说话/歌声同音色',
};

function acceptanceLabel(acceptance: SpeechVoiceAcceptanceContract): string {
  if (acceptance.state === 'passed') return '已通过';
  if (acceptance.state === 'failed') return '未通过';
  if (acceptance.state === 'not_verified') return '未验收';
  return '不适用';
}

export function acceptanceMetric(acceptance: SpeechVoiceAcceptanceContract): string {
  const facts: string[] = [];
  // Runtime JSON 允许用 null 表示“尚未验收”；React 边界不能把 null 当成 number。
  if (typeof acceptance.similarity === 'number' && Number.isFinite(acceptance.similarity)
    && typeof acceptance.similarityThreshold === 'number' && Number.isFinite(acceptance.similarityThreshold)) {
    facts.push(`相似度 ${acceptance.similarity.toFixed(3)} / 阈值 ${acceptance.similarityThreshold.toFixed(3)}`);
  }
  if (typeof acceptance.lyricsAlignment === 'number' && Number.isFinite(acceptance.lyricsAlignment)
    && typeof acceptance.lyricsAlignmentThreshold === 'number' && Number.isFinite(acceptance.lyricsAlignmentThreshold)) {
    facts.push(`歌词 ${acceptance.lyricsAlignment.toFixed(3)} / 阈值 ${acceptance.lyricsAlignmentThreshold.toFixed(3)}`);
  }
  return facts.join(' · ');
}

/** Runtime 状态在冷启动、旧 live bundle 或接口异常时可能暂时不完整；
 * 页面必须降级为可见错误，而不是让一个坏字段把整个 WebView 渲染树打白。 */
function normalizeSpeechStatus(status: SpeechStatusContract): SpeechStatusContract {
  const fallbackSelection = (selection: SpeechSelectionContract | undefined): SpeechSelectionContract => ({
    value: selection?.value || '',
    options: Array.isArray(selection?.options) ? selection.options : [],
  });
  return {
    ...status,
    channels: Array.isArray(status.channels) ? status.channels : [],
    providers: Array.isArray(status.providers) ? status.providers : [],
    components: Array.isArray(status.components) ? status.components : [],
    voiceProfiles: Array.isArray(status.voiceProfiles) ? status.voiceProfiles : [],
    capabilities: Array.isArray(status.capabilities) ? status.capabilities : [],
    ttsModel: {
      ...status.ttsModel,
      value: status.ttsModel?.value || '',
      options: Array.isArray(status.ttsModel?.options) ? status.ttsModel.options : [],
    },
    ttsProvider: fallbackSelection(status.ttsProvider),
    asrProvider: fallbackSelection(status.asrProvider),
    singingProvider: fallbackSelection(status.singingProvider),
    limits: {
      ...status.limits,
      maxSongLyricsCharacters: Number.isFinite(status.limits?.maxSongLyricsCharacters)
        ? status.limits.maxSongLyricsCharacters : 20_000,
      maxSongDurationSeconds: Number.isFinite(status.limits?.maxSongDurationSeconds)
        ? status.limits.maxSongDurationSeconds : 600,
    },
  };
}

function SelectionField({
  label,
  selection,
  value,
  disabled,
  onChange,
}: {
  label: string;
  selection: SpeechSelectionContract;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="speech-field">
      <span>{label}</span>
      <select value={value} disabled={disabled || selection.options.length === 0} onChange={(event) => onChange(event.target.value)}>
        {selection.options.length === 0 && <option value="">Runtime 未提供选项</option>}
        {selection.options.map((option) => (
          <option key={option.id} value={option.id} disabled={!option.enabled}>
            {option.displayName} · {option.state}
          </option>
        ))}
      </select>
    </label>
  );
}

function VoiceProfileActions({
  profile,
  status,
  previewText,
  runAction,
  previewVoice,
  showDiagnostic,
  pending,
}: {
  profile: SpeechVoiceProfileContract;
  status: SpeechStatusContract;
  previewText: string;
  runAction: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  previewVoice: (profile: SpeechVoiceProfileContract) => Promise<void>;
  showDiagnostic: (message: string) => void;
  pending: Record<string, boolean>;
}) {
  const install = getSpeechAction(status, 'speech.installPresetVoice');
  const installComponent = getSpeechAction(status, 'speech.installComponent');
  const preview = getSpeechAction(status, 'speech.previewVoice');
  const activate = getSpeechAction(status, 'speech.activateVoiceProfile');
  const rename = getSpeechAction(status, 'speech.renameReferenceVoice');
  const remove = getSpeechAction(status, 'speech.deleteReferenceVoice');
  const benchmark = getSpeechAction(status, 'speech.benchmarkTtsModel');
  const compatibleModel = status.ttsModel.options.find((model) => model.id === status.ttsModel.value
    && profile.compatibleTtsModelIds.includes(model.id))
    || status.ttsModel.options.find((model) => profile.compatibleTtsModelIds.includes(model.id));
  const modelComponent = compatibleModel
    ? status.components.find((component) => component.id === compatibleModel.componentId)
    : undefined;
  const canInstallModel = Boolean(modelComponent && canInstallSpeechComponent(modelComponent, installComponent));
  const previewBlocker = !previewText.trim()
    ? '请先填写试听文本。'
    : profile.state !== 'ready'
      ? describeSpeechDiagnostic(profile.diagnosticCode || compatibleModel?.diagnosticCode || preview.diagnosticCode)
      : !preview.enabled
        ? describeSpeechDiagnostic(preview.diagnosticCode)
        : '';
  return (
    <div className="speech-card-actions">
      {profile.kind === 'preset' && profile.state !== 'ready' && canInstallModel && modelComponent && (
        <button className="mini-button" disabled={pending[installComponent.id]} onClick={() => void runAction(installComponent.id, { componentId: modelComponent.id })}>
          <Download size={14} />安装配套模型
        </button>
      )}
      {profile.kind === 'preset' && profile.state !== 'ready' && !canInstallModel && (
        <button className="mini-button" disabled={pending[install.id]} onClick={() => showDiagnostic(describeSpeechDiagnostic(profile.diagnosticCode || install.diagnosticCode))}>
          <AlertTriangle size={14} />查看缺失项
        </button>
      )}
      {profile.kind === 'reference' && profile.state !== 'ready' && (
        <button className="mini-button" disabled={pending[benchmark.id]} onClick={() => {
          const currentModelCompatible = profile.compatibleTtsModelIds.includes(status.ttsModel.value);
          const blocker = !currentModelCompatible
            ? `请先选择并重启兼容的复刻模型（优先 ${compatibleModel?.displayName || '高质量 Base 模型'}）。`
            : !benchmark.enabled ? describeSpeechDiagnostic(benchmark.diagnosticCode) : '';
          if (blocker) showDiagnostic(blocker);
          else void runAction(benchmark.id, { modelId: status.ttsModel.value, voiceProfileId: profile.id });
        }}>
          <CheckCircle2 size={14} />相似度验收
        </button>
      )}
      <button className="mini-button" disabled={pending[preview.id]} title={previewBlocker} onClick={() => previewBlocker ? showDiagnostic(previewBlocker) : void previewVoice(profile)}>
        <Play size={14} />试听
      </button>
      <button className="mini-button" disabled={profile.active || pending[activate.id]} title={profile.active ? '当前已启用' : ''} onClick={() => {
        const blocker = profile.state !== 'ready'
          ? describeSpeechDiagnostic(profile.diagnosticCode)
          : !activate.enabled ? describeSpeechDiagnostic(activate.diagnosticCode) : '';
        if (blocker) showDiagnostic(blocker);
        else void runAction(activate.id, { voiceProfileId: profile.id });
      }}>
        <CheckCircle2 size={14} />{profile.active ? '当前音色' : '切换音色'}
      </button>
      {profile.kind === 'reference' && (
        <button className="mini-button" disabled={pending[rename.id]} onClick={() => {
          if (!rename.enabled) {
            showDiagnostic(describeSpeechDiagnostic(rename.diagnosticCode));
            return;
          }
          const nextName = window.prompt('输入新的克隆音色名称（最多 100 个字符）', profile.displayName)?.trim();
          if (nextName === undefined) return;
          if (!nextName || nextName.length > 100) {
            showDiagnostic('音色名称必须为 1–100 个非空字符。');
            return;
          }
          if (nextName === profile.displayName) return;
          void runAction(rename.id, { voiceProfileId: profile.id, displayName: nextName });
        }}>
          <Pencil size={14} />重命名
        </button>
      )}
      {profile.kind === 'reference' && (
        <button className="mini-button" disabled={pending[remove.id]} onClick={() => {
          if (!remove.enabled) {
            showDiagnostic(describeSpeechDiagnostic(remove.diagnosticCode));
            return;
          }
          const impact = profile.active
            ? '该音色当前已启用；说话音色会优先回退到兼容默认预设，无兼容预设时清空，歌声音色会清空。'
            : '删除后会清理受管参考音频和相似度验收记录。';
          if (window.confirm(`确定删除参考音色“${profile.displayName}”吗？\n${impact}\n此操作不可撤销。`)) {
            void runAction(remove.id, { voiceProfileId: profile.id });
          }
        }}>
          <Trash2 size={14} />删除音色
        </button>
      )}
    </div>
  );
}

export function SpeechPage({ state, run, refresh, pending }: SpeechPageProps) {
  const status = state.status ? normalizeSpeechStatus(state.status) : null;
  const safeState = status ? { ...state, status } : state;
  const displayState = describeSpeechDisplayState(safeState);
  const [draft, setDraft] = useState<SpeechSettingsContract | null>(() => status ? createSpeechSettingsDraft(status) : null);
  const [previewText, setPreviewText] = useState('你好，这是一段语音试听。');
  const [singingLyrics, setSingingLyrics] = useState('[Verse]\n你好，今天一起向前走。');
  const [singingStylePrompt, setSingingStylePrompt] = useState('清晰自然的中文流行演唱，准确表达歌词，保持稳定节奏与干净人声');
  const [singingVocalLanguage, setSingingVocalLanguage] = useState('zh');
  const [singingDurationSeconds, setSingingDurationSeconds] = useState('');
  const [singingMelodyMode, setSingingMelodyMode] = useState('auto');
  const [referenceVoice, setReferenceVoice] = useState<SpeechReferenceVoiceDraft>(emptyReferenceVoice);
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [previewPlayback, setPreviewPlayback] = useState<{
    url: string;
    profileName: string;
    receipt: SpeechPreviewReceiptContract;
    mode: 'speech_preview' | 'singing_preview' | 'singing_generation';
  } | null>(null);
  const previewPlayerRef = useRef<HTMLDivElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    setDraft(status ? createSpeechSettingsDraft(status) : null);
  }, [status?.lastCheckedAt]);

  useEffect(() => () => {
    if (previewPlayback?.url) URL.revokeObjectURL(previewPlayback.url);
  }, [previewPlayback?.url]);

  useEffect(() => {
    if (!previewPlayback || !previewAudioRef.current) return undefined;
    const playback = previewPlayback;
    const audio = previewAudioRef.current;
    let active = true;
    previewPlayerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    void startSpeechPreviewPlayback(audio).then((started) => {
      if (!active) return;
      setLocalNotice(started
        ? `正在播放「${playback.profileName}」试听。`
        : `已生成「${playback.profileName}」试听；自动播放受系统限制，请点击下方播放器的播放键。`);
    });
    return () => {
      active = false;
      audio.pause();
    };
  }, [previewPlayback]);

  const runAction = async (
    command: string,
    payload: Record<string, unknown> = {},
    refreshAfter = true,
  ): Promise<unknown> => {
    setLocalError('');
    setLocalNotice('');
    try {
      const result = await run(command, payload);
      setLocalNotice(getSpeechCommandNotice(result));
      if (refreshAfter) await refresh();
      return result;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const showDiagnostic = (message: string) => {
    setLocalNotice('');
    setLocalError(message);
  };

  const previewVoice = async (profile: SpeechVoiceProfileContract) => {
    const result = await runAction('speech.previewVoice', {
      modelId: status?.ttsModel.value || '',
      voiceProfileId: profile.id,
      text: previewText.trim(),
    }, false);
    if (!result) return;
    try {
      const { receipt, media } = decodeSpeechPreviewReceipt(result);
      if (receipt.voiceProfileId !== profile.id || receipt.modelId !== status?.ttsModel.value) throw new Error('speech_preview_profile_mismatch');
      const audioBytes = new ArrayBuffer(media.byteLength);
      new Uint8Array(audioBytes).set(media);
      const url = URL.createObjectURL(new Blob([audioBytes], { type: receipt.mediaType }));
      setPreviewPlayback({ url, profileName: profile.displayName, receipt, mode: 'speech_preview' });
      setLocalNotice(`已生成「${profile.displayName}」试听，可在下方播放。`);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'speech_preview_response_invalid');
    }
  };

  const runSinging = async (command: 'speech.previewSingingVoice' | 'speech.generateSinging') => {
    if (!draft) return;
    const voiceProfileId = draft.activeSingingVoiceProfileId;
    const durationSeconds = singingDurationSeconds.trim() ? Number(singingDurationSeconds) : undefined;
    const action = getSpeechAction(status!, command);
    const activeVoiceProfileId = status!.activeSingingVoiceProfileId;
    const referenceProfile = !voiceProfileId
      ? undefined
      : status!.voiceProfiles.find((profile) => profile.id === voiceProfileId);
    const blocker = !singingLyrics.trim()
      ? '请先填写要演唱的歌词。'
      : Array.from(singingLyrics.trim()).length > status!.limits.maxSongLyricsCharacters
        ? `歌词超过 ${status!.limits.maxSongLyricsCharacters} 字上限。`
        : !singingStylePrompt.trim()
          ? '请先填写演唱风格。'
          : !/^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,2}$/u.test(singingVocalLanguage.trim().toLowerCase())
            ? '演唱语言必须使用 BCP 47 形式，例如 zh 或 zh-CN。'
            : durationSeconds !== undefined && (!Number.isFinite(durationSeconds)
              || durationSeconds < 10 || durationSeconds > status!.limits.maxSongDurationSeconds)
              ? `自定义时长必须在 10–${status!.limits.maxSongDurationSeconds} 秒之间。`
              : singingMelodyMode !== 'auto'
                ? '当前 Provider 尚未接入外部旋律文件协议，请先使用自动旋律。'
                : draft.singingProvider !== status!.singingProvider.value
                  ? '歌声 Provider 选择尚未保存并由 Runtime 加载。'
                  : voiceProfileId !== activeVoiceProfileId
                    ? '所选歌声音色尚未保存并由 Runtime 激活。'
                    : referenceProfile && referenceProfile.singingAcceptance.state !== 'passed'
                      ? '该克隆音色尚未通过歌声相似度与歌词对齐验收，请先运行“歌声性能测试”。'
                      : !action.enabled ? describeSpeechDiagnostic(action.diagnosticCode) : '';
    if (blocker) {
      showDiagnostic(blocker);
      return;
    }
    const result = await runAction(command, {
      providerId: draft.singingProvider,
      voiceProfileId,
      lyrics: singingLyrics.trim(),
      stylePrompt: singingStylePrompt.trim(),
      vocalLanguage: singingVocalLanguage.trim().toLowerCase(),
      durationSeconds,
      melodyMode: singingMelodyMode,
    }, false);
    if (!result) return;
    try {
      const { receipt, media } = decodeSpeechPreviewReceipt(result, { requireLyricsAcceptance: true });
      if (voiceProfileId && receipt.voiceProfileId !== voiceProfileId) throw new Error('singing_preview_profile_mismatch');
      const audioBytes = new ArrayBuffer(media.byteLength);
      new Uint8Array(audioBytes).set(media);
      const url = URL.createObjectURL(new Blob([audioBytes], { type: receipt.mediaType }));
      const profileName = !voiceProfileId
        ? `${status?.providers.find((provider) => provider.id === draft.singingProvider)?.displayName || '当前 Provider'} 默认歌声音色`
        : status?.voiceProfiles.find((profile) => profile.id === voiceProfileId)?.displayName || voiceProfileId;
      const mode = command === 'speech.generateSinging' ? 'singing_generation' : 'singing_preview';
      setPreviewPlayback({ url, profileName, receipt, mode });
      setLocalNotice(command === 'speech.generateSinging'
        ? `已按完整歌词生成「${profileName}」歌声；面板未将该音频发送到飞书。`
        : `已生成「${profileName}」10 秒歌声试听；面板未将该音频发送到飞书。`);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'singing_preview_response_invalid');
    }
  };

  const importReady = useMemo(() => canImportSpeechReferenceVoice(referenceVoice), [referenceVoice]);

  if (!state.available || !status || !draft) {
    return (
      <section className="panel speech-unavailable">
        <AlertTriangle size={26} />
        <div>
          <div className="speech-title-row"><h2>语音 Runtime 接口不可用</h2><span className={`status-pill ${displayState.tone}`}>{displayState.label}</span></div>
          <p>面板不会在缺少受控 Runtime 接口时伪造组件、音色或配置状态。</p>
          <code>{getSpeechPanelDiagnostic(state)}</code>
        </div>
        <button className="command-button" disabled={pending['speech.refresh']} onClick={() => void runAction('speech.refresh')}>
          <RefreshCw size={15} className={pending['speech.refresh'] ? 'spin' : ''} />重新检查接口
        </button>
      </section>
    );
  }

  const installComponent = getSpeechAction(status, 'speech.installComponent');
  const importReference = getSpeechAction(status, 'speech.importReferenceVoice');
  const selectedChannels = status.channels.filter((channel) => draft.channelIds.includes(channel.id));
  const selectedChannelsSupportInput = selectedChannels.length === 0 || selectedChannels.some((channel) => channel.inputSupported);
  const selectedChannelsSupportOutput = selectedChannels.length === 0 || selectedChannels.some((channel) => channel.outputSupported);
  const selectedTtsModel = status.ttsModel.options.find((model) => model.id === draft.ttsModelId);
  const selectedModelComponent = selectedTtsModel
    ? status.components.find((component) => component.id === selectedTtsModel.componentId)
    : undefined;
  const compatibleSpeechProfiles = status.voiceProfiles.filter((profile) =>
    profile.capabilities.includes('speech') && profile.compatibleTtsModelIds.includes(draft.ttsModelId));
  const benchmarkModel = getSpeechAction(status, 'speech.benchmarkTtsModel');
  const benchmarkSingingModel = getSpeechAction(status, 'speech.benchmarkSingingModel');
  const settingsValid = canSaveSpeechSettings(status, draft);
  const canInstallSelectedModel = Boolean(selectedModelComponent
    && canInstallSpeechComponent(selectedModelComponent, installComponent));
  const readyComponentCount = status.components.filter((component) => component.state === 'ready').length;
  const featureSummaries = getSpeechFeatureSummaries(status);
  const selectedSpeechProfile = compatibleSpeechProfiles.find((profile) => profile.id === draft.activeVoiceProfileId)
    ?? compatibleSpeechProfiles.find((profile) => profile.state === 'ready');
  const selectTtsModel = (modelId: string) => {
    const model = status.ttsModel.options.find((item) => item.id === modelId);
    const currentVoiceCompatible = compatibleSpeechProfiles.some((profile) =>
      profile.id === draft.activeVoiceProfileId && profile.compatibleTtsModelIds.includes(modelId));
    setDraft({
      ...draft,
      ttsModelId: modelId,
      ttsProvider: model?.providerId || draft.ttsProvider,
      activeVoiceProfileId: currentVoiceCompatible ? draft.activeVoiceProfileId : model?.defaultVoiceProfileId || '',
      tonePolicy: model?.capabilities.includes('instruction_control') ? draft.tonePolicy : 'neutral_stable',
    });
  };
  const activeProvider = status.providers.find((provider) => provider.id === draft.singingProvider);

  return (
    <section className="content-stack speech-page">
      <section className="panel speech-overview">
        <div className="section-header">
          <div>
            <div className="speech-title-row"><h2>语音</h2><span className={`status-pill ${displayState.tone}`}>{displayState.label}</span></div>
            <p className="panel-intro">所有状态、选项和动作来自 Runtime；克隆音色由 Runtime 长期保存并显示在面板音色库，面板不直接持有参考音频路径。</p>
          </div>
          <button className="command-button" disabled={pending['speech.refresh']} onClick={() => void runAction('speech.refresh')}>
            <RefreshCw size={15} className={pending['speech.refresh'] ? 'spin' : ''} />检查组件
          </button>
        </div>
        {(localError || status.diagnosticCode) && <div className="speech-diagnostic"><AlertTriangle size={15} /><code>{localError || status.diagnosticCode}</code></div>}
        {localNotice && <div className="speech-diagnostic"><RefreshCw size={15} /><span>{localNotice}</span></div>}
        <div className="speech-feature-grid">
          {featureSummaries.map((feature) => {
            const stateMeta = !feature.enabled
              ? { label: '已关闭', tone: 'idle' }
              : feature.state === 'ready'
                ? { label: '可用', tone: 'ok' }
                : feature.state === 'optional_missing'
                  ? { label: '待安装', tone: 'warning' }
                  : { label: '需处理', tone: 'error' };
            const FeatureIcon = feature.id === 'input'
              ? Mic
              : feature.id === 'output'
                ? Volume2
                : feature.id === 'voice_clone'
                  ? Upload
                  : feature.id === 'channel'
                    ? CheckCircle2
                    : Play;
            return (
              <article className="speech-feature-card" key={feature.id}>
                <FeatureIcon size={19} />
                <div><strong>{feature.title}</strong><small>{feature.detail}</small></div>
                <span className={`status-pill ${stateMeta.tone}`}>{stateMeta.label}</span>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="section-header"><div><h2>常用设置</h2><p className="panel-intro">日常只需要开关功能、选择模型和音色，然后试听并保存。</p></div></div>
        <div className="speech-toggle-grid">
          <label className="speech-toggle"><Mic size={18} /><span><strong>语音输入</strong><small>允许渠道音频进入 ASR。</small></span><input type="checkbox" checked={draft.inputEnabled} onChange={(event) => setDraft({ ...draft, inputEnabled: event.target.checked })} /></label>
          <label className="speech-toggle"><Volume2 size={18} /><span><strong>语音输出</strong><small>允许受控 TTS 生成语音回复。</small></span><input type="checkbox" checked={draft.outputEnabled} onChange={(event) => setDraft({ ...draft, outputEnabled: event.target.checked })} /></label>
          <label className="speech-toggle"><Volume2 size={18} /><span><strong>歌声合成</strong><small>只使用独立 SingingHost，不以 TTS 冒充唱歌。</small></span><input type="checkbox" checked={draft.singingEnabled} onChange={(event) => setDraft({ ...draft, singingEnabled: event.target.checked })} /></label>
        </div>
        <div className="speech-quick-grid">
          <article className="speech-quick-card">
            <div className="speech-quick-title"><Mic size={18} /><div><strong>收到语音</strong><small>识别后交给 Agent，并按会话策略回复。</small></div></div>
            <SelectionField label="回复方式" selection={status.replyPolicy} value={draft.replyPolicy} onChange={(value) => setDraft({ ...draft, replyPolicy: value })} />
          </article>
          <article className="speech-quick-card">
            <div className="speech-quick-title"><Volume2 size={18} /><div><strong>说话与试听</strong><small>选择模型、语气和音色。</small></div></div>
            <label className="speech-field"><span>语音模型</span><select value={draft.ttsModelId} disabled={!draft.outputEnabled} onChange={(event) => selectTtsModel(event.target.value)}>{status.ttsModel.options.map((model) => <option key={model.id} value={model.id} disabled={!model.enabled}>{model.displayName} · {model.qualityTier === 'high_quality' ? '高质量优先' : model.qualityTier === 'low_resource' ? '低显存备选' : '均衡'} · {model.state}</option>)}</select></label>
            <label className="speech-field"><span>说话音色</span><select value={draft.activeVoiceProfileId} disabled={!draft.outputEnabled} onChange={(event) => setDraft({ ...draft, activeVoiceProfileId: event.target.value })}><option value="">当前模型默认音色</option>{compatibleSpeechProfiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.state !== 'ready'}>{profile.displayName} · {profile.state}</option>)}</select></label>
            <SelectionField label="语气" selection={status.tonePolicy} value={draft.tonePolicy} disabled={!draft.outputEnabled} onChange={(value) => setDraft({ ...draft, tonePolicy: value })} />
            <label className="speech-field"><span>试听文本</span><input value={previewText} maxLength={status.limits.maxPreviewCharacters} onChange={(event) => setPreviewText(event.target.value)} /></label>
            <button className="mini-button speech-preview-button" disabled={!selectedSpeechProfile || pending['speech.previewVoice']} onClick={() => {
              const action = getSpeechAction(status, 'speech.previewVoice');
              const blocker = !previewText.trim()
                ? '请先填写试听文本。'
                : !selectedSpeechProfile
                  ? '当前模型没有可试听的音色。'
                  : selectedSpeechProfile.state !== 'ready'
                    ? describeSpeechDiagnostic(selectedSpeechProfile.diagnosticCode)
                    : !action.enabled ? describeSpeechDiagnostic(action.diagnosticCode) : '';
              if (blocker) showDiagnostic(blocker);
              else void previewVoice(selectedSpeechProfile!);
            }}><Play size={14} />试听当前音色</button>
          </article>
          <article className="speech-quick-card">
            <div className="speech-quick-title"><Play size={18} /><div><strong>唱歌与试听</strong><small>快速试听截取 10 秒；完整生成保留全部歌词，不使用普通 TTS。</small></div></div>
            <label className="speech-field"><span>歌声音色</span><select value={draft.activeSingingVoiceProfileId} disabled={!draft.singingEnabled} onChange={(event) => setDraft({ ...draft, activeSingingVoiceProfileId: event.target.value })}><option value="">{activeProvider?.displayName || '当前 Provider'} 默认歌声音色</option>{status.voiceProfiles.filter((profile) => profile.capabilities.includes('singing')).map((profile) => <option key={profile.id} value={profile.id} disabled={profile.state !== 'ready'}>{profile.displayName} · {profile.state}</option>)}</select></label>
            <label className="speech-field speech-singing-lyrics"><span>完整歌词（最多 {status.limits.maxSongLyricsCharacters} 字）</span><textarea value={singingLyrics} maxLength={status.limits.maxSongLyricsCharacters} onChange={(event) => setSingingLyrics(event.target.value)} /></label>
            <label className="speech-field"><span>演唱风格</span><input value={singingStylePrompt} maxLength={500} onChange={(event) => setSingingStylePrompt(event.target.value)} /></label>
            <div className="speech-singing-options">
              <label className="speech-field"><span>演唱语言</span><input value={singingVocalLanguage} maxLength={16} placeholder="zh" onChange={(event) => setSingingVocalLanguage(event.target.value)} /></label>
              <label className="speech-field"><span>完整生成时长（可留空自动估算）</span><input type="number" min={10} max={status.limits.maxSongDurationSeconds} value={singingDurationSeconds} placeholder={`10–${status.limits.maxSongDurationSeconds}`} onChange={(event) => setSingingDurationSeconds(event.target.value)} /></label>
              <label className="speech-field"><span>旋律来源</span><select value={singingMelodyMode} onChange={(event) => setSingingMelodyMode(event.target.value)}><option value="auto">自动旋律</option><option value="reference_audio" disabled>参考音频（Provider 尚未接入）</option><option value="midi_or_f0" disabled>MIDI / F0（Provider 尚未接入）</option></select></label>
            </div>
            {activeProvider && <small>当前 Provider：{activeProvider.displayName} · {activeProvider.license}{activeProvider.experimental ? ' · 实验能力' : ''}</small>}
            <div className="speech-singing-actions">
              <button className="mini-button speech-preview-button" disabled={pending['speech.previewSingingVoice']} onClick={() => void runSinging('speech.previewSingingVoice')}><Play size={14} />10 秒快速试听歌词</button>
              <button className="mini-button speech-preview-button" disabled={pending['speech.generateSinging']} onClick={() => void runSinging('speech.generateSinging')}><Volume2 size={14} />按完整内容生成</button>
            </div>
          </article>
        </div>
        {previewPlayback && (
          <div className="speech-preview-player" ref={previewPlayerRef}>
            <strong>{previewPlayback.profileName}</strong>
            <div className="speech-receipt-facts">
              <span>内容状态：已生成</span>
              <span>发送状态：面板生成，未发送</span>
              <span>音色相似度：{previewPlayback.receipt.speakerSimilarityStatus === 'passed' ? '已通过' : '不适用'}</span>
              {previewPlayback.receipt.lyricsAlignmentStatus === 'passed' && <span>歌词对齐：已通过</span>}
              <span>模式：{previewPlayback.mode === 'singing_generation' ? '完整内容生成' : previewPlayback.mode === 'singing_preview' ? '10 秒快速试听' : '说话试听'}</span>
            </div>
            <audio
              ref={previewAudioRef}
              controls
              preload="auto"
              src={previewPlayback.url}
              onError={() => setLocalError('试听音频已生成，但当前 WebView 无法解码播放。')}
            >当前 WebView 不支持音频播放。</audio>
          </div>
        )}
        <details className="speech-details speech-advanced-settings">
          <summary><span><strong>高级设置与性能诊断</strong><small>渠道、Provider、限制值、benchmark 和安装入口</small></span></summary>
          <div className="speech-details-content">
        <div className="speech-settings-grid">
          <fieldset className="speech-field speech-channel-field">
            <legend>渠道（可多选）</legend>
            {status.channels.length === 0
              ? <span className="empty-inline">Runtime 未提供渠道</span>
              : (
                <div className="speech-channel-list">
                  {status.channels.map((channel) => {
                    const checked = draft.channelIds.includes(channel.id);
                    return (
                      <label className="speech-channel-option" key={channel.id} title={channel.diagnosticCode || ''}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!channel.enabled && !checked}
                          onChange={(event) => setDraft({
                            ...draft,
                            channelIds: updateSpeechChannelIds(draft.channelIds, channel.id, event.target.checked),
                          })}
                        />
                        <span>
                          <strong>{channel.displayName}</strong>
                          <small>
                            {channel.state} · 输入{channel.inputSupported ? '支持' : '不支持'} · 输出{channel.outputSupported ? '支持' : '不支持'}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
          </fieldset>
          <SelectionField label="交付模式" selection={status.deliveryMode} value={draft.deliveryMode} onChange={(value) => setDraft({ ...draft, deliveryMode: value })} />
          <SelectionField label="ASR Provider" selection={status.asrProvider} value={draft.asrProvider} disabled={!draft.inputEnabled || !selectedChannelsSupportInput} onChange={(value) => setDraft({ ...draft, asrProvider: value })} />
          <SelectionField label="TTS Provider" selection={status.ttsProvider} value={draft.ttsProvider} disabled={!draft.outputEnabled || !selectedChannelsSupportOutput} onChange={(value) => {
            const model = status.ttsModel.options.find((item) => item.providerId === value && item.enabled);
            setDraft({
              ...draft,
              ttsProvider: value,
              ttsModelId: model?.id || '',
              activeVoiceProfileId: model?.defaultVoiceProfileId || '',
              tonePolicy: model?.capabilities.includes('instruction_control') ? draft.tonePolicy : 'neutral_stable',
            });
          }} />
          <SelectionField label="Singing Provider" selection={status.singingProvider} value={draft.singingProvider} disabled={!draft.singingEnabled || !selectedChannelsSupportOutput} onChange={(value) => setDraft({ ...draft, singingProvider: value })} />
        </div>
        <div className="speech-limit-row">
          <span>输入上限 {status.limits.maxInputBytes.toLocaleString()} bytes</span>
          <span>时长 {status.limits.maxInputDurationSeconds}s</span>
          <span>输出 {status.limits.maxOutputCharacters} 字</span>
          <span>歌词 {status.limits.maxSongLyricsCharacters} 字</span>
          <span>歌曲最长 {status.limits.maxSongDurationSeconds}s</span>
        </div>
        <div className="speech-card-grid speech-provider-grid">
          {status.providers.map((provider) => (
            <article className="speech-card" key={provider.id}>
              <div className="speech-card-head"><div><strong>{provider.displayName}</strong><small>{provider.license}{provider.experimental ? ' · 实验 PoC' : ' · 稳定目录'}</small></div><span className={`status-pill ${provider.state === 'ready' ? 'ok' : provider.state === 'optional_missing' ? 'warning' : 'error'}`}>{provider.state}</span></div>
              <div className="speech-capability-list">{provider.capabilities.map((capability) => <span className="token-chip" key={capability}>{providerCapabilityLabels[capability] || capability}</span>)}</div>
              {provider.diagnosticCode && <code>{describeSpeechDiagnostic(provider.diagnosticCode)}</code>}
            </article>
          ))}
        </div>
        {selectedTtsModel && <div className="speech-diagnostic">
          <Volume2 size={15} />
          <span>
            配置模型：{selectedTtsModel.displayName}；live：{status.ttsModel.liveValue || '未加载'}；
            benchmark：{selectedTtsModel.benchmark.state}
            {selectedTtsModel.benchmark.warmSynthesisMs !== undefined ? ` · 热态 ${Math.round(selectedTtsModel.benchmark.warmSynthesisMs)}ms` : ''}
          </span>
          {selectedModelComponent && selectedModelComponent.state !== 'ready' && canInstallSelectedModel && (
            <button className="mini-button" disabled={pending[installComponent.id]} onClick={() => void runAction(installComponent.id, { componentId: selectedModelComponent.id })}><Download size={14} />安装当前模型</button>
          )}
          <button className="mini-button" disabled={pending[benchmarkModel.id]} title={benchmarkModel.diagnosticCode || ''} onClick={() => {
            const blocker = draft.ttsModelId !== status.ttsModel.value
              ? '请先保存当前模型选择。'
              : !benchmarkModel.enabled ? describeSpeechDiagnostic(benchmarkModel.diagnosticCode) : '';
            if (blocker) showDiagnostic(blocker);
            else void runAction(benchmarkModel.id, { modelId: status.ttsModel.value });
          }}><Play size={14} />性能测试</button>
        </div>}
        <div className="speech-diagnostic">
          <Volume2 size={15} />
          <span>
            歌声 benchmark：{status.singingBenchmark.state}
            {status.singingBenchmark.warmSynthesisMs !== undefined ? ` · 10 秒测试耗时 ${Math.round(status.singingBenchmark.warmSynthesisMs)}ms` : ''}
            {status.singingBenchmark.peakVramMiB !== undefined ? ` · 峰值显存 ${Math.round(status.singingBenchmark.peakVramMiB)}MiB` : ''}
          </span>
          <button className="mini-button" disabled={pending[benchmarkSingingModel.id]} title={benchmarkSingingModel.diagnosticCode || ''} onClick={() => {
            const blocker = !draft.singingEnabled
              ? '请先开启并保存歌声合成。'
              : !benchmarkSingingModel.enabled ? describeSpeechDiagnostic(benchmarkSingingModel.diagnosticCode) : '';
            if (blocker) showDiagnostic(blocker);
            else void runAction(benchmarkSingingModel.id);
          }}><Play size={14} />歌声性能测试</button>
        </div>
          </div>
        </details>
        {status.ttsModel.restartRequired && <div className="speech-diagnostic"><AlertTriangle size={15} /><span>已保存模型尚未由 live Runtime 加载。</span><button className="mini-button" disabled={pending['bridge.restart']} onClick={() => void runAction('bridge.restart')}><RotateCw size={14} />重启 Bridge 并重载</button></div>}
        <div className="command-band dense speech-save-row"><button className="command-button" disabled={pending['speech.saveSettings']} onClick={() => settingsValid ? void runAction('speech.saveSettings', draft as unknown as Record<string, unknown>) : showDiagnostic('当前设置包含 Runtime 未声明或不兼容的选项，请检查渠道、Provider、模型与音色组合。')}><Save size={15} />保存语音设置</button>{!settingsValid && <span>当前选择未被 Runtime 声明或不兼容；点击保存可查看处理提示。</span>}</div>
      </section>

      <details className="panel speech-details">
        <summary><span><strong>组件与故障排查</strong><small>模型、Runtime、安装状态和诊断码</small></span><span>{readyComponentCount}/{status.components.length} ready</span></summary>
        <div className="speech-details-content">
        {status.components.length === 0 ? <div className="empty-inline">Runtime 未返回组件。</div> : <div className="speech-card-grid">{status.components.map((component) => (
          <article className="speech-card" key={component.id}>
            <div className="speech-card-head"><div><strong>{component.displayName}</strong><small>{component.kind}{component.version ? ` · ${component.version}` : ''}</small></div><span className={`status-pill ${describeSpeechDisplayState({ available: true, status: { ...status, state: component.state } }).tone}`}>{component.state}</span></div>
            <div className="speech-capability-list">{component.capabilities.length > 0 ? component.capabilities.map((capability) => <span className="token-chip" key={capability}>{capability}</span>) : <span>未声明能力</span>}</div>
            {component.diagnosticCode && <code>{component.diagnosticCode}</code>}
            {component.installable && component.state !== 'ready' && <button className="mini-button" disabled={!canInstallSpeechComponent(component, installComponent) || pending[installComponent.id]} title={installComponent.diagnosticCode || ''} onClick={() => void runAction(installComponent.id, { componentId: component.id })}><Download size={14} />安装组件</button>}
            {!component.installable && component.state !== 'ready' && <button className="mini-button" onClick={() => showDiagnostic(describeSpeechDiagnostic(component.diagnosticCode))}><AlertTriangle size={14} />查看处理方法</button>}
          </article>
        ))}</div>}
        </div>
      </details>

      <details className="panel speech-details">
        <summary><span><strong>音色库</strong><small>克隆音色长期保存在受管库，可随时确认删除</small></span><span>{status.voiceProfiles.length} 个</span></summary>
        <div className="speech-details-content">
        {status.voiceProfiles.length === 0 ? <div className="empty-inline">Runtime 未返回音色 Profile。</div> : <div className="speech-card-grid">{status.voiceProfiles.map((profile) => (
          <article className="speech-card" key={profile.id}>
            <div className="speech-card-head"><div><strong>{profile.displayName}</strong><small>{profile.kind === 'preset' ? '预设音色' : '授权参考音色'} · {profile.sourceLabel}</small></div><span className={`status-pill ${profile.state === 'ready' ? 'ok' : profile.state === 'optional_missing' ? 'warning' : 'error'}`}>{profile.state}</span></div>
            <div className="speech-profile-facts"><span>许可证：{profile.license || '未声明'}</span><span>授权：{profile.authorizationConfirmed ? '已确认' : '未确认'}</span><span>能力：{profile.capabilities.join(' / ')}</span><span>说话验收：{acceptanceLabel(profile.speechAcceptance)}{acceptanceMetric(profile.speechAcceptance) ? ` · ${acceptanceMetric(profile.speechAcceptance)}` : ''}</span><span>歌声验收：{acceptanceLabel(profile.singingAcceptance)}{acceptanceMetric(profile.singingAcceptance) ? ` · ${acceptanceMetric(profile.singingAcceptance)}` : ''}</span></div>
            {profile.diagnosticCode && <code>{profile.diagnosticCode}</code>}
            <VoiceProfileActions profile={profile} status={status} previewText={previewText} runAction={runAction} previewVoice={previewVoice} showDiagnostic={showDiagnostic} pending={pending} />
          </article>
        ))}</div>}
        </div>
      </details>

      <details className="panel speech-details">
        <summary><span><strong>添加克隆音色</strong><small>导入本人或明确授权的 3–30 秒单人录音</small></span></summary>
        <div className="speech-details-content">
        <p className="panel-intro">点击导入后由本机控制面板打开音频选择器；导入成功后长期保存在受管音色库，浏览器 payload 不接收或回显绝对路径。</p>
        <div className="speech-settings-grid">
          <label className="speech-field"><span>Profile 名称</span><input value={referenceVoice.displayName} onChange={(event) => setReferenceVoice({ ...referenceVoice, displayName: event.target.value })} /></label>
          <label className="speech-field"><span>来源标签</span><input value={referenceVoice.sourceLabel} onChange={(event) => setReferenceVoice({ ...referenceVoice, sourceLabel: event.target.value })} /></label>
          <label className="speech-field"><span>许可证 / 授权依据</span><input value={referenceVoice.license} onChange={(event) => setReferenceVoice({ ...referenceVoice, license: event.target.value })} /></label>
          <label className="speech-field speech-reference-transcript"><span>准确转写</span><textarea value={referenceVoice.transcript} onChange={(event) => setReferenceVoice({ ...referenceVoice, transcript: event.target.value })} /></label>
        </div>
        <label className="speech-authorization"><input type="checkbox" checked={referenceVoice.transcriptConfirmed} onChange={(event) => setReferenceVoice({ ...referenceVoice, transcriptConfirmed: event.target.checked })} /><span>我已逐字核对“准确转写”与录音内容一致；识别或文本有误时不得继续生成。</span></label>
        <label className="speech-authorization"><input type="checkbox" checked={referenceVoice.authorizationConfirmed} onChange={(event) => setReferenceVoice({ ...referenceVoice, authorizationConfirmed: event.target.checked })} /><span>我确认拥有该参考音频及其音色使用授权，并允许 Runtime 进行本机校验和受控导入。</span></label>
        <label className="speech-authorization"><input type="checkbox" checked={referenceVoice.cleanSingleSpeakerConfirmed} onChange={(event) => setReferenceVoice({ ...referenceVoice, cleanSingleSpeakerConfirmed: event.target.checked })} /><span>我确认音频为 3–30 秒、单人且干净的录音，不含背景音乐或其他说话人。</span></label>
        <button className="command-button" disabled={pending[importReference.id]} title={importReference.diagnosticCode || ''} onClick={() => {
          const blocker = !importReference.enabled
            ? describeSpeechDiagnostic(importReference.diagnosticCode)
            : !importReady ? describeReferenceVoiceMissing(referenceVoice) : '';
          if (blocker) showDiagnostic(blocker);
          else void runAction(importReference.id, referenceVoice as unknown as Record<string, unknown>);
        }}><Upload size={15} />选择并导入参考音频</button>
        </div>
      </details>
    </section>
  );
}
