using System.Text.Json.Nodes;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class RuntimeUpdateSupportTests
{
    [Fact]
    public void ParseUpdateDefinition_ReadsDeclaredFields()
    {
        var root = JsonNode.Parse("""
        {
          "update": {
            "enabled": true,
            "surfaces": ["service", "extension"],
            "kind": "skill_git_repo",
            "packageName": "",
            "postCheckUnitIds": ["service.feishuCli", "service.bridge"],
            "sourceRootHint": "${SUITE_ROOT}\\packages\\bridge-runtime"
          }
        }
        """)!.AsObject();

        var update = RuntimeUpdateSupport.ParseUpdateDefinition(root);

        Assert.NotNull(update);
        Assert.True(update!.Enabled);
        Assert.Equal("skill_git_repo", update.Kind);
        Assert.Equal(["service", "extension"], update.Surfaces);
        Assert.Equal(["service.feishuCli", "service.bridge"], update.PostCheckUnitIds);
        Assert.Equal("${SUITE_ROOT}\\packages\\bridge-runtime", update.SourceRootHint);
    }

    [Fact]
    public void ParseRuntimeUnitManifest_ReadsUpdateBlock()
    {
        var root = JsonNode.Parse("""
        {
          "id": "service.codex",
          "displayName": "Codex CLI",
          "kind": "tool",
          "category": "codex",
          "enabled": true,
          "installState": "installed",
          "source": "%APPDATA%\\npm",
          "cwd": "%APPDATA%\\npm",
          "version": "",
          "description": "Codex CLI",
          "update": {
            "enabled": true,
            "surfaces": ["service"],
            "kind": "npm_global_package",
            "packageName": "@openai/codex",
            "postCheckUnitIds": ["service.codex"]
          }
        }
        """)!.AsObject();

        var manifest = RuntimeUpdateSupport.ParseRuntimeUnitManifest("C:\\suite\\config\\runtime.d\\service.codex.json", root);

        Assert.Equal("service.codex", manifest.Id);
        Assert.NotNull(manifest.Update);
        Assert.Equal("npm_global_package", manifest.Update!.Kind);
        Assert.Equal("@openai/codex", manifest.Update.PackageName);
    }

    [Fact]
    public void ResolveUpdatePlan_UsesNpmGlobalPackageTemplate()
    {
        var appData = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var npmRoot = Path.Combine(appData, "npm");
        Directory.CreateDirectory(Path.Combine(npmRoot, "node_modules", "@openai", "codex"));
        File.WriteAllText(Path.Combine(npmRoot, "codex.ps1"), "# shim");
        File.WriteAllText(Path.Combine(npmRoot, "node_modules", "@openai", "codex", "package.json"), "{}");

        var plan = RuntimeUpdateSupport.ResolveUpdatePlan(
            new UpdatePolicyDefinition(true, ["service"], "npm_global_package", "@openai/codex", ["service.codex"], ""),
            new UpdateResolutionInputs("service.codex", "Codex CLI", npmRoot, npmRoot, "", "", appData, ""));

        Assert.True(plan.CanUpdate);
        Assert.Equal("npm_global_package", plan.TemplateKind);
        var step = Assert.Single(plan.Steps);
        Assert.Equal("cmd.exe", step.FileName);
        Assert.Contains("npm install -g @openai/codex@latest", step.Arguments);
    }

    [Fact]
    public void ResolveUpdatePlan_UsesGitRepoTemplateForGitInstall()
    {
        var installRoot = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(installRoot, ".git"));

        var plan = RuntimeUpdateSupport.ResolveUpdatePlan(
            new UpdatePolicyDefinition(true, ["service", "extension"], "skill_git_repo", "", ["service.feishuCli"], ""),
            new UpdateResolutionInputs("service.feishuCli", "飞书 CLI", installRoot, installRoot, "", "", "", ""));

        Assert.True(plan.CanUpdate);
        Assert.Equal("skill_git_repo", plan.TemplateKind);
        Assert.Equal(3, plan.Steps.Length);
        Assert.Equal("git", plan.Steps[0].FileName);
        Assert.Equal("npm", plan.Steps[1].FileName);
        Assert.Equal("npm", plan.Steps[2].FileName);
    }

    [Fact]
    public void ResolveUpdatePlan_UsesCopyTemplateWhenInstallMetadataExists()
    {
        var installRoot = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var sourceRoot = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(installRoot);
        Directory.CreateDirectory(sourceRoot);
        Directory.CreateDirectory(Path.Combine(sourceRoot, "scripts"));
        File.WriteAllText(Path.Combine(sourceRoot, "scripts", "install-codex.sh"), "#!/usr/bin/env bash\n");
        File.WriteAllText(
            Path.Combine(installRoot, ".cti-install.json"),
            """
            {
              "protocol": "cti-install-metadata/v1",
              "installKind": "copy",
              "installedAt": "2026-05-22T10:00:00.000Z",
              "sourceRoot": "__SOURCE_ROOT__",
              "installScript": "__INSTALL_SCRIPT__"
            }
            """
            .Replace("__SOURCE_ROOT__", sourceRoot.Replace("\\", "\\\\"))
            .Replace("__INSTALL_SCRIPT__", Path.Combine(sourceRoot, "scripts", "install-codex.sh").Replace("\\", "\\\\")));

        var plan = RuntimeUpdateSupport.ResolveUpdatePlan(
            new UpdatePolicyDefinition(true, ["service"], "skill_git_repo", "", ["service.feishuCli"], sourceRoot),
            new UpdateResolutionInputs("service.feishuCli", "飞书 CLI", installRoot, installRoot, "", sourceRoot, "", ""));

        Assert.True(plan.CanUpdate);
        Assert.Equal("skill_codex_copy", plan.TemplateKind);
        Assert.Equal(2, plan.Steps.Length);
        Assert.Contains("Remove-Item", plan.Steps[0].Arguments);
        Assert.Equal("bash", plan.Steps[1].FileName);
    }

    [Fact]
    public void ResolveUpdatePlan_UsesSuiteLiveSyncForKnownLiveSkillRoot()
    {
        var userProfile = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var suiteRoot = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var liveRoot = Path.Combine(userProfile, ".codex", "skills", "claude-to-im");
        Directory.CreateDirectory(liveRoot);
        Directory.CreateDirectory(Path.Combine(suiteRoot, "scripts"));
        File.WriteAllText(Path.Combine(suiteRoot, "scripts", "sync-live-skill.ps1"), "Write-Host sync");

        var plan = RuntimeUpdateSupport.ResolveUpdatePlan(
            new UpdatePolicyDefinition(true, ["service"], "skill_git_repo", "", ["service.feishuCli"], Path.Combine(suiteRoot, "packages", "bridge-runtime")),
            new UpdateResolutionInputs("service.feishuCli", "飞书 CLI", liveRoot, liveRoot, suiteRoot, "", "", userProfile));

        Assert.True(plan.CanUpdate);
        Assert.Equal("suite_live_sync", plan.TemplateKind);
        var step = Assert.Single(plan.Steps);
        Assert.Equal("powershell.exe", step.FileName);
        Assert.Contains("sync-live-skill.ps1", step.Arguments);
    }

    [Fact]
    public void ResolveUpdatePlan_DisablesUnknownSkillSource()
    {
        var installRoot = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(installRoot);

        var plan = RuntimeUpdateSupport.ResolveUpdatePlan(
            new UpdatePolicyDefinition(true, ["service"], "skill_git_repo", "", ["service.feishuCli"], ""),
            new UpdateResolutionInputs("service.feishuCli", "飞书 CLI", installRoot, installRoot, "", "", "", ""));

        Assert.False(plan.CanUpdate);
        Assert.Contains("来源未知", plan.Reason);
    }
}
