import { useEffect, useMemo, useState } from 'react';

import {
  buildPromptSectionRows,
  type PromptSnapshotPanelState,
  type PromptSnapshotRecord,
} from '../prompt-view-model.js';

export function PromptPage({
  state,
  refresh,
  openPath,
}: {
  state: PromptSnapshotPanelState;
  refresh: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
}) {
  const snapshots = useMemo(
    () => [...(state.data?.snapshots ?? [])].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [state.data?.snapshots],
  );
  const [selectedKey, setSelectedKey] = useState('');
  const selected = snapshots.find((item) => snapshotKey(item) === selectedKey) ?? snapshots[0];
  const rows = selected ? buildPromptSectionRows(selected) : [];

  useEffect(() => {
    if (snapshots.length === 0) {
      setSelectedKey('');
      return;
    }
    if (!snapshots.some((item) => snapshotKey(item) === selectedKey)) {
      setSelectedKey(snapshotKey(snapshots[0]));
    }
  }, [selectedKey, snapshots]);

  const copySnapshot = async () => {
    if (!selected) return;
    const text = rows.map((row) => `## ${row.kindLabel}\n来源：${row.source}\n\n${row.content}`).join('\n\n');
    await navigator.clipboard.writeText(text);
  };

  return (
    <section className="content-stack prompt-page">
      <section className="panel prompt-summary-panel">
        <div className="section-heading">
          <div>
            <h2>Prompt Snapshot</h2>
            <p>只读展示实际注入模型前保存的脱敏快照；写入失败不会阻断聊天。</p>
          </div>
          <div className="command-band dense">
            <button className="mini-button" type="button" onClick={() => void refresh()}>刷新</button>
            <button className="mini-button" type="button" onClick={() => void copySnapshot()} disabled={!selected}>复制脱敏内容</button>
            <button className="mini-button" type="button" onClick={() => void openPath(state.path)} disabled={!state.path}>打开 Snapshot 文件</button>
          </div>
        </div>
        <div className="summary-grid wide">
          <PromptFact label="状态" value={state.available ? '可读取' : '等待数据'} />
          <PromptFact label="保留数量" value={`${state.data?.policy?.maxItems ?? 100}`} />
          <PromptFact label="保留天数" value={`${state.data?.policy?.maxAgeDays ?? 7} 天`} />
          <PromptFact label="快照数量" value={`${snapshots.length}`} />
        </div>
        {state.error && <div className="inline-notice warning">{state.error}</div>}
      </section>

      <section className="prompt-workspace">
        <aside className="panel prompt-snapshot-list">
          <div className="section-heading"><h2>最近快照</h2></div>
          {snapshots.map((snapshot) => (
            <button
              type="button"
              key={snapshotKey(snapshot)}
              className={snapshotKey(snapshot) === snapshotKey(selected) ? 'prompt-snapshot-row active' : 'prompt-snapshot-row'}
              onClick={() => setSelectedKey(snapshotKey(snapshot))}
            >
              <strong>{snapshot.sessionId || '未命名会话'}</strong>
              <span>{formatSnapshotTime(snapshot.createdAt)}</span>
              <small>{snapshot.sections.length} 段 · {snapshot.totalChars} 字符</small>
            </button>
          ))}
          {snapshots.length === 0 && <p className="detail-copy">机器人完成一次对话后，这里会出现实际 Prompt Snapshot。</p>}
        </aside>

        <section className="panel prompt-section-list">
          <div className="section-heading">
            <div>
              <h2>{selected?.sessionId || '快照详情'}</h2>
              <p>{selected ? `${formatSnapshotTime(selected.createdAt)} · ${selected.totalChars} 字符` : '暂无可展示快照。'}</p>
            </div>
          </div>
          {rows.map((row) => (
            <details className="prompt-section-card" key={row.id} open={row.priority <= 20}>
              <summary>
                <span><strong>{row.kindLabel}</strong><small>{row.source}</small></span>
                <span className="prompt-section-meta">P{row.priority} · {row.charCount} 字 · {row.shortHash}{row.warning ? ` · ${row.warning}` : ''}</span>
              </summary>
              <pre>{row.content}</pre>
            </details>
          ))}
        </section>
      </section>
    </section>
  );
}

function PromptFact({ label, value }: { label: string; value: string }) {
  return <div className="summary-fact"><span>{label}</span><strong>{value}</strong></div>;
}

function snapshotKey(snapshot: PromptSnapshotRecord | undefined): string {
  return snapshot ? `${snapshot.sessionId}::${snapshot.createdAt}` : '';
}

function formatSnapshotTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : value || '-';
}
