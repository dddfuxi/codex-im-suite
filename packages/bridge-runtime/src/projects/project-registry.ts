import fs from 'node:fs';
import path from 'node:path';

import {
  importLegacyWorkspaceRoots,
  isSameOrChildProjectPath,
  parseProjectRegistryDocument,
  type RegisteredProject,
} from '@codex-im-suite/contracts';

export interface LoadRegisteredProjectRegistryInput {
  registryPath: string;
  legacyRoots?: readonly string[];
  deniedRoots?: readonly string[];
}

export interface LoadedRegisteredProjectRegistry {
  registryPath: string;
  source: 'empty' | 'structured' | 'legacy' | 'mixed';
  projects: RegisteredProject[];
  warnings: string[];
}

function readStructuredProjects(registryPath: string, deniedRoots: readonly string[]): RegisteredProject[] {
  if (!fs.existsSync(registryPath)) return [];
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as unknown;
  } catch {
    throw new Error('project_registry_invalid_json');
  }
  return parseProjectRegistryDocument(document, { deniedRoots });
}

/**
 * 结构化记录优先于旧平面路径；旧根与任一结构化项目重叠时不再生成兼容项目，
 * 避免宽泛父目录重新获得挂载资格。
 */
export function loadRegisteredProjectRegistry(
  input: LoadRegisteredProjectRegistryInput,
): LoadedRegisteredProjectRegistry {
  const registryPath = path.resolve(input.registryPath);
  const deniedRoots = input.deniedRoots || [];
  const structured = readStructuredProjects(registryPath, deniedRoots);
  const legacy = importLegacyWorkspaceRoots(input.legacyRoots || [], { deniedRoots });
  const warnings: string[] = [];
  const compatibleLegacy = legacy.filter((legacyProject) => {
    const overlaps = structured.some((project) => (
      isSameOrChildProjectPath(legacyProject.workspaceRoot, project.workspaceRoot)
      || isSameOrChildProjectPath(project.workspaceRoot, legacyProject.workspaceRoot)
    ));
    if (overlaps) warnings.push(`legacy_root_shadowed:${legacyProject.workspaceRoot}`);
    return !overlaps;
  });
  const projects = [...structured, ...compatibleLegacy];
  const source = structured.length > 0 && compatibleLegacy.length > 0
    ? 'mixed'
    : structured.length > 0
      ? 'structured'
      : compatibleLegacy.length > 0
        ? 'legacy'
        : 'empty';
  return { registryPath, source, projects, warnings };
}
