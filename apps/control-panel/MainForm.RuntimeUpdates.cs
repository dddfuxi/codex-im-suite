using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeToImControlPanel;

internal sealed partial class MainForm
{
    private Task<object?> InvokeRuntimeUnitActionAsync(string unitId, string actionId)
        => InvokeRuntimeUnitActionAsync(JsonSerializer.SerializeToElement(new
        {
            unitId,
            actionId
        }));

    private string RuntimeManifestDir => string.IsNullOrWhiteSpace(_suiteRoot)
        ? Path.Combine(_skillDir, "config", "runtime.d")
        : Path.Combine(_suiteRoot, "config", "runtime.d");

    private Dictionary<string, RuntimeUnitManifestDefinition> LoadRuntimeUnitManifestMap()
    {
        var manifests = new Dictionary<string, RuntimeUnitManifestDefinition>(StringComparer.OrdinalIgnoreCase);
        if (!Directory.Exists(RuntimeManifestDir))
        {
            return manifests;
        }

        foreach (var file in Directory.GetFiles(RuntimeManifestDir, "*.json").OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var root = JsonNode.Parse(File.ReadAllText(file, Encoding.UTF8)) as JsonObject;
                if (root is null) continue;
                var manifest = RuntimeUpdateSupport.ParseRuntimeUnitManifest(file, root);
                if (!string.IsNullOrWhiteSpace(manifest.Id))
                {
                    manifests[manifest.Id] = manifest;
                }
            }
            catch (Exception ex)
            {
                AddWebActivity("warning", "Runtime manifest 读取失败", $"{Path.GetFileName(file)}: {ex.Message}");
            }
        }

        return manifests;
    }

    private RuntimeUnitManifestDefinition GetRuntimeManifestOrFallback(
        Dictionary<string, RuntimeUnitManifestDefinition> manifests,
        string id,
        string displayName,
        string kind,
        string category,
        string installState,
        string source,
        string cwd,
        string version,
        string description)
    {
        if (manifests.TryGetValue(id, out var manifest))
        {
            return manifest;
        }

        return new RuntimeUnitManifestDefinition(
            "",
            id,
            displayName,
            kind,
            category,
            true,
            installState,
            source,
            cwd,
            version,
            description,
            null);
    }

    private ResolvedUpdatePlan? ResolveRuntimeUpdatePlan(RuntimeUnitManifestDefinition manifest)
    {
        if (!RuntimeUpdateSupport.SupportsSurface(manifest.Update, "service"))
        {
            return null;
        }

        var installRoot = ExpandManifestValue(string.IsNullOrWhiteSpace(manifest.Cwd) ? manifest.Source : manifest.Cwd);
        var source = ExpandManifestValue(manifest.Source);
        var sourceHint = ExpandManifestValue(manifest.Update?.SourceRootHint ?? "");
        var plan = RuntimeUpdateSupport.ResolveUpdatePlan(
            manifest.Update!,
            new UpdateResolutionInputs(
                manifest.Id,
                manifest.DisplayName,
                installRoot,
                source,
                _suiteRoot,
                sourceHint,
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
        return ApplyUpdateAvailabilityProbe(plan, installRoot, sourceHint, manifest.Update?.PackageName ?? "");
    }

    private ResolvedUpdatePlan? ResolveManifestUpdatePlan(string manifestPath, string installRoot, string source)
    {
        if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
        {
            return null;
        }

        JsonObject root;
        try
        {
            root = LoadManifestNode(manifestPath);
        }
        catch
        {
            return null;
        }

        var update = RuntimeUpdateSupport.ParseUpdateDefinition(root);
        if (!RuntimeUpdateSupport.SupportsSurface(update, "extension"))
        {
            return null;
        }

        var plan = RuntimeUpdateSupport.ResolveUpdatePlan(
            update!,
            new UpdateResolutionInputs(
                $"extension.{manifestPath}",
                root["displayName"]?.GetValue<string?>()?.Trim() ?? "",
                installRoot,
                source,
                _suiteRoot,
                ExpandManifestValue(update!.SourceRootHint),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
        return ApplyUpdateAvailabilityProbe(plan, installRoot, ExpandManifestValue(update.SourceRootHint), update.PackageName);
    }

    private RuntimeUnitContract BuildCodexRuntimeUnit(RuntimeUnitManifestDefinition manifest)
    {
        var updatePlan = ResolveRuntimeUpdatePlan(manifest);
        var version = ResolveRuntimeVersion(
            manifest,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "node_modules", "@openai", "codex"));
        return new RuntimeUnitContract(
            manifest.Id,
            manifest.Id,
            manifest.DisplayName,
            manifest.Kind,
            manifest.Category,
            ClassifyStatus("codex", _codexStatus.Text),
            _codexStatus.Text,
            manifest.Enabled,
            manifest.InstallState,
            ExpandManifestValue(manifest.Source),
            ExpandManifestValue(manifest.Cwd),
            version,
            manifest.Description,
            false,
            [
                new RuntimeActionContract("check", "检查", true),
                new RuntimeActionContract("update", "更新", updatePlan?.CanUpdate == true, updatePlan?.Reason ?? ""),
                new RuntimeActionContract("openLocation", "打开位置", true)
            ]);
    }

    private RuntimeUnitContract BuildBridgeRuntimeUnit(RuntimeUnitManifestDefinition manifest)
    {
        var version = ResolveRuntimeVersion(manifest, _skillDir);
        return new(
            manifest.Id,
            manifest.Id,
            manifest.DisplayName,
            manifest.Kind,
            manifest.Category,
            ClassifyStatus("bridge", _bridgeStatus.Text),
            _bridgeStatus.Text,
            manifest.Enabled,
            manifest.InstallState,
            ExpandManifestValue(manifest.Source),
            ExpandManifestValue(manifest.Cwd),
            version,
            manifest.Description,
            false,
            [
                new RuntimeActionContract("status", "状态", true),
                new RuntimeActionContract("logs", "日志", true),
                new RuntimeActionContract("start", "启动", true),
                new RuntimeActionContract("stop", "停止", true),
                new RuntimeActionContract("restart", "重启", true),
                new RuntimeActionContract("openLocation", "打开位置", true)
            ]);
    }

    private RuntimeUnitContract BuildLocalLlmRuntimeUnit(RuntimeUnitManifestDefinition manifest)
    {
        var version = ResolveRuntimeVersion(manifest, _skillDir);
        return new(
            manifest.Id,
            manifest.Id,
            manifest.DisplayName,
            manifest.Kind,
            manifest.Category,
            ClassifyStatus("localLlm", _localLlmStatus.Text),
            _localLlmStatus.Text,
            manifest.Enabled,
            File.Exists(_localLlmStartScript) ? manifest.InstallState : "missing",
            ExpandManifestValue(manifest.Source),
            ExpandManifestValue(manifest.Cwd),
            version,
            manifest.Description,
            false,
            [
                new RuntimeActionContract("check", "检查", true),
                new RuntimeActionContract("start", "启动", File.Exists(_localLlmStartScript)),
                new RuntimeActionContract("stop", "停止", File.Exists(_localLlmStopScript)),
                new RuntimeActionContract("openLocation", "打开位置", true)
            ]);
    }

    private RuntimeUnitContract BuildManagedToolRuntimeUnit(RuntimeUnitManifestDefinition manifest)
    {
        var updatePlan = ResolveRuntimeUpdatePlan(manifest);
        var installRoot = ExpandManifestValue(string.IsNullOrWhiteSpace(manifest.Cwd) ? manifest.Source : manifest.Cwd);
        var packageRoot = ResolveManagedToolPackageRoot(manifest, installRoot);
        var version = ResolveRuntimeVersion(manifest, packageRoot, installRoot);
        var detail = BuildManagedToolDetail(manifest, installRoot, version, updatePlan);
        var status = ClassifyManagedToolStatus(installRoot, updatePlan);
        return new RuntimeUnitContract(
            manifest.Id,
            manifest.Id,
            manifest.DisplayName,
            manifest.Kind,
            manifest.Category,
            status,
            detail,
            manifest.Enabled,
            manifest.InstallState,
            ExpandManifestValue(manifest.Source),
            installRoot,
            version,
            manifest.Description,
            false,
            [
                new RuntimeActionContract("check", "检查", true),
                new RuntimeActionContract("update", "更新", updatePlan?.CanUpdate == true, updatePlan?.Reason ?? ""),
                new RuntimeActionContract("openLocation", "打开位置", Directory.Exists(installRoot))
            ]);
    }

    private string BuildManagedToolDetail(
        RuntimeUnitManifestDefinition manifest,
        string installRoot,
        string version,
        ResolvedUpdatePlan? updatePlan,
        string? runtimeProbe = null)
    {
        var lines = new List<string>
        {
            Directory.Exists(installRoot) ? $"已检测到 {manifest.DisplayName} 安装目录。" : $"未检测到 {manifest.DisplayName} 安装目录。",
            $"版本: {FormatRuntimeVersionLabel(version)}",
            $"路径: {installRoot}"
        };

        if (!string.IsNullOrWhiteSpace(runtimeProbe))
        {
            lines.Add(runtimeProbe.Trim());
        }

        if (updatePlan is null)
        {
            lines.Add("当前未声明 update 策略。");
        }
        else if (updatePlan.CanUpdate)
        {
            lines.Add($"更新模板: {updatePlan.TemplateKind}");
            if (!string.IsNullOrWhiteSpace(updatePlan.Reason))
            {
                lines.Add($"来源判断: {updatePlan.Reason}");
            }
            lines.Add(updatePlan.SuccessHint);
        }
        else
        {
            lines.Add(updatePlan.Reason);
        }

        return string.Join(Environment.NewLine, lines);
    }

    private static string ResolveManagedToolPackageRoot(RuntimeUnitManifestDefinition manifest, string installRoot)
    {
        var packageName = manifest.Update?.PackageName?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(packageName)) return installRoot;
        return Path.Combine(
            installRoot,
            "node_modules",
            packageName.Replace('/', Path.DirectorySeparatorChar));
    }

    private async Task RunUpdatePlanAsync(ResolvedUpdatePlan plan)
    {
        if (ShouldAutoRelaunchAfterUpdate(plan))
        {
            ScheduleControlPanelRelaunchAfterCurrentExit();
            AddWebActivity("info", "控制面板将自动重启", "本次更新会替换 live 面板文件，更新完成后将自动重新打开。");
        }

        foreach (var step in plan.Steps)
        {
            var result = await RunProcessAsync(step.FileName, step.Arguments, step.WorkingDirectory, timeoutMs: 300000);
            AppendCommand(step.Description, result);
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException(FirstNonEmptyLine(result.Stderr) ?? FirstNonEmptyLine(result.Stdout) ?? $"更新步骤失败：{step.Description}");
            }
        }

        foreach (var unitId in plan.PostCheckUnitIds)
        {
            await RunPostUpdateCheckAsync(unitId);
        }
    }

    private async Task RunPostUpdateCheckAsync(string unitId)
    {
        if (string.IsNullOrWhiteSpace(unitId))
        {
            return;
        }

        switch (unitId)
        {
            case "service.codex":
                await CheckCodexAsync(true);
                return;
            case "service.bridge":
                await CheckBridgeAsync();
                return;
            case "service.localLlm":
                await CheckLocalLlmAsync(true);
                return;
        }
    }

    private string ResolveRuntimeVersion(RuntimeUnitManifestDefinition manifest, params string[] packageCandidates)
    {
        if (!string.IsNullOrWhiteSpace(manifest.Version))
        {
            return manifest.Version.Trim();
        }

        foreach (var candidate in packageCandidates)
        {
            var version = TryReadPackageVersion(candidate);
            if (!string.IsNullOrWhiteSpace(version))
            {
                return version;
            }
        }

        return "";
    }

    private static string TryReadPackageVersion(string pathOrDirectory)
    {
        if (string.IsNullOrWhiteSpace(pathOrDirectory))
        {
            return "";
        }

        try
        {
            var packageJsonPath = pathOrDirectory;
            if (Directory.Exists(pathOrDirectory))
            {
                packageJsonPath = Path.Combine(pathOrDirectory, "package.json");
            }

            if (!File.Exists(packageJsonPath))
            {
                return "";
            }

            var root = JsonNode.Parse(File.ReadAllText(packageJsonPath, Encoding.UTF8)) as JsonObject;
            return root?["version"]?.GetValue<string?>()?.Trim() ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static string FormatRuntimeVersionLabel(string version)
        => string.IsNullOrWhiteSpace(version)
            ? "未标注版本"
            : $"v{version.Trim()}";

    private static string ClassifyManagedToolStatus(string installRoot, ResolvedUpdatePlan? updatePlan)
    {
        if (!Directory.Exists(installRoot))
        {
            return "error";
        }

        if (updatePlan is null)
        {
            return "warning";
        }

        if (updatePlan.CanUpdate)
        {
            return "ok";
        }

        var reason = updatePlan.Reason ?? "";
        if (reason.Contains("已同步", StringComparison.OrdinalIgnoreCase)
            || reason.Contains("已是最新版本", StringComparison.OrdinalIgnoreCase)
            || reason.Contains("无需更新", StringComparison.OrdinalIgnoreCase))
        {
            return "ok";
        }

        return "warning";
    }

    private ResolvedUpdatePlan ApplyUpdateAvailabilityProbe(ResolvedUpdatePlan plan, string installRoot, string sourceRootHint, string packageName)
    {
        if (!plan.CanUpdate)
        {
            return plan;
        }

        return plan.TemplateKind switch
        {
            "npm_global_package" => ProbeNpmGlobalPackageUpdate(plan, packageName),
            "skill_git_repo" => ProbeGitRepoUpdate(plan),
            "skill_codex_copy" => ProbeCopyInstallUpdate(plan, installRoot),
            "suite_live_sync" => ProbeSuiteLiveSyncUpdate(plan),
            _ => plan,
        };
    }

    private ResolvedUpdatePlan ProbeNpmGlobalPackageUpdate(ResolvedUpdatePlan plan, string packageName)
    {
        if (string.IsNullOrWhiteSpace(packageName))
        {
            return plan with { CanUpdate = false, Reason = "缺少 packageName，无法判断是否有新版本。" };
        }

        var packageRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "npm",
            "node_modules",
            packageName.Replace('/', Path.DirectorySeparatorChar));
        var currentVersion = TryReadPackageVersion(packageRoot);
        if (string.IsNullOrWhiteSpace(currentVersion))
        {
            return plan with { CanUpdate = false, Reason = "未找到当前已安装版本，无法判断是否需要更新。" };
        }

        var latestResult = RunQuickProcess("cmd.exe", $"/c npm view {packageName} version", plan.EffectiveSourceRoot, 15000);
        var latestVersion = FirstNonEmptyLineValue(latestResult.Stdout);
        if (latestResult.ExitCode != 0 || string.IsNullOrWhiteSpace(latestVersion))
        {
            return plan with { CanUpdate = false, Reason = $"无法确认 {packageName} 最新版本，已阻止盲目更新。" };
        }

        if (string.Equals(currentVersion, latestVersion, StringComparison.OrdinalIgnoreCase))
        {
            return plan with { CanUpdate = false, Reason = $"已是最新版本 {FormatRuntimeVersionLabel(currentVersion)}。" };
        }

        return plan with { Reason = $"当前 {FormatRuntimeVersionLabel(currentVersion)}，可更新到 {FormatRuntimeVersionLabel(latestVersion)}。" };
    }

    private ResolvedUpdatePlan ProbeGitRepoUpdate(ResolvedUpdatePlan plan)
    {
        var repoRoot = plan.EffectiveSourceRoot;
        if (string.IsNullOrWhiteSpace(repoRoot) || !Directory.Exists(repoRoot))
        {
            return plan with { CanUpdate = false, Reason = "未找到 Git 源目录，无法判断是否有新提交。" };
        }

        var branchResult = RunQuickProcess("git", "rev-parse --abbrev-ref HEAD", repoRoot);
        var branch = FirstNonEmptyLineValue(branchResult.Stdout);
        var localResult = RunQuickProcess("git", "rev-parse --short HEAD", repoRoot);
        var localHead = FirstNonEmptyLineValue(localResult.Stdout);
        if (branchResult.ExitCode != 0 || localResult.ExitCode != 0 || string.IsNullOrWhiteSpace(branch) || string.IsNullOrWhiteSpace(localHead))
        {
            return plan with { CanUpdate = false, Reason = "无法读取当前 Git 提交，已阻止盲目更新。" };
        }

        var remoteResult = RunQuickProcess("git", $"ls-remote origin refs/heads/{branch}", repoRoot, 15000);
        var remoteLine = FirstNonEmptyLineValue(remoteResult.Stdout);
        if (remoteResult.ExitCode != 0 || string.IsNullOrWhiteSpace(remoteLine))
        {
            return plan with { CanUpdate = false, Reason = $"无法确认 origin/{branch} 是否有新提交，已阻止盲目更新。" };
        }

        var remoteHead = remoteLine.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        if (remoteHead.Length > 7)
        {
            remoteHead = remoteHead[..7];
        }

        if (string.Equals(localHead, remoteHead, StringComparison.OrdinalIgnoreCase))
        {
            return plan with { CanUpdate = false, Reason = $"已是最新提交 {localHead}。", };
        }

        return plan with { Reason = $"当前提交 {localHead}，远端 {remoteHead} 有更新。" };
    }

    private ResolvedUpdatePlan ProbeCopyInstallUpdate(ResolvedUpdatePlan plan, string installRoot)
    {
        var sourceRoot = plan.EffectiveSourceRoot;
        if (string.IsNullOrWhiteSpace(sourceRoot) || !Directory.Exists(sourceRoot) || string.IsNullOrWhiteSpace(installRoot) || !Directory.Exists(installRoot))
        {
            return plan with { CanUpdate = false, Reason = "无法定位复制安装的源目录或目标目录，已阻止盲目更新。" };
        }

        var sourceVersion = TryReadPackageVersion(sourceRoot);
        var installedVersion = TryReadPackageVersion(installRoot);
        if (!string.IsNullOrWhiteSpace(sourceVersion) && !string.IsNullOrWhiteSpace(installedVersion))
        {
            if (string.Equals(sourceVersion, installedVersion, StringComparison.OrdinalIgnoreCase)
                && !HasCopyInstallContentDrift(sourceRoot, installRoot))
            {
                return plan with { CanUpdate = false, Reason = $"已是最新版本 {FormatRuntimeVersionLabel(installedVersion)}。" };
            }

            return plan with { Reason = $"当前 {FormatRuntimeVersionLabel(installedVersion)}，源目录为 {FormatRuntimeVersionLabel(sourceVersion)}。" };
        }

        if (!HasCopyInstallContentDrift(sourceRoot, installRoot))
        {
            return plan with { CanUpdate = false, Reason = "源目录与复制安装内容一致，无需更新。" };
        }

        return plan with { Reason = "检测到源目录与复制安装内容不一致，可重新同步。" };
    }

    private ResolvedUpdatePlan ProbeSuiteLiveSyncUpdate(ResolvedUpdatePlan plan)
    {
        var suiteCommit = ReadCurrentSuiteCommitShort();
        var liveStatus = BuildLiveSyncStatus(suiteCommit);
        return liveStatus.Status switch
        {
            "current" => plan with { CanUpdate = false, Reason = liveStatus.Summary },
            "outdated" or "missing" => plan with { Reason = string.IsNullOrWhiteSpace(liveStatus.Detail) ? liveStatus.Summary : $"{liveStatus.Summary}；{liveStatus.Detail}" },
            _ => plan with { CanUpdate = false, Reason = string.IsNullOrWhiteSpace(liveStatus.Detail) ? liveStatus.Summary : liveStatus.Detail }
        };
    }

    private string ReadCurrentSuiteCommitShort()
    {
        if (string.IsNullOrWhiteSpace(_suiteRoot) || !Directory.Exists(_suiteRoot))
        {
            return "";
        }

        var result = RunQuickProcess("git", "rev-parse --short HEAD", _suiteRoot);
        return result.ExitCode == 0 ? FirstNonEmptyLineValue(result.Stdout) : "";
    }

    private static bool HasCopyInstallContentDrift(string sourceRoot, string installRoot)
    {
        foreach (var relativePath in new[] { "package.json", "package-lock.json", "SKILL.md", Path.Combine("dist", "daemon.mjs"), Path.Combine("scripts", "daemon.ps1") })
        {
            var sourcePath = Path.Combine(sourceRoot, relativePath);
            var targetPath = Path.Combine(installRoot, relativePath);
            if (!File.Exists(sourcePath) && !File.Exists(targetPath))
            {
                continue;
            }

            if (!File.Exists(sourcePath) || !File.Exists(targetPath))
            {
                return true;
            }

            if (!string.Equals(ComputeUpdateProbeSha256(sourcePath), ComputeUpdateProbeSha256(targetPath), StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static string ComputeUpdateProbeSha256(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var sha = System.Security.Cryptography.SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(stream));
    }

    private static ProcessResult RunQuickProcess(string fileName, string arguments, string workingDirectory, int timeoutMs = 10000)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = string.IsNullOrWhiteSpace(workingDirectory) ? AppContext.BaseDirectory : workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            }
        };

        process.Start();
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(true); } catch { }
            return new ProcessResult(-1, "", $"timeout after {timeoutMs}ms");
        }

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        return new ProcessResult(process.ExitCode, stdout, stderr);
    }

    private static string FirstNonEmptyLineValue(string value)
        => (value ?? "")
            .Replace("\r", "", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .FirstOrDefault(line => line.Length > 0) ?? "";

    private bool ShouldAutoRelaunchAfterUpdate(ResolvedUpdatePlan plan)
    {
        if (!string.Equals(plan.TemplateKind, "suite_live_sync", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var executablePath = GetOfficialControlPanelPath();
        if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
        {
            return false;
        }

        var livePanelDir = Path.Combine(_skillDir, "dist", "control-panel");
        return Directory.Exists(livePanelDir) && IsSameOrChildPath(executablePath, livePanelDir);
    }

    private void ScheduleControlPanelRelaunchAfterCurrentExit()
    {
        var executablePath = GetOfficialControlPanelPath();
        if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
        {
            return;
        }

        var workingDirectory = Path.GetDirectoryName(executablePath) ?? AppContext.BaseDirectory;
        var escapedExe = executablePath.Replace("'", "''");
        var escapedWorkingDirectory = workingDirectory.Replace("'", "''");
        var command = string.Join("; ", new[]
        {
            $"Wait-Process -Id {Environment.ProcessId} -ErrorAction SilentlyContinue",
            "Start-Sleep -Milliseconds 1500",
            $"Start-Process -FilePath '{escapedExe}' -WorkingDirectory '{escapedWorkingDirectory}'"
        });

        Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoLogo -NoProfile -WindowStyle Hidden -Command \"{command}\"",
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        });
    }
}
