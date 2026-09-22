using System.Text.Json.Nodes;

namespace ClaudeToImControlPanel;

internal sealed record UpdatePolicyDefinition(
    bool Enabled,
    string[] Surfaces,
    string Kind,
    string PackageName,
    string[] PostCheckUnitIds,
    string SourceRootHint);

internal sealed record RuntimeUnitManifestDefinition(
    string ManifestPath,
    string Id,
    string DisplayName,
    string Kind,
    string Category,
    bool Enabled,
    string InstallState,
    string Source,
    string Cwd,
    string Version,
    string Description,
    UpdatePolicyDefinition? Update);

internal sealed record UpdateResolutionInputs(
    string UnitId,
    string DisplayName,
    string InstallRoot,
    string Source,
    string SuiteRoot,
    string SourceRootHint,
    string AppDataPath,
    string UserProfilePath);

internal sealed record UpdateCommandStep(
    string FileName,
    string Arguments,
    string WorkingDirectory,
    string Description);

internal sealed record ResolvedUpdatePlan(
    bool CanUpdate,
    string TemplateKind,
    string Reason,
    string SuccessHint,
    string[] PostCheckUnitIds,
    string EffectiveSourceRoot,
    UpdateCommandStep[] Steps);

internal sealed record SkillInstallMetadata(
    string Protocol,
    string InstallKind,
    string InstalledAt,
    string SourceRoot,
    string InstallScript);

internal sealed record SkillInstallProvenance(
    string TemplateKind,
    string Reason,
    string SourceRoot,
    string InstallScript);

internal static class RuntimeUpdateSupport
{
    private const string InstallMetadataFileName = ".cti-install.json";
    internal const string InstallMetadataProtocol = "cti-install-metadata/v1";

    public static UpdatePolicyDefinition? ParseUpdateDefinition(JsonObject root)
    {
        if (root["update"] is not JsonObject updateRoot)
        {
            return null;
        }

        return new UpdatePolicyDefinition(
            ReadBool(updateRoot, "enabled", true),
            ReadStringArray(updateRoot, "surfaces", ["service"]),
            ReadString(updateRoot, "kind"),
            ReadString(updateRoot, "packageName"),
            ReadStringArray(updateRoot, "postCheckUnitIds", []),
            ReadString(updateRoot, "sourceRootHint"));
    }

    public static RuntimeUnitManifestDefinition ParseRuntimeUnitManifest(string manifestPath, JsonObject root)
        => new(
            manifestPath,
            ReadString(root, "id"),
            ReadString(root, "displayName"),
            ReadString(root, "kind"),
            ReadString(root, "category"),
            ReadBool(root, "enabled", true),
            ReadString(root, "installState"),
            ReadString(root, "source"),
            ReadString(root, "cwd"),
            ReadString(root, "version"),
            ReadString(root, "description"),
            ParseUpdateDefinition(root));

    public static SkillInstallMetadata? ReadInstallMetadata(string installRoot)
    {
        if (string.IsNullOrWhiteSpace(installRoot))
        {
            return null;
        }

        var path = Path.Combine(installRoot, InstallMetadataFileName);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            if (root is null)
            {
                return null;
            }

            return new SkillInstallMetadata(
                ReadString(root, "protocol"),
                ReadString(root, "installKind"),
                ReadString(root, "installedAt"),
                ReadString(root, "sourceRoot"),
                ReadString(root, "installScript"));
        }
        catch
        {
            return null;
        }
    }

    public static ResolvedUpdatePlan ResolveUpdatePlan(UpdatePolicyDefinition policy, UpdateResolutionInputs input)
    {
        if (!policy.Enabled)
        {
            return Disabled(policy, "更新已禁用。");
        }

        return policy.Kind switch
        {
            "npm_global_package" => ResolveNpmGlobalPackage(policy, input),
            "skill_git_repo" or "skill_codex_copy" or "suite_live_sync" => ResolveManagedSkill(policy, input),
            _ => Disabled(policy, $"不支持的更新模板：{policy.Kind}")
        };
    }

    public static bool SupportsSurface(UpdatePolicyDefinition? policy, string surface)
        => policy is not null
            && policy.Enabled
            && policy.Surfaces.Any(item => string.Equals(item, surface, StringComparison.OrdinalIgnoreCase));

    private static ResolvedUpdatePlan ResolveNpmGlobalPackage(UpdatePolicyDefinition policy, UpdateResolutionInputs input)
    {
        var appData = FirstNonEmpty(input.AppDataPath, Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
        var npmRoot = Path.Combine(appData, "npm");
        var commandName = GetPackageCommandName(policy.PackageName);
        var shimPath = Path.Combine(npmRoot, $"{commandName}.ps1");
        var packagePath = Path.Combine(npmRoot, "node_modules", policy.PackageName.Replace('/', Path.DirectorySeparatorChar), "package.json");
        if (!File.Exists(shimPath) || !File.Exists(packagePath))
        {
            return Disabled(policy, $"{input.DisplayName} 当前来源不支持面板自动更新，仅支持 npm 全局安装。");
        }

        return new ResolvedUpdatePlan(
            true,
            "npm_global_package",
            "",
            "更新完成后已刷新 CLI 状态。",
            policy.PostCheckUnitIds,
            npmRoot,
            [
                new UpdateCommandStep(
                    "cmd.exe",
                    $"/c npm install -g {policy.PackageName}@latest",
                    npmRoot,
                    $"更新 {input.DisplayName}")
            ]);
    }

    private static ResolvedUpdatePlan ResolveManagedSkill(UpdatePolicyDefinition policy, UpdateResolutionInputs input)
    {
        var provenance = InferSkillInstallProvenance(input);
        if (provenance is null)
        {
            return Disabled(policy, $"{input.DisplayName} 来源未知，暂不支持自动更新。");
        }

        return provenance.TemplateKind switch
        {
            "skill_git_repo" => new ResolvedUpdatePlan(
                true,
                provenance.TemplateKind,
                provenance.Reason,
                "代码和依赖已更新；如 daemon 正在运行，请按需手动重启 bridge。",
                policy.PostCheckUnitIds,
                provenance.SourceRoot,
                [
                    new UpdateCommandStep("git", "pull", provenance.SourceRoot, "拉取最新代码"),
                    new UpdateCommandStep("npm", "install", provenance.SourceRoot, "安装依赖"),
                    new UpdateCommandStep("npm", "run build", provenance.SourceRoot, "构建 Skill")
                ]),
            "skill_codex_copy" => new ResolvedUpdatePlan(
                true,
                provenance.TemplateKind,
                provenance.Reason,
                "复制版 Skill 已重装；如 daemon 正在运行，请按需手动重启 bridge。",
                policy.PostCheckUnitIds,
                provenance.SourceRoot,
                [
                    new UpdateCommandStep(
                        "powershell.exe",
                        $"-NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"if (Test-Path -LiteralPath '{EscapePowerShellSingleQuoted(input.InstallRoot)}') {{ Remove-Item -LiteralPath '{EscapePowerShellSingleQuoted(input.InstallRoot)}' -Recurse -Force }}\"",
                        provenance.SourceRoot,
                        "删除旧复制版 Skill"),
                    new UpdateCommandStep(
                        "bash",
                        $"\"{provenance.InstallScript}\"",
                        provenance.SourceRoot,
                        "重新执行 install-codex.sh")
                ]),
            "suite_live_sync" => ResolveSuiteLiveSync(policy, input, provenance),
            _ => Disabled(policy, $"{input.DisplayName} 来源未知，暂不支持自动更新。")
        };
    }

    private static ResolvedUpdatePlan ResolveSuiteLiveSync(UpdatePolicyDefinition policy, UpdateResolutionInputs input, SkillInstallProvenance provenance)
    {
        var suiteRoot = FirstNonEmpty(input.SuiteRoot, provenance.SourceRoot);
        var syncScript = Path.Combine(suiteRoot, "scripts", "sync-live-skill.ps1");
        if (!File.Exists(syncScript))
        {
            return Disabled(policy, "未找到 suite -> live 同步脚本，不能自动更新运行版。");
        }

        return new ResolvedUpdatePlan(
            true,
            "suite_live_sync",
            provenance.Reason,
            "已完成 suite -> live 同步；如需重新加载 daemon，请单独重启 bridge。",
            policy.PostCheckUnitIds,
            suiteRoot,
            [
                new UpdateCommandStep(
                    "powershell.exe",
                    $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{syncScript}\"",
                    suiteRoot,
                    "同步 suite 到 live skill")
            ]);
    }

    private static SkillInstallProvenance? InferSkillInstallProvenance(UpdateResolutionInputs input)
    {
        var installRoot = FirstNonEmpty(input.InstallRoot, input.Source);
        if (string.IsNullOrWhiteSpace(installRoot) || !Directory.Exists(installRoot))
        {
            return null;
        }

        var normalizedInstallRoot = Path.GetFullPath(installRoot);
        var userProfile = FirstNonEmpty(input.UserProfilePath, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        var knownLiveRoot = string.IsNullOrWhiteSpace(userProfile)
            ? ""
            : Path.Combine(userProfile, ".codex", "skills", "claude-to-im");
        if (!string.IsNullOrWhiteSpace(knownLiveRoot)
            && PathsEqual(normalizedInstallRoot, knownLiveRoot)
            && !string.IsNullOrWhiteSpace(input.SuiteRoot)
            && Directory.Exists(input.SuiteRoot))
        {
            return new SkillInstallProvenance("suite_live_sync", "当前是 live 运行副本。", input.SuiteRoot, "");
        }

        if (Directory.Exists(Path.Combine(normalizedInstallRoot, ".git")))
        {
            return new SkillInstallProvenance("skill_git_repo", "当前安装目录本身是 Git 仓库。", normalizedInstallRoot, "");
        }

        var metadata = ReadInstallMetadata(normalizedInstallRoot);
        if (metadata is not null
            && string.Equals(metadata.Protocol, InstallMetadataProtocol, StringComparison.OrdinalIgnoreCase)
            && string.Equals(metadata.InstallKind, "copy", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(metadata.SourceRoot)
            && Directory.Exists(metadata.SourceRoot)
            && !string.IsNullOrWhiteSpace(metadata.InstallScript)
            && File.Exists(metadata.InstallScript))
        {
            return new SkillInstallProvenance("skill_codex_copy", "检测到 install-codex.sh 复制安装元数据。", metadata.SourceRoot, metadata.InstallScript);
        }

        var sourceHint = input.SourceRootHint;
        if (!string.IsNullOrWhiteSpace(sourceHint) && Directory.Exists(sourceHint))
        {
            if (Directory.Exists(Path.Combine(sourceHint, ".git")))
            {
                return new SkillInstallProvenance("skill_git_repo", "使用 sourceRootHint 定位到 Git 源目录。", sourceHint, "");
            }

            var installScript = Path.Combine(sourceHint, "scripts", "install-codex.sh");
            if (File.Exists(installScript))
            {
                return new SkillInstallProvenance("skill_codex_copy", "使用 sourceRootHint 定位到复制安装源目录。", sourceHint, installScript);
            }
        }

        return null;
    }

    private static ResolvedUpdatePlan Disabled(UpdatePolicyDefinition policy, string reason)
        => new(false, "", reason, "", policy.PostCheckUnitIds, "", []);

    private static string GetPackageCommandName(string packageName)
    {
        var trimmed = (packageName ?? "").Trim();
        if (trimmed.Contains('/'))
        {
            trimmed = trimmed[(trimmed.LastIndexOf('/') + 1)..];
        }
        return trimmed;
    }

    private static string[] ReadStringArray(JsonObject root, string propertyName, string[] fallback)
    {
        if (root[propertyName] is not JsonArray array)
        {
            return fallback;
        }

        return array
            .Select(item => item?.GetValue<string>()?.Trim())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Cast<string>()
            .ToArray();
    }

    private static bool ReadBool(JsonObject root, string propertyName, bool fallback)
        => root[propertyName]?.GetValue<bool?>() ?? fallback;

    private static string ReadString(JsonObject root, string propertyName)
        => root[propertyName]?.GetValue<string?>()?.Trim() ?? "";

    private static string FirstNonEmpty(params string[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";

    private static bool PathsEqual(string left, string right)
        => string.Equals(
            Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase);

    private static string EscapePowerShellSingleQuoted(string value)
        => (value ?? "").Replace("'", "''", StringComparison.Ordinal);
}
