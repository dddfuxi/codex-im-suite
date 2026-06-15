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

        var botRecall = ConversationHistoryDisplay.ResolveRecallState("feishu", "app", "om_bot", refs);
        var userRecall = ConversationHistoryDisplay.ResolveRecallState("feishu", "user", "om_bot", refs);

        Assert.False(botRecall.CanRecall);
        Assert.Equal("recalled", botRecall.RecallStatus);
        Assert.False(userRecall.CanRecall);
        Assert.Equal("none", userRecall.RecallStatus);
    }
}
