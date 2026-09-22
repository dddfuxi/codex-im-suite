import { useMemo, useState } from 'react';

import {
  buildSkillWorkspace,
  skillAutonomyLabel,
  type SkillGovernancePanelState,
  type SkillRegistryItem,
} from '../skill-view-model.js';

type SkillTab = 'installed' | 'drafts' | 'catalog' | 'approvals';

export function SkillsPage({
  governance,
  run,
  refresh,
  pending,
}: {
  governance: SkillGovernancePanelState;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
  pending: Record<string, boolean>;
}) {
  const workspace = useMemo(() => buildSkillWorkspace(governance.snapshot), [governance.snapshot]);
  const [tab, setTab] = useState<SkillTab>('installed');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SkillRegistryItem[]>([]);
  const [draft, setDraft] = useState({ name: '', displayName: '', description: '', defaultPrompt: '' });

  const refreshRegistry = async () => {
    await run('skill.registry.snapshot');
    await refresh();
  };

  const searchCatalog = async () => {
    const results = await run('skill.catalog.search', { query: query.trim() }) as SkillRegistryItem[];
    const resultWorkspace = buildSkillWorkspace({
      protocol: 'cti-skill-registry/v1',
      generatedAt: new Date().toISOString(),
      items: Array.isArray(results) ? results : [],
    });
    if (resultWorkspace.installed.length > 0) {
      setSearchResults([]);
      setTab('installed');
      return;
    }
    setSearchResults(resultWorkspace.catalog);
    setTab('catalog');
  };

  const createDraft = async () => {
    await run('skill.draft.create', draft);
    setDraft({ name: '', displayName: '', description: '', defaultPrompt: '' });
    await refresh();
    setTab('drafts');
  };

  const validate = async (item: SkillRegistryItem) => {
    await run('skill.lifecycle.validate', { id: item.id });
    await refresh();
  };

  const prepareInstall = async (item: SkillRegistryItem) => {
    await run('skill.lifecycle.prepareInstall', {
      id: item.id,
      sourceClass: item.sourceClass,
      source: item.path || item.source || '',
      risk: item.risk,
      changeKind: 'install',
    });
    await refresh();
  };

  const confirmInstall = async (item: SkillRegistryItem) => {
    if (!item.approval?.nonce) return;
    await run('skill.lifecycle.confirmInstall', { nonce: item.approval.nonce });
    await refresh();
  };

  const setEnabled = async (item: SkillRegistryItem, enabled: boolean) => {
    await run(enabled ? 'skill.lifecycle.enable' : 'skill.lifecycle.disable', { id: item.id });
    await refresh();
  };

  const rollback = async (item: SkillRegistryItem) => {
    await run('skill.lifecycle.rollback', { id: item.id });
    await refresh();
  };

  const tabItems: Record<SkillTab, SkillRegistryItem[]> = {
    installed: workspace.installed,
    drafts: workspace.drafts,
    catalog: searchResults.length > 0 ? searchResults : workspace.catalog,
    approvals: workspace.approvals,
  };
  const tabs: Array<{ id: SkillTab; label: string; count: number }> = [
    { id: 'installed', label: '已安装', count: workspace.installed.length },
    { id: 'drafts', label: '草稿', count: workspace.drafts.length },
    { id: 'catalog', label: '能力目录', count: tabItems.catalog.length },
    { id: 'approvals', label: '审批队列', count: workspace.approvals.length },
  ];

  return (
    <section className="content-stack skills-page">
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Skill 生命周期</h2>
            <p>已安装 Skill 可直接使用；官方精选安装前询问；白名单低风险可自动处理；未知和高风险来源必须 Owner 审批。</p>
          </div>
          <button className="mini-button" type="button" onClick={() => void refreshRegistry()} disabled={pending['skill.registry.snapshot']}>刷新 Registry</button>
        </div>
        <div className="summary-grid wide">
          <SkillFact label="已安装" value={`${workspace.installed.length}`} />
          <SkillFact label="草稿" value={`${workspace.drafts.length}`} />
          <SkillFact label="待审批" value={`${workspace.approvals.length}`} />
          <SkillFact label="Registry" value={governance.available ? '可用' : '不可用'} />
        </div>
        {governance.error && <div className="inline-notice warning">{governance.error}</div>}
      </section>

      <section className="panel skill-create-panel">
        <div className="section-heading">
          <div><h2>创建 Skill 草稿</h2><p>使用官方 skill-creator 创建到受控草稿区，验证和确认后才能安装。</p></div>
        </div>
        <div className="skill-draft-grid">
          <label><span>ID</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="asset-cleaner" /></label>
          <label><span>显示名</span><input value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="资产清理" /></label>
          <label><span>简述</span><input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="解决哪类能力缺口" /></label>
          <label><span>默认提示</span><input value={draft.defaultPrompt} onChange={(event) => setDraft((current) => ({ ...current, defaultPrompt: event.target.value }))} placeholder="使用此 Skill 时的默认任务提示" /></label>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => void createDraft()}
          disabled={pending['skill.draft.create'] || Object.values(draft).some((value) => !value.trim())}
        >创建草稿</button>
      </section>

      <section className="panel">
        <div className="skill-tabs">
          {tabs.map((item) => (
            <button type="button" key={item.id} className={tab === item.id ? 'skill-tab active' : 'skill-tab'} onClick={() => setTab(item.id)}>
              {item.label}<span>{item.count}</span>
            </button>
          ))}
        </div>

        {tab === 'catalog' && (
          <div className="skill-catalog-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="仅在当前任务确实缺少能力时搜索官方精选或白名单来源" />
            <button className="mini-button" type="button" onClick={() => void searchCatalog()} disabled={pending['skill.catalog.search'] || !query.trim()}>按需搜索</button>
          </div>
        )}

        <div className="skill-card-grid">
          {tabItems[tab].map((item) => (
            <article className="skill-card" key={`${tab}-${item.id}-${item.sourceClass}`}>
              <header>
                <div><h3>{item.displayName || item.id}</h3><small>{item.id} · {item.sourceClass}</small></div>
                <span className={`skill-risk ${item.risk}`}>{skillAutonomyLabel(item)}</span>
              </header>
              <p>{item.validation?.summary || item.failureSummary || item.source || item.path || '暂无来源说明。'}</p>
              <dl>
                <dt>状态</dt><dd>{item.state}</dd>
                <dt>风险</dt><dd>{item.risk}</dd>
                <dt>更新时间</dt><dd>{formatSkillTime(item.updatedAt)}</dd>
              </dl>
              <div className="command-band dense">
                {tab === 'installed' && <button className="mini-button" type="button" onClick={() => void setEnabled(item, !item.enabled)}>{item.enabled ? '停用' : '启用'}</button>}
                {tab === 'installed' && item.rollbackPath && <button className="mini-button" type="button" onClick={() => void rollback(item)}>回滚</button>}
                {tab === 'drafts' && <button className="mini-button" type="button" onClick={() => void validate(item)}>验证</button>}
                {tab === 'drafts' && item.validation?.ok && <button className="mini-button" type="button" onClick={() => void prepareInstall(item)}>准备安装</button>}
                {tab === 'catalog' && <button className="mini-button" type="button" onClick={() => void prepareInstall(item)}>准备安装</button>}
                {tab === 'approvals' && item.approval?.nonce && <button className="primary-button" type="button" onClick={() => void confirmInstall(item)}>确认安装</button>}
              </div>
            </article>
          ))}
          {tabItems[tab].length === 0 && <p className="detail-copy">当前分区暂无 Skill。</p>}
        </div>
      </section>
    </section>
  );
}

function SkillFact({ label, value }: { label: string; value: string }) {
  return <div className="summary-fact"><span>{label}</span><strong>{value}</strong></div>;
}

function formatSkillTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : value || '-';
}
