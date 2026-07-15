using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class LarkCliGatewayTests
{
    [Fact]
    public void WithItems_PreservesPaginationWhenFilteredPageIsEmpty()
    {
        var source = new LarkCliPage<int>([1], true, "next-page");

        var filtered = source.WithItems<string>([]);

        Assert.Empty(filtered.Items);
        Assert.True(filtered.HasMore);
        Assert.Equal("next-page", filtered.PageToken);
    }

    [Fact]
    public async Task ProbeAsync_UsesOfficialVersionDoctorAndWhoAmI()
    {
        var calls = new List<string>();
        var gateway = new LarkCliGateway("bridge-live", (arguments, _, _) =>
        {
            calls.Add(string.Join(" ", arguments));
            var command = string.Join(" ", arguments);
            if (command.EndsWith("--version", StringComparison.Ordinal))
            {
                return Task.FromResult(new LarkCliExecutionResult(0, "lark-cli version 1.0.69", ""));
            }
            if (command.EndsWith("doctor", StringComparison.Ordinal))
            {
                return Task.FromResult(new LarkCliExecutionResult(0, "{\"ok\":true,\"checks\":[{\"name\":\"identity_ready\",\"status\":\"pass\",\"message\":\"ready\"}]}", ""));
            }
            return Task.FromResult(new LarkCliExecutionResult(0, "{\"ok\":true,\"identity\":\"bot\",\"tokenStatus\":\"ready\",\"available\":true}", ""));
        });

        var probe = await gateway.ProbeAsync();

        Assert.True(probe.Ready);
        Assert.Equal("1.0.69", probe.Version);
        Assert.Equal("bot", probe.Identity);
        Assert.Equal("ready", probe.TokenStatus);
        Assert.Equal(3, calls.Count);
        Assert.All(calls, call => Assert.StartsWith("--profile bridge-live ", call));
    }

    [Fact]
    public async Task ListChatsAsync_UsesBotIdentityProfileAndParsesOfficialEnvelope()
    {
        IReadOnlyList<string>? captured = null;
        var gateway = new LarkCliGateway("bridge-live", (arguments, _, _) =>
        {
            captured = arguments;
            return Task.FromResult(new LarkCliExecutionResult(0, """
            {
              "ok": true,
              "identity": "bot",
              "data": {
                "chats": [
                  { "chat_id": "oc_1", "chat_mode": "group", "name": "测试群" }
                ],
                "has_more": true,
                "page_token": "next"
              }
            }
            """, ""));
        });

        var page = await gateway.ListChatsAsync(50, "before");

        Assert.Equal(["--profile", "bridge-live", "im", "+chat-list", "--as", "bot", "--page-size", "50", "--page-token", "before", "--json"], captured);
        var chat = Assert.Single(page.Items);
        Assert.Equal("oc_1", chat.ChatId);
        Assert.Equal("group", chat.ChatMode);
        Assert.Equal("测试群", chat.Name);
        Assert.True(page.HasMore);
        Assert.Equal("next", page.PageToken);
    }

    [Fact]
    public async Task ListMessagesAsync_ParsesOfficialMessageShapeAndPagination()
    {
        var gateway = CreateGateway("""
        {
          "ok": true,
          "data": {
            "messages": [
              {
                "message_id": "om_1",
                "chat_id": "oc_1",
                "create_time": "1784083263000",
                "msg_type": "text",
                "content": "{\"text\":\"你好\"}",
                "deleted": false,
                "sender": {
                  "id": "ou_1",
                  "id_type": "open_id",
                  "name": "用户",
                  "sender_type": "user"
                }
              }
            ],
            "has_more": true,
            "page_token": "next-page"
          }
        }
        """);

        var page = await gateway.ListMessagesAsync("oc_1", 25, "page-1");

        var message = Assert.Single(page.Items);
        Assert.Equal("om_1", message.MessageId);
        Assert.Equal("{\"text\":\"你好\"}", message.Content);
        Assert.Equal("ou_1", message.SenderId);
        Assert.Equal("用户", message.SenderName);
        Assert.Equal("user", message.SenderType);
        Assert.True(page.HasMore);
        Assert.Equal("next-page", page.PageToken);
    }

    [Fact]
    public async Task ListMembersAsync_MergesOfficialUserAndBotBuckets()
    {
        IReadOnlyList<string>? captured = null;
        var gateway = new LarkCliGateway("", (arguments, _, _) =>
        {
            captured = arguments;
            return Task.FromResult(new LarkCliExecutionResult(0, """
        {
          "ok": true,
          "data": {
            "users": [{ "member_id": "ou_user", "name": "成员" }],
            "bots": [{ "member_id": "ou_bot", "name": "机器人" }],
            "has_more": false,
            "page_token": ""
          }
        }
        """, ""));
        });

        var page = await gateway.ListMembersAsync("oc_1");

        Assert.Equal(["im", "+chat-members-list", "--as", "bot", "--chat-id", "oc_1", "--member-id-type", "open_id", "--page-size", "100", "--page-all", "--page-limit", "0", "--json"], captured);
        Assert.False(page.Truncated);
        Assert.Collection(
            page.Items,
            item => Assert.Equal(("ou_user", "成员", "user"), (item.MemberId, item.Name, item.MemberType)),
            item => Assert.Equal(("ou_bot", "机器人", "bot"), (item.MemberId, item.Name, item.MemberType)));
    }

    [Fact]
    public async Task ListMembersAsync_SurfacesOfficialTruncationState()
    {
        var gateway = CreateGateway("""
        {
          "ok": true,
          "data": {
            "users": [],
            "bots": [],
            "truncations": [{ "member_type": "user", "reason": "security_cap" }]
          }
        }
        """);

        var page = await gateway.ListMembersAsync("oc_1");

        Assert.True(page.Truncated);
    }

    [Fact]
    public async Task DownloadMessageResourceAsync_UsesSafeRelativeOutput()
    {
        IReadOnlyList<string>? captured = null;
        var cacheRoot = Path.Combine(Path.GetTempPath(), $"lark-cli-gateway-{Guid.NewGuid():N}");
        Directory.CreateDirectory(cacheRoot);
        var gateway = new LarkCliGateway("", (arguments, workingDirectory, _) =>
        {
            captured = arguments;
            File.WriteAllBytes(Path.Combine(workingDirectory, "cached.png"), [1, 2, 3]);
            return Task.FromResult(new LarkCliExecutionResult(0, "{\"ok\":true,\"data\":{}}", ""));
        });

        try
        {
            var outputPath = await gateway.DownloadMessageResourceAsync("om_1", "img_1", "image", "cached.png", cacheRoot);

            Assert.Equal(Path.Combine(cacheRoot, "cached.png"), outputPath);
            Assert.Equal(["im", "+messages-resources-download", "--as", "bot", "--message-id", "om_1", "--file-key", "img_1", "--type", "image", "--output", "cached.png", "--json"], captured);
            await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.DownloadMessageResourceAsync("om_1", "img_1", "image", "..\\escape.png", cacheRoot));
        }
        finally
        {
            Directory.Delete(cacheRoot, recursive: true);
        }
    }

    [Fact]
    public async Task DownloadMessageResourceAsync_RejectsSuccessEnvelopeWithoutFile()
    {
        var cacheRoot = Path.Combine(Path.GetTempPath(), $"lark-cli-gateway-{Guid.NewGuid():N}");
        Directory.CreateDirectory(cacheRoot);
        var gateway = CreateGateway("{\"ok\":true,\"data\":{}}");

        try
        {
            var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                gateway.DownloadMessageResourceAsync("om_1", "img_1", "image", "missing.png", cacheRoot));

            Assert.Contains("未生成", error.Message);
        }
        finally
        {
            Directory.Delete(cacheRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SendTextAsync_UsesOfficialShortcutAndIdempotencyKey()
    {
        IReadOnlyList<string>? captured = null;
        var gateway = new LarkCliGateway("", (arguments, _, _) =>
        {
            captured = arguments;
            return Task.FromResult(new LarkCliExecutionResult(0, "{\"ok\":true,\"data\":{\"message_id\":\"om_sent\"}}", ""));
        });

        var messageId = await gateway.SendTextAsync("oc_1", "提醒内容", "reminder-1");

        Assert.Equal("om_sent", messageId);
        Assert.Equal(["im", "+messages-send", "--as", "bot", "--chat-id", "oc_1", "--text", "提醒内容", "--idempotency-key", "reminder-1", "--json"], captured);
    }

    [Fact]
    public async Task SendTextAsync_RejectsSuccessEnvelopeWithoutMessageId()
    {
        var gateway = CreateGateway("{\"ok\":true,\"data\":{}}");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.SendTextAsync("oc_1", "提醒内容"));

        Assert.Contains("message_id", error.Message);
    }

    [Fact]
    public void CreateIdempotencyKey_IsUniquePerPanelActionAndFitsOfficialLimit()
    {
        var first = LarkCliGateway.CreateIdempotencyKey("panel");
        var second = LarkCliGateway.CreateIdempotencyKey("panel");

        Assert.StartsWith("panel-", first);
        Assert.StartsWith("panel-", second);
        Assert.NotEqual(first, second);
        Assert.InRange(first.Length, 1, 50);
        Assert.InRange(second.Length, 1, 50);
    }

    [Fact]
    public async Task RecallMessageAsync_RequiresExplicitConfirmationBeforeYesFlag()
    {
        IReadOnlyList<string>? captured = null;
        var gateway = new LarkCliGateway("", (arguments, _, _) =>
        {
            captured = arguments;
            return Task.FromResult(new LarkCliExecutionResult(0, "{\"ok\":true,\"data\":{}}", ""));
        });

        await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.RecallMessageAsync("om_1", false));
        await gateway.RecallMessageAsync("om_1", true);

        Assert.Equal(["im", "messages", "delete", "--as", "bot", "--message-id", "om_1", "--yes", "--json"], captured);
    }

    [Fact]
    public async Task OfficialErrorEnvelope_IsReturnedAsReadableBlocker()
    {
        var gateway = CreateGateway("""
        {
          "ok": false,
          "error": {
            "type": "config",
            "code": 20048,
            "message": "The specified app does not exist."
          }
        }
        """);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.ListChatsAsync());

        Assert.Contains("20048", error.Message);
        Assert.Contains("The specified app does not exist", error.Message);
    }

    private static LarkCliGateway CreateGateway(string stdout)
        => new("", (_, _, _) => Task.FromResult(new LarkCliExecutionResult(0, stdout, "")));
}
