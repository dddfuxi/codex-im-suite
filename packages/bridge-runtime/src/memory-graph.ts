import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { KnowledgeIndex, KnowledgeItem } from './knowledge-indexer.js';

export interface MemoryGraphNode {
  id: string;
  label: string;
  kind: 'knowledge' | 'alias' | 'project' | 'entity' | 'path' | 'command' | 'scene';
  sourceItemIds?: string[];
  sourcePaths?: string[];
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
  type: 'alias_of' | 'maps_to' | 'related_to' | 'mentions' | 'conflicts_with' | 'reverse_lookup';
  weight: number;
  sourceItemIds?: string[];
  sourcePaths?: string[];
}

export interface MemoryGraphRelatedItem {
  id: string;
  label: string;
  kind: MemoryGraphNode['kind'];
  score: number;
  via: string[];
  edgeTypes: MemoryGraphEdge['type'][];
  sourcePaths: string[];
}

export interface MemoryGraphContext {
  query: string;
  summary: string;
  related: MemoryGraphRelatedItem[];
  generatedAt?: string;
}

export interface MemoryGraphIndex {
  schema: 'codex-im-suite/memory-graph/v1';
  memoryRoot: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function normalizeLabel(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeForSearch(label: string): string {
  return normalizeLabel(label).toLowerCase();
}

function inferNodeKind(label: string): MemoryGraphNode['kind'] {
  if (/^(?:[A-Za-z]:\\|\.{0,2}\/|Assets\/|Packages\/|[A-Za-z0-9_-]+\/)/u.test(label)) return 'path';
  if (/^(?:npm|pnpm|yarn|powershell|node|git|npx)\b/iu.test(label)) return 'command';
  if (/scene|场景|HSScene|_Scene\b/iu.test(label)) return 'scene';
  if (/项目|project|STH|ST2H|ST横板|H项目/iu.test(label)) return 'project';
  if (/别名|也叫|alias/iu.test(label)) return 'alias';
  return 'entity';
}

function nodeId(label: string, kind: MemoryGraphNode['kind']): string {
  return `mg_${sha1(`${kind}:${normalizeForSearch(label)}`)}`;
}

function edgeId(edge: MemoryGraphEdge): string {
  return `${edge.from}:${edge.to}:${edge.type}`;
}

function addNode(
  nodes: Map<string, MemoryGraphNode>,
  label: string,
  source: KnowledgeItem,
): MemoryGraphNode | null {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;
  const kind = inferNodeKind(normalized);
  const id = nodeId(normalized, kind);
  const existing = nodes.get(id);
  const sourcePath = source.source.path;
  if (existing) {
    existing.sourceItemIds = Array.from(new Set([...(existing.sourceItemIds || []), source.id]));
    existing.sourcePaths = Array.from(new Set([...(existing.sourcePaths || []), sourcePath]));
    return existing;
  }
  const node: MemoryGraphNode = {
    id,
    label: normalized,
    kind,
    sourceItemIds: [source.id],
    sourcePaths: [sourcePath],
  };
  nodes.set(id, node);
  return node;
}

function addEdge(
  edges: Map<string, MemoryGraphEdge>,
  from: MemoryGraphNode | null,
  to: MemoryGraphNode | null,
  type: MemoryGraphEdge['type'],
  weight: number,
  source: KnowledgeItem,
): void {
  if (!from || !to || from.id === to.id) return;
  const key = edgeId({ from: from.id, to: to.id, type, weight });
  const existing = edges.get(key);
  const sourcePath = source.source.path;
  if (existing) {
    existing.weight = Math.max(existing.weight, weight);
    existing.sourceItemIds = Array.from(new Set([...(existing.sourceItemIds || []), source.id]));
    existing.sourcePaths = Array.from(new Set([...(existing.sourcePaths || []), sourcePath]));
    return;
  }
  edges.set(key, {
    from: from.id,
    to: to.id,
    type,
    weight,
    sourceItemIds: [source.id],
    sourcePaths: [sourcePath],
  });
}

function itemLabels(item: KnowledgeItem): string[] {
  return Array.from(new Set([
    item.key,
    item.value,
    item.text,
  ].filter((value): value is string => !!value?.trim()).map(normalizeLabel)));
}

export function buildMemoryGraphFromKnowledgeIndex(index: KnowledgeIndex): MemoryGraphIndex {
  const nodes = new Map<string, MemoryGraphNode>();
  const edges = new Map<string, MemoryGraphEdge>();
  const labelsBySourcePath = new Map<string, Array<{ node: MemoryGraphNode; source: KnowledgeItem }>>();

  for (const item of index.items) {
    const keyNode = item.key ? addNode(nodes, item.key, item) : null;
    const valueNode = item.value ? addNode(nodes, item.value, item) : null;
    if (keyNode && valueNode) {
      addEdge(edges, keyNode, valueNode, 'maps_to', item.confidence + 0.1, item);
      addEdge(edges, valueNode, keyNode, 'reverse_lookup', Math.max(0.7, item.confidence), item);
    }
    if (item.conflict && keyNode && valueNode) {
      addEdge(edges, keyNode, valueNode, 'conflicts_with', 0.35, item);
    }

    for (const label of itemLabels(item)) {
      const node = addNode(nodes, label, item);
      if (!node) continue;
      const list = labelsBySourcePath.get(item.source.path) || [];
      list.push({ node, source: item });
      labelsBySourcePath.set(item.source.path, list);
    }
  }

  for (const entries of labelsBySourcePath.values()) {
    const deduped = [...new Map(entries.map((entry) => [entry.node.id, entry])).values()].slice(0, 80);
    for (let leftIndex = 0; leftIndex < deduped.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < deduped.length; rightIndex += 1) {
        const left = deduped[leftIndex];
        const right = deduped[rightIndex];
        addEdge(edges, left.node, right.node, 'related_to', 0.35, left.source);
        addEdge(edges, right.node, left.node, 'related_to', 0.35, right.source);
      }
    }
  }

  return {
    schema: 'codex-im-suite/memory-graph/v1',
    memoryRoot: index.memoryRoot,
    generatedAt: new Date().toISOString(),
    nodeCount: nodes.size,
    edgeCount: edges.size,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

function seedScore(node: MemoryGraphNode, query: string): number {
  const label = normalizeForSearch(node.label);
  const needle = normalizeForSearch(query);
  if (!needle) return 0;
  if (label === needle) return 10;
  if (label.includes(needle)) return 8;
  if (needle.includes(label) && label.length >= 2) return 7;
  let score = 0;
  for (const token of needle.split(/\s+/).filter(Boolean)) {
    if (label.includes(token)) score += 2;
  }
  return score;
}

function addRelated(
  related: Map<string, MemoryGraphRelatedItem>,
  node: MemoryGraphNode,
  score: number,
  via: string,
  edgeType: MemoryGraphEdge['type'],
): void {
  const existing = related.get(node.id);
  if (existing) {
    existing.score = Math.max(existing.score, score);
    existing.via = Array.from(new Set([...existing.via, via]));
    existing.edgeTypes = Array.from(new Set([...existing.edgeTypes, edgeType]));
    existing.sourcePaths = Array.from(new Set([...existing.sourcePaths, ...(node.sourcePaths || [])]));
    return;
  }
  related.set(node.id, {
    id: node.id,
    label: node.label,
    kind: node.kind,
    score,
    via: [via],
    edgeTypes: [edgeType],
    sourcePaths: node.sourcePaths || [],
  });
}

export function searchMemoryGraph(
  graph: MemoryGraphIndex | null,
  query: string,
  options: { limit?: number } = {},
): MemoryGraphContext {
  if (!graph || graph.nodes.length === 0) {
    return { query, summary: '', related: [] };
  }
  const limit = Math.max(1, options.limit || 8);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesByFrom = new Map<string, MemoryGraphEdge[]>();
  for (const edge of graph.edges) {
    edgesByFrom.set(edge.from, [...(edgesByFrom.get(edge.from) || []), edge]);
  }

  const seeds = graph.nodes
    .map((node) => ({ node, score: seedScore(node, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);
  const seedIds = new Set(seeds.map((entry) => entry.node.id));
  const related = new Map<string, MemoryGraphRelatedItem>();

  for (const seed of seeds) {
    addRelated(related, seed.node, seed.score, seed.node.label, 'mentions');
    for (const edge of edgesByFrom.get(seed.node.id) || []) {
      const target = nodesById.get(edge.to);
      if (!target) continue;
      addRelated(related, target, seed.score + edge.weight, seed.node.label, edge.type);
      for (const secondEdge of edgesByFrom.get(target.id) || []) {
        const secondTarget = nodesById.get(secondEdge.to);
        if (!secondTarget || seedIds.has(secondTarget.id)) continue;
        addRelated(related, secondTarget, seed.score + edge.weight * 0.7 + secondEdge.weight * 0.4, target.label, secondEdge.type);
      }
    }
  }

  const selected = [...related.values()]
    .filter((item) => !seedIds.has(item.id) || item.label !== query)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label, 'zh-Hans-CN'))
    .slice(0, limit);
  const summary = selected.length > 0
    ? [
      'Memory graph related context:',
      ...selected.map((item) => `- ${item.label} (${item.edgeTypes.join(', ')})`),
    ].join('\n')
    : '';
  return {
    query,
    summary,
    related: selected,
    generatedAt: graph.generatedAt,
  };
}

export function getMemoryGraphIndexPath(memoryRoot: string): string {
  return path.join(memoryRoot, '.cti-index', 'memory-graph.json');
}

export function readMemoryGraphIndex(memoryRoot: string): MemoryGraphIndex | null {
  const graphPath = getMemoryGraphIndexPath(memoryRoot);
  try {
    if (!fs.existsSync(graphPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as MemoryGraphIndex;
    return parsed?.schema === 'codex-im-suite/memory-graph/v1' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeMemoryGraphIndex(memoryRoot: string, graph: MemoryGraphIndex): void {
  const graphPath = getMemoryGraphIndexPath(memoryRoot);
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  const tmp = `${graphPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2), 'utf-8');
  fs.renameSync(tmp, graphPath);
}
