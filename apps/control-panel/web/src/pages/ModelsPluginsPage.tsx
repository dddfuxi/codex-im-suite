import type { ReactNode } from 'react';

export function ModelsPluginsPage({ children }: { children: ReactNode }) {
  return (
    <section className="content-stack capability-domain-page">
      <section className="panel capability-domain-intro">
        <div className="section-heading"><div><h2>模型与插件</h2><p>保留 Ollama 模型安装、使用、卸载、进度任务和 Plugin 记录；不在这里安装 Skill。</p></div></div>
      </section>
      {children}
    </section>
  );
}
