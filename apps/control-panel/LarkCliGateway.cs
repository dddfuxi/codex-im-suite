using System.Text.Json;
using System.Text.RegularExpressions;

namespace ClaudeToImControlPanel;

internal sealed record LarkCliExecutionResult(int ExitCode, string Stdout, string Stderr);

internal delegate Task<LarkCliExecutionResult> LarkCliCommandExecutor(
    IReadOnlyList<string> arguments,
    string workingDirectory,
    int timeoutMs);

internal sealed record LarkCliPage<T>(IReadOnlyList<T> Items, bool HasMore, string PageToken)
{
    /// <summary>
    /// 把官方分页中的条目映射/过滤为另一种类型，同时独立保留分页游标。
    /// 即使当前页所有条目都被过滤，也不能因此丢失后续页。
    /// </summary>
    public LarkCliPage<TOutput> WithItems<TOutput>(IReadOnlyList<TOutput> items)
        => new(items, HasMore, PageToken);
}

internal sealed record LarkCliChat(string ChatId, string ChatMode, string Name);

internal sealed record LarkCliMessage(
    string MessageId,
    string ChatId,
    string CreateTime,
    string MessageType,
    string Content,
    bool Deleted,
    string SenderId,
    string SenderIdType,
    string SenderName,
    string SenderType);

internal sealed record LarkCliMember(string MemberId, string Name, string MemberType);

internal sealed record LarkCliMemberPage(IReadOnlyList<LarkCliMember> Items, bool Truncated);

internal sealed record LarkCliProbe(
    string Version,
    bool Ready,
    string Identity,
    string TokenStatus,
    string Detail);

/// <summary>
/// 控制面板使用的官方 lark-cli 边界。
/// 这里只暴露经过约束的具体平台操作，不提供任意命令透传，也不暴露 event consume，
/// 避免控制面板意外启动第二条事件消费主链或绕过现有 Bridge 权限策略。
/// </summary>
internal sealed class LarkCliGateway
{
    private readonly string _profile;
    private readonly LarkCliCommandExecutor _executor;

    public LarkCliGateway(string profile, LarkCliCommandExecutor executor)
    {
        _profile = profile?.Trim() ?? "";
        _executor = executor ?? throw new ArgumentNullException(nameof(executor));
    }

    /// <summary>
    /// 为一次受控写操作生成唯一幂等键。官方接口把相同 key 视为同一次请求，
    /// 因此不能长期按“目标 + 正文”固定计算，否则用户合法重复发送也会被去重。
    /// </summary>
    public static string CreateIdempotencyKey(string prefix)
    {
        var normalized = Regex.Replace(prefix?.Trim() ?? "", @"[^A-Za-z0-9_.-]+", "-").Trim('-');
        if (string.IsNullOrWhiteSpace(normalized)) normalized = "action";
        if (normalized.Length > 17) normalized = normalized[..17];
        return $"{normalized}-{Guid.NewGuid():N}";
    }

    public async Task<LarkCliProbe> ProbeAsync(string workingDirectory = "")
    {
        var versionResult = await _executor(WithProfile(["--version"]), workingDirectory, 15_000);
        var versionText = FirstNonEmpty(versionResult.Stdout, versionResult.Stderr);
        var version = Regex.Match(versionText, @"\d+\.\d+\.\d+").Value;
        if (versionResult.ExitCode != 0)
        {
            return new LarkCliProbe(version, false, "", "", FirstNonEmpty(versionResult.Stderr, versionResult.Stdout, "lark-cli 不可用。"));
        }

        var doctorResult = await _executor(WithProfile(["doctor"]), workingDirectory, 30_000);
        var whoAmIResult = await _executor(WithProfile(["whoami"]), workingDirectory, 30_000);
        var doctorOk = TryReadRootBool(doctorResult.Stdout, "ok");
        var available = TryReadRootBool(whoAmIResult.Stdout, "available");
        var identity = TryReadRootString(whoAmIResult.Stdout, "identity");
        var tokenStatus = TryReadRootString(whoAmIResult.Stdout, "tokenStatus");
        var ready = doctorResult.ExitCode == 0
            && whoAmIResult.ExitCode == 0
            && doctorOk
            && available;
        var detail = ready
            ? "官方 CLI 配置、应用身份与网络检查通过。"
            : FirstNonEmpty(doctorResult.Stderr, whoAmIResult.Stderr, doctorResult.Stdout, whoAmIResult.Stdout, "官方 CLI 尚未就绪。");
        return new LarkCliProbe(version, ready, identity, tokenStatus, detail.Trim());
    }

    public async Task<LarkCliPage<LarkCliChat>> ListChatsAsync(
        int pageSize = 50,
        string? pageToken = null,
        string workingDirectory = "")
    {
        var args = new List<string>
        {
            "im", "+chat-list", "--as", "bot", "--page-size", Clamp(pageSize, 1, 100).ToString(),
        };
        AddOptional(args, "--page-token", pageToken);
        args.Add("--json");

        using var document = await ExecuteJsonAsync(args, workingDirectory, 30_000);
        var data = GetRequiredObject(document.RootElement, "data");
        var chats = new List<LarkCliChat>();
        if (data.TryGetProperty("chats", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in items.EnumerateArray())
            {
                var chatId = ReadString(item, "chat_id");
                if (string.IsNullOrWhiteSpace(chatId)) continue;
                chats.Add(new LarkCliChat(
                    chatId,
                    ReadString(item, "chat_mode"),
                    FirstNonEmpty(ReadString(item, "name"), chatId)));
            }
        }
        return new LarkCliPage<LarkCliChat>(
            chats,
            ReadBool(data, "has_more"),
            ReadString(data, "page_token"));
    }

    public async Task<LarkCliPage<LarkCliMessage>> ListMessagesAsync(
        string chatId,
        int pageSize = 50,
        string? pageToken = null,
        string workingDirectory = "")
    {
        RequirePlatformId(chatId, "chatId");
        var args = new List<string>
        {
            "im", "+chat-messages-list", "--as", "bot", "--chat-id", chatId,
            "--page-size", Clamp(pageSize, 1, 50).ToString(), "--no-reactions",
        };
        AddOptional(args, "--page-token", pageToken);
        args.Add("--json");

        using var document = await ExecuteJsonAsync(args, workingDirectory, 45_000);
        var data = GetRequiredObject(document.RootElement, "data");
        var messages = new List<LarkCliMessage>();
        if (data.TryGetProperty("messages", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in items.EnumerateArray())
            {
                var sender = item.TryGetProperty("sender", out var senderValue) && senderValue.ValueKind == JsonValueKind.Object
                    ? senderValue
                    : default;
                messages.Add(new LarkCliMessage(
                    ReadString(item, "message_id"),
                    FirstNonEmpty(ReadString(item, "chat_id"), chatId),
                    ReadString(item, "create_time"),
                    ReadString(item, "msg_type"),
                    ReadString(item, "content"),
                    ReadBool(item, "deleted"),
                    sender.ValueKind == JsonValueKind.Object ? ReadString(sender, "id") : "",
                    sender.ValueKind == JsonValueKind.Object ? ReadString(sender, "id_type") : "",
                    sender.ValueKind == JsonValueKind.Object ? ReadString(sender, "name") : "",
                    sender.ValueKind == JsonValueKind.Object ? ReadString(sender, "sender_type") : ""));
            }
        }
        return new LarkCliPage<LarkCliMessage>(
            messages,
            ReadBool(data, "has_more"),
            ReadString(data, "page_token"));
    }

    public async Task<LarkCliMemberPage> ListMembersAsync(
        string chatId,
        string workingDirectory = "")
    {
        RequirePlatformId(chatId, "chatId");
        var args = new List<string>
        {
            "im", "+chat-members-list", "--as", "bot", "--chat-id", chatId,
            "--member-id-type", "open_id", "--page-size", "100",
            "--page-all", "--page-limit", "0", "--json",
        };
        using var document = await ExecuteJsonAsync(args, workingDirectory, 45_000);
        var data = GetRequiredObject(document.RootElement, "data");
        var members = new List<LarkCliMember>();
        AddMembers(data, "users", "user", members);
        AddMembers(data, "bots", "bot", members);
        var truncated = data.TryGetProperty("truncations", out var truncations)
            && truncations.ValueKind == JsonValueKind.Array
            && truncations.GetArrayLength() > 0;
        return new LarkCliMemberPage(members, truncated);
    }

    public async Task<string> DownloadMessageResourceAsync(
        string messageId,
        string fileKey,
        string resourceType,
        string relativeOutputPath,
        string workingDirectory)
    {
        RequirePlatformId(messageId, "messageId");
        RequirePlatformId(fileKey, "fileKey");
        if (resourceType is not ("image" or "file"))
        {
            throw new InvalidOperationException("飞书资源类型只允许 image 或 file。");
        }
        var fullOutputPath = ResolveSafeOutputPath(workingDirectory, relativeOutputPath);
        var args = new List<string>
        {
            "im", "+messages-resources-download", "--as", "bot",
            "--message-id", messageId, "--file-key", fileKey, "--type", resourceType,
            "--output", relativeOutputPath, "--json",
        };
        using var _ = await ExecuteJsonAsync(args, workingDirectory, 60_000);
        if (!File.Exists(fullOutputPath) || new FileInfo(fullOutputPath).Length <= 0)
        {
            throw new InvalidOperationException("lark-cli 返回成功但未生成有效资源文件。");
        }
        return fullOutputPath;
    }

    public async Task<string> SendTextAsync(
        string chatId,
        string text,
        string? idempotencyKey = null,
        string workingDirectory = "")
    {
        RequirePlatformId(chatId, "chatId");
        if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("飞书消息正文不能为空。");
        var args = new List<string>
        {
            "im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--text", text,
        };
        AddOptional(args, "--idempotency-key", idempotencyKey);
        args.Add("--json");
        using var document = await ExecuteJsonAsync(args, workingDirectory, 45_000);
        var messageId = FindString(document.RootElement, "message_id");
        if (string.IsNullOrWhiteSpace(messageId))
        {
            throw new InvalidOperationException("lark-cli 发送成功响应缺少 message_id，无法追踪本次出站消息。");
        }
        return messageId;
    }

    public async Task RecallMessageAsync(
        string messageId,
        bool userConfirmed,
        string workingDirectory = "")
    {
        RequirePlatformId(messageId, "messageId");
        if (!userConfirmed)
        {
            throw new InvalidOperationException("撤回属于高风险写操作，必须由用户明确确认后才能传递 --yes。");
        }
        using var _ = await ExecuteJsonAsync(
            ["im", "messages", "delete", "--as", "bot", "--message-id", messageId, "--yes", "--json"],
            workingDirectory,
            45_000);
    }

    private async Task<JsonDocument> ExecuteJsonAsync(
        IReadOnlyList<string> commandArguments,
        string workingDirectory,
        int timeoutMs)
    {
        var arguments = WithProfile(commandArguments);
        var result = await _executor(arguments, workingDirectory, timeoutMs);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(FirstNonEmpty(result.Stderr, result.Stdout, $"lark-cli 退出码 {result.ExitCode}"));
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(result.Stdout);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"lark-cli 未返回合法 JSON：{error.Message}");
        }

        if (!ReadBool(document.RootElement, "ok"))
        {
            var code = "";
            var message = "官方 CLI 返回失败。";
            if (document.RootElement.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
            {
                code = ReadString(error, "code");
                message = FirstNonEmpty(ReadString(error, "message"), ReadString(error, "hint"), message);
            }
            document.Dispose();
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(code) ? message : $"lark-cli [{code}]：{message}");
        }
        return document;
    }

    private IReadOnlyList<string> WithProfile(IReadOnlyList<string> arguments)
    {
        if (string.IsNullOrWhiteSpace(_profile)) return arguments.ToArray();
        return ["--profile", _profile, .. arguments];
    }

    private static void AddMembers(JsonElement data, string propertyName, string memberType, List<LarkCliMember> output)
    {
        if (!data.TryGetProperty(propertyName, out var values) || values.ValueKind != JsonValueKind.Array) return;
        foreach (var item in values.EnumerateArray())
        {
            var memberId = ReadString(item, "member_id");
            if (string.IsNullOrWhiteSpace(memberId)) continue;
            output.Add(new LarkCliMember(memberId, ReadString(item, "name"), memberType));
        }
    }

    private static JsonElement GetRequiredObject(JsonElement root, string propertyName)
    {
        if (root.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.Object)
        {
            return value;
        }
        throw new InvalidOperationException($"lark-cli 响应缺少 {propertyName} 对象。");
    }

    private static string ResolveSafeOutputPath(string workingDirectory, string relativeOutputPath)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory) || !Path.IsPathFullyQualified(workingDirectory))
        {
            throw new InvalidOperationException("资源下载需要绝对工作目录。");
        }
        if (string.IsNullOrWhiteSpace(relativeOutputPath) || Path.IsPathFullyQualified(relativeOutputPath))
        {
            throw new InvalidOperationException("lark-cli 资源输出必须是相对路径。");
        }
        var root = Path.GetFullPath(workingDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var output = Path.GetFullPath(Path.Combine(root, relativeOutputPath));
        if (!output.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("lark-cli 资源输出不能越过缓存目录。");
        }
        return output;
    }

    private static void RequirePlatformId(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Any(char.IsWhiteSpace))
        {
            throw new InvalidOperationException($"缺少或无效的 {name}。");
        }
    }

    private static void AddOptional(List<string> args, string flag, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        args.Add(flag);
        args.Add(value.Trim());
    }

    private static bool ReadBool(JsonElement element, string propertyName)
        => element.TryGetProperty(propertyName, out var value)
            && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            && value.GetBoolean();

    private static bool TryReadRootBool(string json, string propertyName)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return ReadBool(document.RootElement, propertyName);
        }
        catch
        {
            return false;
        }
    }

    private static string TryReadRootString(string json, string propertyName)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return ReadString(document.RootElement, propertyName);
        }
        catch
        {
            return "";
        }
    }

    private static string ReadString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value)) return "";
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Number => value.GetRawText(),
            _ => "",
        };
    }

    private static string FindString(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            if (element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString() ?? "";
            }
            foreach (var property in element.EnumerateObject())
            {
                var nested = FindString(property.Value, propertyName);
                if (!string.IsNullOrWhiteSpace(nested)) return nested;
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                var nested = FindString(item, propertyName);
                if (!string.IsNullOrWhiteSpace(nested)) return nested;
            }
        }
        return "";
    }

    private static int Clamp(int value, int min, int max) => Math.Min(max, Math.Max(min, value));

    private static string FirstNonEmpty(params string[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";
}
