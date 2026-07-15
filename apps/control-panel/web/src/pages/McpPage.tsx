import type { ReactNode } from 'react';

export function McpPage({ children }: { children: ReactNode }) {
  return (
    <section className="content-stack capability-domain-page">
      <section className="panel capability-domain-intro">
        <div className="section-heading"><div><h2>MCP</h2><p>只展示 MCP manifest、注册、检查、启停、安装和来源详情；不混入 Skill 或模型安装。</p></div></div>
      </section>
      {children}
    </section>
  );
}
