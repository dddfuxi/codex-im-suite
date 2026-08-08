import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Mic,
  Play,
  RefreshCw,
  Save,
  Upload,
  Volume2,
} from 'lucide-react';

import type {
  SpeechPanelStateContract,
  SpeechSelectionContract,
  SpeechSettingsContract,
  SpeechStatusContract,
  SpeechVoiceProfileContract,
} from '@codex-im-suite/contracts/speech';
import {
  canImportSpeechReferenceVoice,
  canInstallSpeechComponent,
  canSaveSpeechSettings,
  createSpeechSettingsDraft,
  decodeSpeechPreviewReceipt,
  describeSpeechDisplayState,
  getSpeechAction,
  getSpeechCommandNotice,
  getSpeechPanelDiagnostic,
  updateSpeechChannelIds,
  type SpeechReferenceVoiceDraft,
} from '../speech-view-model.js';

type SpeechPageProps = {
  state: SpeechPanelStateContract;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
  pending: Record<string, boolean>;
};

const emptyReferenceVoice: SpeechReferenceVoiceDraft = {
  displayName: '',
  transcript: '',
  sourceLabel: '',
  license: '',
  authorizationConfirmed: false,
  cleanSingleSpeakerConfirmed: false,
};

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
  pending,
}: {
  profile: SpeechVoiceProfileContract;
  status: SpeechStatusContract;
  previewText: string;
  runAction: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  previewVoice: (profile: SpeechVoiceProfileContract) => Promise<void>;
  pending: Record<string, boolean>;
}) {
  const install = getSpeechAction(status, 'speech.installPresetVoice');
  const preview = getSpeechAction(status, 'speech.previewVoice');
  const activate = getSpeechAction(status, 'speech.activateVoiceProfile');
  return (
    <div className="speech-card-actions">
      {profile.kind === 'preset' && profile.state !== 'ready' && (
        <button className="mini-button" disabled={!install.enabled || pending[install.id]} title={install.diagnosticCode || ''} onClick={() => void runAction(install.id, { componentId: profile.id })}>
          <Download size={14} />下载预设音色
        </button>
      )}
      <button className="mini-button" disabled={!preview.enabled || profile.state !== 'ready' || !previewText.trim() || pending[preview.id]} title={preview.diagnosticCode || ''} onClick={() => void previewVoice(profile)}>
        <Play size={14} />试听
      </button>
      <button className="mini-button" disabled={!activate.enabled || profile.active || profile.state !== 'ready' || pending[activate.id]} title={activate.diagnosticCode || ''} onClick={() => void runAction(activate.id, { voiceProfileId: profile.id })}>
        <CheckCircle2 size={14} />{profile.active ? '当前音色' : '切换音色'}
      </button>
    </div>
  );
}

export function SpeechPage({ state, run, refresh, pending }: SpeechPageProps) {
  const status = state.status;
  const displayState = describeSpeechDisplayState(state);
  const [draft, setDraft] = useState<SpeechSettingsContract | null>(() => status ? createSpeechSettingsDraft(status) : null);
  const [previewText, setPreviewText] = useState('你好，这是一段语音试听。');
  const [singingPreviewText, setSingingPreviewText] = useState('你好，今天一起向前走。');
  const [referenceVoice, setReferenceVoice] = useState<SpeechReferenceVoiceDraft>(emptyReferenceVoice);
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [previewPlayback, setPreviewPlayback] = useState<{ url: string; profileName: string } | null>(null);

  useEffect(() => {
    setDraft(status ? createSpeechSettingsDraft(status) : null);
  }, [status?.lastCheckedAt]);

  useEffect(() => () => {
    if (previewPlayback?.url) URL.revokeObjectURL(previewPlayback.url);
  }, [previewPlayback?.url]);

  const runAction = async (command: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
    setLocalError('');
    setLocalNotice('');
    try {
      const result = await run(command, payload);
      setLocalNotice(getSpeechCommandNotice(result));
      await refresh();
      return result;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const previewVoice = async (profile: SpeechVoiceProfileContract) => {
    const result = await runAction('speech.previewVoice', {
      modelId: status?.ttsModel.value || '',
      voiceProfileId: profile.id,
      text: previewText.trim(),
    });
    if (!result) return;
    try {
      const { receipt, media } = decodeSpeechPreviewReceipt(result);
      if (receipt.voiceProfileId !== profile.id || receipt.modelId !== status?.ttsModel.value) throw new Error('speech_preview_profile_mismatch');
      const audioBytes = new ArrayBuffer(media.byteLength);
      new Uint8Array(audioBytes).set(media);
      const url = URL.createObjectURL(new Blob([audioBytes], { type: receipt.mediaType }));
      setPreviewPlayback({ url, profileName: profile.displayName });
      setLocalNotice(`已生成「${profile.displayName}」试听，可在下方播放。`);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'speech_preview_response_invalid');
    }
  };

  const previewSingingVoice = async () => {
    if (!draft) return;
    const voiceProfileId = draft.activeSingingVoiceProfileId || 'acestep.default';
    const result = await runAction('speech.previewSingingVoice', {
      modelId: draft.singingProvider,
      voiceProfileId,
      text: singingPreviewText.trim(),
    });
    if (!result) return;
    try {
      const { receipt, media } = decodeSpeechPreviewReceipt(result);
      if (receipt.voiceProfileId !== voiceProfileId) throw new Error('singing_preview_profile_mismatch');
      const audioBytes = new ArrayBuffer(media.byteLength);
      new Uint8Array(audioBytes).set(media);
      const url = URL.createObjectURL(new Blob([audioBytes], { type: receipt.mediaType }));
      const profileName = voiceProfileId === 'acestep.default'
        ? 'ACE-Step 默认歌声音色'
        : status?.voiceProfiles.find((profile) => profile.id === voiceProfileId)?.displayName || voiceProfileId;
      setPreviewPlayback({ url, profileName });
      setLocalNotice(`已生成「${profileName}」10 秒歌声试听。`);
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
  const compatibleSpeechProfiles = status.voiceProfiles.filter((profile) =>
    profile.capabilities.includes('speech') && profile.compatibleTtsModelIds.includes(draft.ttsModelId));
  const benchmarkModel = getSpeechAction(status, 'speech.benchmarkTtsModel');
  const settingsValid = canSaveSpeechSettings(status, draft);

  return (
    <section className="content-stack speech-page">
      <section className="panel speech-overview">
        <div className="section-header">
          <div>
            <div className="speech-title-row"><h2>语音</h2><span className={`status-pill ${displayState.tone}`}>{displayState.label}</span></div>
            <p className="panel-intro">所有状态、选项和动作来自 Runtime；面板不直接写配置，也不保存参考音频。</p>
          </div>
          <button className="command-button" disabled={pending['speech.refresh']} onClick={() => void runAction('speech.refresh')}>
            <RefreshCw size={15} className={pending['speech.refresh'] ? 'spin' : ''} />检查组件
          </button>
        </div>
        {(localError || status.diagnosticCode) && <div className="speech-diagnostic"><AlertTriangle size={15} /><code>{localError || status.diagnosticCode}</code></div>}
        {localNotice && <div className="speech-diagnostic"><RefreshCw size={15} /><span>{localNotice}</span></div>}
        <div className="summary-grid speech-summary">
          <article className="metric compact"><span>输入</span><strong>{status.inputEnabled ? '开启' : '关闭'}</strong></article>
          <article className="metric compact"><span>输出</span><strong>{status.outputEnabled ? '开启' : '关闭'}</strong></article>
          <article className="metric compact"><span>唱歌</span><strong>{status.singingEnabled ? '开启' : '关闭'}</strong></article>
          <article className="metric compact"><span>组件</span><strong>{status.components.filter((item) => item.state === 'ready').length}/{status.components.length}</strong></article>
          <article className="metric compact"><span>音色</span><strong>{status.voiceProfiles.length}</strong></article>
        </div>
      </section>

      <section className="panel">
        <div className="section-header"><div><h2>输入与输出策略</h2><p className="panel-intro">保存时只提交当前 Runtime 已声明的 opaque ID。</p></div></div>
        <div className="speech-toggle-grid">
          <label className="speech-toggle"><Mic size={18} /><span><strong>语音输入</strong><small>允许渠道音频进入 ASR。</small></span><input type="checkbox" checked={draft.inputEnabled} onChange={(event) => setDraft({ ...draft, inputEnabled: event.target.checked })} /></label>
          <label className="speech-toggle"><Volume2 size={18} /><span><strong>语音输出</strong><small>允许受控 TTS 生成语音回复。</small></span><input type="checkbox" checked={draft.outputEnabled} onChange={(event) => setDraft({ ...draft, outputEnabled: event.target.checked })} /></label>
          <label className="speech-toggle"><Volume2 size={18} /><span><strong>歌声合成</strong><small>只使用独立 SingingHost，不以 TTS 冒充唱歌。</small></span><input type="checkbox" checked={draft.singingEnabled} onChange={(event) => setDraft({ ...draft, singingEnabled: event.target.checked })} /></label>
        </div>
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
          <SelectionField label="回复策略" selection={status.replyPolicy} value={draft.replyPolicy} onChange={(value) => setDraft({ ...draft, replyPolicy: value })} />
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
          <label className="speech-field"><span>TTS 模型</span><select value={draft.ttsModelId} disabled={!draft.outputEnabled} onChange={(event) => {
            const model = status.ttsModel.options.find((item) => item.id === event.target.value);
            const currentVoiceCompatible = compatibleSpeechProfiles.some((profile) => profile.id === draft.activeVoiceProfileId && profile.compatibleTtsModelIds.includes(event.target.value));
            setDraft({
              ...draft,
              ttsModelId: event.target.value,
              ttsProvider: model?.providerId || draft.ttsProvider,
              activeVoiceProfileId: currentVoiceCompatible ? draft.activeVoiceProfileId : model?.defaultVoiceProfileId || '',
              tonePolicy: model?.capabilities.includes('instruction_control') ? draft.tonePolicy : 'neutral_stable',
            });
          }}>{status.ttsModel.options.map((model) => <option key={model.id} value={model.id} disabled={!model.enabled}>{model.displayName} · {model.state}</option>)}</select></label>
          <SelectionField label="语气策略" selection={status.tonePolicy} value={draft.tonePolicy} disabled={!draft.outputEnabled} onChange={(value) => setDraft({ ...draft, tonePolicy: value })} />
          <SelectionField label="Singing Provider" selection={status.singingProvider} value={draft.singingProvider} disabled={!draft.singingEnabled || !selectedChannelsSupportOutput} onChange={(value) => setDraft({ ...draft, singingProvider: value })} />
          <label className="speech-field"><span>说话音色</span><select value={draft.activeVoiceProfileId} disabled={!draft.outputEnabled} onChange={(event) => setDraft({ ...draft, activeVoiceProfileId: event.target.value })}><option value="">当前模型默认音色</option>{compatibleSpeechProfiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.state !== 'ready'}>{profile.displayName} · {profile.state}</option>)}</select></label>
          <label className="speech-field"><span>歌声音色</span><select value={draft.activeSingingVoiceProfileId} disabled={!draft.singingEnabled} onChange={(event) => setDraft({ ...draft, activeSingingVoiceProfileId: event.target.value })}><option value="">ACE-Step 默认歌声音色</option>{status.voiceProfiles.filter((profile) => profile.capabilities.includes('singing')).map((profile) => <option key={profile.id} value={profile.id} disabled={profile.state !== 'ready'}>{profile.displayName} · {profile.state}</option>)}</select></label>
        </div>
        <div className="speech-limit-row">
          <span>输入上限 {status.limits.maxInputBytes.toLocaleString()} bytes</span>
          <span>时长 {status.limits.maxInputDurationSeconds}s</span>
          <span>输出 {status.limits.maxOutputCharacters} 字</span>
          <span>歌曲最长 {status.limits.maxSongDurationSeconds}s</span>
        </div>
        {selectedTtsModel && <div className="speech-diagnostic">
          <Volume2 size={15} />
          <span>
            配置模型：{selectedTtsModel.displayName}；live：{status.ttsModel.liveValue || '未加载'}；
            benchmark：{selectedTtsModel.benchmark.state}
            {selectedTtsModel.benchmark.warmSynthesisMs !== undefined ? ` · 热态 ${Math.round(selectedTtsModel.benchmark.warmSynthesisMs)}ms` : ''}
          </span>
          <button className="mini-button" disabled={!benchmarkModel.enabled || draft.ttsModelId !== status.ttsModel.value || pending[benchmarkModel.id]} title={benchmarkModel.diagnosticCode || ''} onClick={() => void runAction(benchmarkModel.id, { modelId: status.ttsModel.value })}><Play size={14} />性能测试</button>
        </div>}
        {status.ttsModel.restartRequired && <div className="speech-diagnostic"><AlertTriangle size={15} /><span>已保存模型尚未由 live Runtime 加载，请受控重启 Bridge 后再试听或测试。</span></div>}
        <div className="command-band dense speech-save-row"><button className="command-button" disabled={!settingsValid || pending['speech.saveSettings']} onClick={() => void runAction('speech.saveSettings', draft as unknown as Record<string, unknown>)}><Save size={15} />保存语音设置</button>{!settingsValid && <span>当前选择未被 Runtime 声明或尚未 ready，不能提交。</span>}</div>
      </section>

      <section className="panel">
        <div className="section-header"><div><h2>组件与能力</h2><p className="panel-intro">安装入口仅在 Runtime 显式开放对应 action 时启用。</p></div></div>
        {status.components.length === 0 ? <div className="empty-inline">Runtime 未返回组件。</div> : <div className="speech-card-grid">{status.components.map((component) => (
          <article className="speech-card" key={component.id}>
            <div className="speech-card-head"><div><strong>{component.displayName}</strong><small>{component.kind}{component.version ? ` · ${component.version}` : ''}</small></div><span className={`status-pill ${describeSpeechDisplayState({ available: true, status: { ...status, state: component.state } }).tone}`}>{component.state}</span></div>
            <div className="speech-capability-list">{component.capabilities.length > 0 ? component.capabilities.map((capability) => <span className="token-chip" key={capability}>{capability}</span>) : <span>未声明能力</span>}</div>
            {component.diagnosticCode && <code>{component.diagnosticCode}</code>}
            {component.installable && component.state !== 'ready' && <button className="mini-button" disabled={!canInstallSpeechComponent(component, installComponent) || pending[installComponent.id]} title={installComponent.diagnosticCode || ''} onClick={() => void runAction(installComponent.id, { componentId: component.id })}><Download size={14} />安装组件</button>}
          </article>
        ))}</div>}
      </section>

      <section className="panel">
        <div className="section-header"><div><h2>音色 Profile</h2><p className="panel-intro">状态只展示授权与来源标签，不展示参考音频、转写、文件路径或密钥。</p></div></div>
        <label className="speech-field speech-preview-text"><span>试听文本</span><input value={previewText} maxLength={status.limits.maxPreviewCharacters} onChange={(event) => setPreviewText(event.target.value)} /></label>
        <div className="speech-singing-preview">
          <label className="speech-field speech-preview-text"><span>歌声试听歌词（固定 10 秒）</span><input value={singingPreviewText} maxLength={status.limits.maxPreviewCharacters} onChange={(event) => setSingingPreviewText(event.target.value)} /></label>
          <button className="mini-button" disabled={!getSpeechAction(status, 'speech.previewSingingVoice').enabled || !singingPreviewText.trim() || pending['speech.previewSingingVoice']} title={getSpeechAction(status, 'speech.previewSingingVoice').diagnosticCode || ''} onClick={() => void previewSingingVoice()}><Play size={14} />试听歌声</button>
        </div>
        {previewPlayback && (
          <div className="speech-preview-player">
            <strong>{previewPlayback.profileName}</strong>
            <audio controls autoPlay src={previewPlayback.url}>当前 WebView 不支持音频播放。</audio>
          </div>
        )}
        {status.voiceProfiles.length === 0 ? <div className="empty-inline">Runtime 未返回音色 Profile。</div> : <div className="speech-card-grid">{status.voiceProfiles.map((profile) => (
          <article className="speech-card" key={profile.id}>
            <div className="speech-card-head"><div><strong>{profile.displayName}</strong><small>{profile.kind === 'preset' ? '预设音色' : '授权参考音色'} · {profile.sourceLabel}</small></div><span className={`status-pill ${profile.state === 'ready' ? 'ok' : profile.state === 'optional_missing' ? 'warning' : 'error'}`}>{profile.state}</span></div>
            <div className="speech-profile-facts"><span>许可证：{profile.license || '未声明'}</span><span>授权：{profile.authorizationConfirmed ? '已确认' : '未确认'}</span><span>能力：{profile.capabilities.join(' / ')}</span></div>
            {profile.diagnosticCode && <code>{profile.diagnosticCode}</code>}
            <VoiceProfileActions profile={profile} status={status} previewText={previewText} runAction={runAction} previewVoice={previewVoice} pending={pending} />
          </article>
        ))}</div>}
      </section>

      <section className="panel">
        <div className="section-header"><div><h2>导入授权参考音频</h2><p className="panel-intro">点击导入后由本机控制面板打开音频选择器；浏览器 payload 不接收或回显绝对路径。</p></div></div>
        <div className="speech-settings-grid">
          <label className="speech-field"><span>Profile 名称</span><input value={referenceVoice.displayName} onChange={(event) => setReferenceVoice({ ...referenceVoice, displayName: event.target.value })} /></label>
          <label className="speech-field"><span>来源标签</span><input value={referenceVoice.sourceLabel} onChange={(event) => setReferenceVoice({ ...referenceVoice, sourceLabel: event.target.value })} /></label>
          <label className="speech-field"><span>许可证 / 授权依据</span><input value={referenceVoice.license} onChange={(event) => setReferenceVoice({ ...referenceVoice, license: event.target.value })} /></label>
          <label className="speech-field speech-reference-transcript"><span>准确转写</span><textarea value={referenceVoice.transcript} onChange={(event) => setReferenceVoice({ ...referenceVoice, transcript: event.target.value })} /></label>
        </div>
        <label className="speech-authorization"><input type="checkbox" checked={referenceVoice.authorizationConfirmed} onChange={(event) => setReferenceVoice({ ...referenceVoice, authorizationConfirmed: event.target.checked })} /><span>我确认拥有该参考音频及其音色使用授权，并允许 Runtime 进行本机校验和受控导入。</span></label>
        <label className="speech-authorization"><input type="checkbox" checked={referenceVoice.cleanSingleSpeakerConfirmed} onChange={(event) => setReferenceVoice({ ...referenceVoice, cleanSingleSpeakerConfirmed: event.target.checked })} /><span>我确认音频为 3–30 秒、单人且干净的录音，不含背景音乐或其他说话人。</span></label>
        <button className="command-button" disabled={!importReference.enabled || !importReady || pending[importReference.id]} title={importReference.diagnosticCode || ''} onClick={() => void runAction(importReference.id, referenceVoice as unknown as Record<string, unknown>)}><Upload size={15} />选择并导入参考音频</button>
      </section>
    </section>
  );
}
