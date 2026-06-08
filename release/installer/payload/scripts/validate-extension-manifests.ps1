param(
    [string]$ManifestRoot,
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
if (-not $ManifestRoot) {
    $ManifestRoot = Join-Path $suiteRoot 'config'
}

$ctiHome = if ([string]::IsNullOrWhiteSpace($env:CTI_HOME)) { Join-Path $env:USERPROFILE '.claude-to-im' } else { [string]$env:CTI_HOME }
$env:CTI_VALIDATE_MANIFEST_ROOT = $ManifestRoot
$env:CTI_VALIDATE_SUITE_ROOT = $suiteRoot
$env:CTI_VALIDATE_CTI_HOME = $ctiHome
$env:CTI_VALIDATE_STRICT = if ($Strict) { 'true' } else { 'false' }

$nodeScript = @'
const fs = require("fs");
const path = require("path");

const manifestRoot = process.env.CTI_VALIDATE_MANIFEST_ROOT;
const suiteRoot = process.env.CTI_VALIDATE_SUITE_ROOT;
const ctiHome = process.env.CTI_VALIDATE_CTI_HOME;
const strict = process.env.CTI_VALIDATE_STRICT === "true";

const suiteManifest = JSON.parse(fs.readFileSync(path.join(suiteRoot, "suite.manifest.json"), "utf8"));
const extensionProtocolId = suiteManifest.extensionProtocol?.id || "extension-manifest/v1";
const runtimeProtocolId = suiteManifest.runtimeProtocol?.id || "runtime-manifest/v1";
const suiteVersion = String(suiteManifest.version || "");
const requiredExtensionFields = suiteManifest.extensionProtocol?.requiredFields?.length
  ? suiteManifest.extensionProtocol.requiredFields.map(String)
  : ["id", "displayName", "type", "version", "compatibility", "category", "optional", "installState", "source", "enabled", "description"];
const requiredRuntimeFields = suiteManifest.runtimeProtocol?.requiredFields?.length
  ? suiteManifest.runtimeProtocol.requiredFields.map(String)
  : ["id", "displayName", "kind", "category", "enabled", "installState", "source", "cwd", "version", "description"];

const overlayManifestRoot = path.join(ctiHome, "extensions", "manifests");
const knownDirs = [
  { path: path.join(manifestRoot, "mcp.d"), types: ["http", "stdio"], label: "mcp", required: true },
  { path: path.join(overlayManifestRoot, "mcp.d"), types: ["http", "stdio"], label: "mcp overlay", required: false },
  { path: path.join(manifestRoot, "skills.d"), types: ["skill"], label: "skill", required: true },
  { path: path.join(overlayManifestRoot, "skills.d"), types: ["skill"], label: "skill overlay", required: false },
  { path: path.join(manifestRoot, "plugins.d"), types: ["plugin"], label: "plugin", required: true },
  { path: path.join(overlayManifestRoot, "plugins.d"), types: ["plugin"], label: "plugin overlay", required: false },
];
const runtimeDir = path.join(manifestRoot, "runtime.d");

const errors = [];
const warnings = [];
const seenIds = new Set();
let checked = 0;
let enabled = 0;
let disabled = 0;

function addError(message) {
  errors.push(message);
}

function addWarning(message) {
  warnings.push(message);
}

function expandManifestSource(value) {
  if (!value) return "";
  return String(value)
    .replaceAll("${SUITE_ROOT}", suiteRoot)
    .replaceAll("${CTI_HOME}", ctiHome)
    .replaceAll("${USERPROFILE}", process.env.USERPROFILE || "");
}

function isExternalSource(value) {
  return /^(external|uvx|codex-plugin|npm|git|https?)[:/]/i.test(String(value || ""));
}

function validateUpdateBlock(manifest, filePath) {
  if (!manifest.update) return;
  const update = manifest.update;
  if (typeof update !== "object" || Array.isArray(update)) {
    addError(`${filePath}: update must be an object`);
    return;
  }

  if ("enabled" in update && typeof update.enabled !== "boolean") {
    addError(`${filePath}: update.enabled must be a boolean`);
  }

  if (!["npm_global_package", "skill_git_repo", "skill_codex_copy", "suite_live_sync"].includes(String(update.kind || ""))) {
    addError(`${filePath}: unsupported update.kind '${String(update.kind || "")}'`);
  }

  if ("surfaces" in update) {
    if (!Array.isArray(update.surfaces)) {
      addError(`${filePath}: update.surfaces must be an array`);
    } else {
      for (const surface of update.surfaces) {
        if (!["service", "extension"].includes(String(surface || ""))) {
          addError(`${filePath}: invalid update.surfaces value '${String(surface || "")}'`);
        }
      }
    }
  }

  if ("postCheckUnitIds" in update && !Array.isArray(update.postCheckUnitIds)) {
    addError(`${filePath}: update.postCheckUnitIds must be an array`);
  }

  if ("packageName" in update && update.packageName != null && typeof update.packageName !== "string") {
    addError(`${filePath}: update.packageName must be a string`);
  }

  if (String(update.kind || "") === "npm_global_package" && !String(update.packageName || "").trim()) {
    addError(`${filePath}: npm_global_package requires update.packageName`);
  }
}

function validateExtensionManifest(filePath, allowedTypes, directoryLabel) {
  checked += 1;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    addError(`${filePath}: JSON parse failed: ${error.message}`);
    return;
  }

  for (const field of requiredExtensionFields) {
    if (!(field in manifest)) {
      addError(`${filePath}: missing extension field '${field}'`);
    }
  }

  const id = String(manifest.id || "");
  if (!id) {
    addError(`${filePath}: id must not be empty`);
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    addError(`${filePath}: invalid id '${id}'`);
  } else if (seenIds.has(id.toLowerCase())) {
    addError(`${filePath}: duplicate id '${id}'`);
  } else {
    seenIds.add(id.toLowerCase());
  }

  const type = String(manifest.type || "");
  if (!allowedTypes.includes(type)) {
    addError(`${filePath}: type '${type}' is invalid for ${directoryLabel}; expected ${allowedTypes.join(", ")}`);
  }

  if (manifest.enabled === false) {
    disabled += 1;
    addWarning(`${path.basename(filePath)}: extension disabled; runtime activation will be skipped`);
    return;
  }
  enabled += 1;

  if (typeof manifest.optional !== "boolean") {
    addError(`${filePath}: optional must be a boolean`);
  }

  if (String(manifest.compatibility?.protocol || "") !== extensionProtocolId) {
    addError(`${filePath}: compatibility.protocol '${String(manifest.compatibility?.protocol || "")}' does not match '${extensionProtocolId}'`);
  }

  if (!String(manifest.compatibility?.suite || "")) {
    addError(`${filePath}: compatibility.suite must not be empty`);
  }

  for (const field of ["displayName", "version", "category", "installState", "source", "description"]) {
    if (!String(manifest[field] || "")) {
      addError(`${filePath}: ${field} must not be empty`);
    }
  }

  const installState = String(manifest.installState || "");
  if (!["bundled", "external", "configured", "missing"].includes(installState)) {
    addError(`${filePath}: unsupported installState '${installState}'`);
  }

  const source = String(manifest.source || "");
  if (source && !isExternalSource(source)) {
    const expandedSource = expandManifestSource(source);
    if (installState === "bundled" && !fs.existsSync(expandedSource)) {
      addError(`${filePath}: bundled source does not exist: ${expandedSource}`);
    } else if (!fs.existsSync(expandedSource)) {
      addWarning(`${path.basename(filePath)}: source is not currently accessible: ${expandedSource}`);
    }
  }

  if (["http", "stdio"].includes(type)) {
    if (!String(manifest.launcher || "")) {
      addError(`${filePath}: MCP manifest must declare launcher`);
    }
    if (type === "http" && !String(manifest.healthCheck?.url || "")) {
      addError(`${filePath}: HTTP MCP manifest must declare healthCheck.url`);
    }
    if (type === "http" && String(manifest.healthCheck?.kind || "") === "mcp-http-resource") {
      if (!String(manifest.healthCheck?.resourceUri || "")) {
        addError(`${filePath}: mcp-http-resource healthCheck must declare resourceUri`);
      }
      if (!String(manifest.healthCheck?.successRegex || "")) {
        addError(`${filePath}: mcp-http-resource healthCheck must declare successRegex`);
      }
      if (!String(manifest.healthCheck?.failureRegex || "")) {
        addError(`${filePath}: mcp-http-resource healthCheck must declare failureRegex`);
      }
    }
  }

  if (type === "skill") {
    const expandedSkillSource = expandManifestSource(String(manifest.source || ""));
    if (!fs.existsSync(path.join(expandedSkillSource, "SKILL.md"))) {
      addError(`${filePath}: skill source is missing SKILL.md: ${expandedSkillSource}`);
    }
  }

  validateUpdateBlock(manifest, filePath);
}

function validateRuntimeManifest(filePath) {
  checked += 1;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    addError(`${filePath}: JSON parse failed: ${error.message}`);
    return;
  }

  for (const field of requiredRuntimeFields) {
    if (!(field in manifest)) {
      addError(`${filePath}: missing runtime field '${field}'`);
    }
  }

  if (manifest.enabled === false) {
    disabled += 1;
  } else {
    enabled += 1;
  }

  for (const field of ["displayName", "kind", "category", "installState", "source", "cwd", "description"]) {
    if (!String(manifest[field] || "")) {
      addError(`${filePath}: runtime.${field} must not be empty`);
    }
  }

  validateUpdateBlock(manifest, filePath);
}

for (const dir of knownDirs) {
  if (!fs.existsSync(dir.path)) {
    if (dir.required) addError(`manifest directory does not exist: ${dir.path}`);
    continue;
  }
  for (const entry of fs.readdirSync(dir.path).filter((name) => name.endsWith(".json")).sort()) {
    validateExtensionManifest(path.join(dir.path, entry), dir.types, dir.label);
  }
}

if (!fs.existsSync(runtimeDir)) {
  addError(`runtime manifest directory does not exist: ${runtimeDir}`);
} else {
  for (const entry of fs.readdirSync(runtimeDir).filter((name) => name.endsWith(".json")).sort()) {
    validateRuntimeManifest(path.join(runtimeDir, entry));
  }
}

for (const warning of warnings) {
  console.warn(warning);
}

if (errors.length > 0) {
  console.error(`Manifest validation failed with ${errors.length} error(s).`);
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

if (strict && warnings.length > 0) {
  console.error(`Strict manifest validation failed with ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`extension manifest protocol: ${extensionProtocolId} | runtime protocol: ${runtimeProtocolId} | suite ${suiteVersion}`);
console.log(`extension/runtime manifests valid: checked=${checked} enabled=${enabled} disabled=${disabled} warnings=${warnings.length}`);
'@

$tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("cti-validate-manifests-" + [guid]::NewGuid().ToString("N") + ".cjs")
Set-Content -LiteralPath $tempScript -Value $nodeScript -Encoding UTF8
try {
    & node $tempScript
    exit $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}
