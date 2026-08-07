using System.Reflection;
using System.Text;
using System.Text.Json;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class ControlApiContractTests
{
    [Fact]
    public void ControlApiDtos_AlignWithSharedJsonSchema()
    {
        var assembly = typeof(ClaudeToImControlPanel.RuntimeUpdateSupport).Assembly;
        var panelStateType = assembly.GetType("ClaudeToImControlPanel.ControlPanelStateContract");
        var commandType = assembly.GetType("ClaudeToImControlPanel.ControlCommandRequest");
        var resultType = assembly.GetType("ClaudeToImControlPanel.ControlCommandResult");
        var runtimeUnitType = assembly.GetType("ClaudeToImControlPanel.RuntimeUnitContract");
        var projectRegistryType = assembly.GetType("ClaudeToImControlPanel.ProjectRegistrySnapshotContract");
        var agentPanelStateType = assembly.GetType("ClaudeToImControlPanel.AgentCollaborationPanelStateContract");
        var agentManifestType = assembly.GetType("ClaudeToImControlPanel.CollaborationAgentManifestContract");
        var agentWorkerType = assembly.GetType("ClaudeToImControlPanel.AgentWorkerViewContract");
        var agentResponsibilityType = assembly.GetType("ClaudeToImControlPanel.AgentResponsibilityViewContract");
        var agentMetricsType = assembly.GetType("ClaudeToImControlPanel.AgentCollaborationMetricsViewContract");
        var speechPanelType = assembly.GetType("ClaudeToImControlPanel.SpeechPanelStateContract");
        var speechStatusType = assembly.GetType("ClaudeToImControlPanel.SpeechStatusContract");
        var speechSettingsType = assembly.GetType("ClaudeToImControlPanel.SpeechSettingsContract");
        var speechOptionType = assembly.GetType("ClaudeToImControlPanel.SpeechSelectionOptionContract");
        var speechSelectionType = assembly.GetType("ClaudeToImControlPanel.SpeechSelectionContract");
        var speechChannelType = assembly.GetType("ClaudeToImControlPanel.SpeechChannelContract");
        var speechCapabilityType = assembly.GetType("ClaudeToImControlPanel.SpeechCapabilityContract");
        var speechComponentType = assembly.GetType("ClaudeToImControlPanel.SpeechComponentContract");
        var speechVoiceType = assembly.GetType("ClaudeToImControlPanel.SpeechVoiceProfileContract");
        var speechLimitsType = assembly.GetType("ClaudeToImControlPanel.SpeechLimitsContract");
        var speechActionType = assembly.GetType("ClaudeToImControlPanel.SpeechActionContract");

        Assert.NotNull(panelStateType);
        Assert.NotNull(commandType);
        Assert.NotNull(resultType);
        Assert.NotNull(runtimeUnitType);
        Assert.NotNull(projectRegistryType);
        Assert.NotNull(agentPanelStateType);
        Assert.NotNull(agentManifestType);
        Assert.NotNull(agentWorkerType);
        Assert.NotNull(agentResponsibilityType);
        Assert.NotNull(agentMetricsType);
        Assert.NotNull(speechPanelType);
        Assert.NotNull(speechStatusType);
        Assert.NotNull(speechSettingsType);
        Assert.NotNull(speechOptionType);
        Assert.NotNull(speechSelectionType);
        Assert.NotNull(speechChannelType);
        Assert.NotNull(speechCapabilityType);
        Assert.NotNull(speechComponentType);
        Assert.NotNull(speechVoiceType);
        Assert.NotNull(speechLimitsType);
        Assert.NotNull(speechActionType);

        var schemaPath = Path.Combine(FindRepositoryRoot(), "packages", "contracts", "schemas", "control-api.schema.json");
        Assert.True(File.Exists(schemaPath), $"共享协议 schema 不存在：{schemaPath}");

        using var schema = JsonDocument.Parse(File.ReadAllText(schemaPath, Encoding.UTF8));
        var definitions = schema.RootElement.GetProperty("$defs");
        AssertDtoProperties(panelStateType!, definitions.GetProperty("ControlPanelStateContract"));
        AssertDtoProperties(commandType!, definitions.GetProperty("ControlCommandRequest"));
        AssertDtoProperties(resultType!, definitions.GetProperty("ControlCommandResult"));
        AssertDtoProperties(runtimeUnitType!, definitions.GetProperty("RuntimeUnitContract"));
        AssertDtoProperties(projectRegistryType!, definitions.GetProperty("ProjectRegistrySnapshotContract"));

        var agentSchemaPath = Path.Combine(FindRepositoryRoot(), "packages", "contracts", "schemas", "agent-collaboration.schema.json");
        Assert.True(File.Exists(agentSchemaPath), $"Agent 协作 schema 不存在：{agentSchemaPath}");
        using var agentSchema = JsonDocument.Parse(File.ReadAllText(agentSchemaPath, Encoding.UTF8));
        var agentDefinitions = agentSchema.RootElement.GetProperty("$defs");
        AssertDtoProperties(agentPanelStateType!, agentDefinitions.GetProperty("AgentCollaborationPanelState"));
        AssertDtoProperties(agentManifestType!, agentDefinitions.GetProperty("CollaborationAgentManifest"));
        AssertDtoProperties(agentWorkerType!, agentDefinitions.GetProperty("AgentWorkerView"));
        AssertDtoProperties(agentResponsibilityType!, agentDefinitions.GetProperty("AgentResponsibilityView"));
        AssertDtoProperties(agentMetricsType!, agentDefinitions.GetProperty("AgentCollaborationMetricsView"));

        var speechSchemaPath = Path.Combine(FindRepositoryRoot(), "packages", "contracts", "schemas", "speech.schema.json");
        Assert.True(File.Exists(speechSchemaPath), $"语音共享协议 schema 不存在：{speechSchemaPath}");
        using var speechSchema = JsonDocument.Parse(File.ReadAllText(speechSchemaPath, Encoding.UTF8));
        var speechDefinitions = speechSchema.RootElement.GetProperty("$defs");
        AssertDtoProperties(speechPanelType!, speechDefinitions.GetProperty("SpeechPanelStateContract"));
        AssertDtoProperties(speechStatusType!, speechDefinitions.GetProperty("SpeechStatusContract"));
        AssertDtoProperties(speechSettingsType!, speechDefinitions.GetProperty("SpeechSettingsContract"));
        AssertDtoProperties(speechOptionType!, speechDefinitions.GetProperty("SpeechSelectionOptionContract"));
        AssertDtoProperties(speechSelectionType!, speechDefinitions.GetProperty("SpeechSelectionContract"));
        AssertDtoProperties(speechChannelType!, speechDefinitions.GetProperty("SpeechChannelContract"));
        AssertDtoProperties(speechCapabilityType!, speechDefinitions.GetProperty("SpeechCapabilityContract"));
        AssertDtoProperties(speechComponentType!, speechDefinitions.GetProperty("SpeechComponentContract"));
        AssertDtoProperties(speechVoiceType!, speechDefinitions.GetProperty("SpeechVoiceProfileContract"));
        AssertDtoProperties(speechLimitsType!, speechDefinitions.GetProperty("SpeechLimitsContract"));
        AssertDtoProperties(speechActionType!, speechDefinitions.GetProperty("SpeechActionContract"));
    }

    private static void AssertDtoProperties(Type dtoType, JsonElement schema)
    {
        var serializerOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var dtoProperties = dtoType
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(property => serializerOptions.PropertyNamingPolicy!.ConvertName(property.Name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        var schemaProperties = schema.GetProperty("properties")
            .EnumerateObject()
            .Select(property => property.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(schemaProperties, dtoProperties);
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json"))
                && Directory.Exists(Path.Combine(directory.FullName, "packages", "contracts")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("无法定位 codex-im-suite 仓库根目录。");
    }
}
