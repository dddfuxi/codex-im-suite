using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class ConversationHistoryDisplayTests
{
    [Fact]
    public void ResolveSource_UsesRemoteHistoryWhenChatListDoesNotContainChat()
    {
        var source = ConversationHistoryDisplay.ResolveSource(
            isFeishu: true,
            remoteVisible: false,
            hasLocalBinding: true,
            remoteMessageCount: 1351);

        Assert.Equal("远端历史 + 本地绑定", source);
    }

    [Fact]
    public void ResolveSource_DoesNotClaimRemoteHistoryWhenNoHistoryCountExists()
    {
        var source = ConversationHistoryDisplay.ResolveSource(
            isFeishu: true,
            remoteVisible: false,
            hasLocalBinding: false,
            remoteMessageCount: 0);

        Assert.Equal("仅本地索引", source);
    }

    [Fact]
    public void ResolveRemoteLatestAt_ReadsFeishuUnixMilliseconds()
    {
        var latest = ConversationHistoryDisplay.ResolveRemoteLatestAt(new FeishuHistorySyncRecord
        {
            LatestMessageTime = "1780648140310",
            LastSyncAt = "2026-06-05T08:31:15Z",
        });

        Assert.NotNull(latest);
        Assert.True(latest!.Value.Year >= 2026);
    }

    [Fact]
    public void ResolveRecallState_AllowsOnlyKnownBotFeishuMessages()
    {
        var recall = ConversationHistoryDisplay.ResolveRecallState(
            channelType: "feishu",
            chatId: "oc_group",
            senderType: "app",
            messageId: "om_bot",
            outboundRefs:
            [
                new OutboundMessageRefRecord
                {
                    ChannelType = "feishu",
                    ChatId = "oc_group",
                    PlatformMessageId = "om_bot",
                    Purpose = "response"
                }
            ]);

        Assert.True(recall.CanRecall);
        Assert.Equal("none", recall.RecallStatus);
    }

    [Fact]
    public void ResolveRecallState_MarksRecalledAndRejectsUserMessages()
    {
        var refs = new[]
        {
            new OutboundMessageRefRecord
            {
                ChannelType = "feishu",
                ChatId = "oc_group",
                PlatformMessageId = "om_bot",
                RecalledAt = "2026-06-12T08:00:00Z"
            }
        };

        var botRecall = ConversationHistoryDisplay.ResolveRecallState("feishu", "oc_group", "app", "om_bot", refs);
        var userRecall = ConversationHistoryDisplay.ResolveRecallState("feishu", "oc_group", "user", "om_bot", refs);

        Assert.False(botRecall.CanRecall);
        Assert.Equal("recalled", botRecall.RecallStatus);
        Assert.False(userRecall.CanRecall);
        Assert.Equal("none", userRecall.RecallStatus);
    }

    [Fact]
    public void ResolveRecallState_RejectsOutboundRefsFromAnotherChat()
    {
        var recall = ConversationHistoryDisplay.ResolveRecallState(
            channelType: "feishu",
            chatId: "oc_target",
            senderType: "app",
            messageId: "om_bot",
            outboundRefs:
            [
                new OutboundMessageRefRecord
                {
                    ChannelType = "feishu",
                    ChatId = "oc_other",
                    PlatformMessageId = "om_bot"
                }
            ]);

        Assert.False(recall.CanRecall);
        Assert.Equal("none", recall.RecallStatus);
    }

    [Fact]
    public void ResolveRecallState_AllowsCurrentBotAppHistoryMessagesWithoutOutboundRef()
    {
        var recall = ConversationHistoryDisplay.ResolveRecallState(
            channelType: "feishu",
            chatId: "oc_group",
            senderType: "app",
            senderId: "cli_bot_app",
            messageId: "om_history_bot",
            outboundRefs: [],
            botAppIds: ["cli_bot_app"]);

        Assert.True(recall.CanRecall);
        Assert.Equal("none", recall.RecallStatus);
    }

    [Fact]
    public void ResolveRecallTarget_CreatesHistoryTargetForCurrentBotAppWithoutOutboundRef()
    {
        var target = ConversationHistoryDisplay.ResolveRecallTarget(
            channelType: "feishu",
            chatId: "oc_group",
            senderType: "app",
            senderId: "cli_bot_app",
            messageId: "om_history_bot",
            codepilotSessionId: "session-1",
            outboundRefs: [],
            botAppIds: ["cli_bot_app"]);

        Assert.NotNull(target);
        Assert.Equal("feishu", target!.ChannelType);
        Assert.Equal("oc_group", target.ChatId);
        Assert.Equal("om_history_bot", target.PlatformMessageId);
        Assert.Equal("session-1", target.CodepilotSessionId);
        Assert.Equal("history", target.Purpose);
    }

    [Fact]
    public void ResolveRecallState_RejectsOtherAppHistoryMessagesWithoutOutboundRef()
    {
        var recall = ConversationHistoryDisplay.ResolveRecallState(
            channelType: "feishu",
            chatId: "oc_group",
            senderType: "app",
            senderId: "cli_other_app",
            messageId: "om_history_other_app",
            outboundRefs: [],
            botAppIds: ["cli_bot_app"]);

        Assert.False(recall.CanRecall);
        Assert.Equal("none", recall.RecallStatus);
    }

    [Fact]
    public void ResolveMessageDisplay_ExtractsFeishuInteractiveCardContent()
    {
        const string rawCard = """
        {
          "header": {
            "title": { "tag": "plain_text", "content": "Run finished" }
          },
          "elements": [
            { "tag": "markdown", "content": "**Result**\nAll good" },
            {
              "tag": "action",
              "actions": [
                { "tag": "button", "text": { "tag": "plain_text", "content": "Open details" } }
              ]
            }
          ],
          "summary": { "content": "Fallback summary" }
        }
        """;

        var display = ConversationHistoryDisplay.ResolveMessageDisplay(
            msgType: "interactive",
            rawContent: rawCard,
            fallbackText: "[card message]");

        Assert.True(display.IsCard);
        Assert.Contains("Run finished", display.Text);
        Assert.Contains("**Result**", display.CardContent);
        Assert.Contains("All good", display.CardContent);
        Assert.Contains("Open details", display.CardContent);
        Assert.DoesNotContain("[card message]", display.Text);
    }

    [Fact]
    public void ResolveCardResourceReferences_ExtractsNestedInteractiveImageKeys()
    {
        const string rawCard = """
        {
          "title": "表情回复",
          "elements": [[
            { "tag": "img", "image_key": "img_v3_02ad_e19fca1f-912a-450e-95de-3c229091b53g" },
            { "tag": "text", "text": "请升级至最新版客户端，以查看内容" }
          ]]
        }
        """;

        var resources = ConversationHistoryDisplay.ResolveCardResourceReferences("interactive", rawCard);

        var image = Assert.Single(resources);
        Assert.Equal("image", image.Kind);
        Assert.Equal("img_v3_02ad_e19fca1f-912a-450e-95de-3c229091b53g", image.ResourceKey);
        Assert.EndsWith(".png", image.Name);
    }
}
