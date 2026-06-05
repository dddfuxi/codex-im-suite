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
}
