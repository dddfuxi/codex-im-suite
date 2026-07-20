// Application Facade：Runtime 只能通过这里启动、停止和装配 Bridge。
import './lib/bridge/adapters/index.js';

export * from './lib/bridge/bridge-manager.js';
export * from './lib/bridge/context.js';
