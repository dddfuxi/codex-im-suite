import { AGENT_ARCHITECTURE_LAYERS } from '../../../../../packages/bridge-core/src/lib/bridge/agent-architecture.js';

export type ArchitectureBlueprintItem = {
  id: string;
  title: string;
  detail: string;
  status: 'normal' | 'attention' | 'disabled';
  children?: Array<{
    id: string;
    title: string;
    detail: string;
    status: 'normal' | 'attention' | 'disabled';
  }>;
};

export function ArchitecturePage({ blueprint }: { blueprint: ArchitectureBlueprintItem[] }) {
  return (
    <section className="content-stack architecture-page">
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>当前运行主链</h2>
            <p>这里展示面板当前读到的入口、Bridge、AI、辅助能力和交付状态，不在页面内重算策略。</p>
          </div>
        </div>
        <div className="architecture-flow">
          {blueprint.map((item) => (
            <article key={item.id} className={`architecture-flow-node ${item.status}`}>
              <span>{item.title}</span>
              <p>{item.detail}</p>
              {item.children && item.children.length > 0 && (
                <div className="architecture-flow-children">
                  {item.children.map((child) => (
                    <small key={child.id}>{child.title} · {child.detail}</small>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>机器人八层职责注册表</h2>
            <p>内容直接来自 bridge-core 的 Agent Architecture Registry；面板只读展示，不维护副本。</p>
          </div>
        </div>
        <div className="architecture-layer-grid">
          {AGENT_ARCHITECTURE_LAYERS.map((layer, index) => (
            <article className="architecture-layer-card" key={layer.id}>
              <div className="architecture-layer-index">{String(index + 1).padStart(2, '0')}</div>
              <div>
                <h3>{layer.title}</h3>
                <p>{layer.responsibility}</p>
                <dl>
                  <dt>负责</dt>
                  <dd>{layer.owns.join(' · ')}</dd>
                  <dt>不负责</dt>
                  <dd>{layer.excludes.join(' · ')}</dd>
                </dl>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
