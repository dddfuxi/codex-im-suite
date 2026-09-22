using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ClaudeToImControlPanel;

internal static class McpHttpHealthChecks
{
    public static async Task<(bool Success, string Message)> RunGenericAsync(string url)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
            using var initRequest = BuildMcpInitializeRequest(url, "codex-im-suite-control-panel");
            using var initResponse = await client.SendAsync(initRequest);
            var initBody = await initResponse.Content.ReadAsStringAsync();
            if (!initResponse.IsSuccessStatusCode)
            {
                return (false, $"MCP endpoint 在线但 initialize 失败 HTTP {(int)initResponse.StatusCode} {initResponse.ReasonPhrase} | {url} | {TrimForStatus(initBody)}");
            }
            if (!TryReadMcpSessionId(initResponse, out _))
            {
                return (true, $"MCP protocol 在线 | initialize HTTP {(int)initResponse.StatusCode} | {url}");
            }
            return (true, $"MCP protocol 在线 | initialize OK | {url}");
        }
        catch (TaskCanceledException)
        {
            return (false, $"MCP initialize 超时 | {url}");
        }
        catch (HttpRequestException ex) when (ex.StatusCode.HasValue)
        {
            return (false, $"MCP endpoint HTTP {(int)ex.StatusCode.Value} | {url} | {ex.Message}");
        }
        catch (Exception ex)
        {
            return (false, $"MCP endpoint 连接失败 | {url} | {ex.Message}");
        }
    }

    public static async Task<(bool Success, string Message)> RunResourceAsync(string url, string resourceUri, string? successRegex, string? failureRegex)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
            using var initRequest = BuildMcpInitializeRequest(url, "codex-im-suite-control-panel");
            using var initResponse = await client.SendAsync(initRequest);
            var initBody = await initResponse.Content.ReadAsStringAsync();
            if (!initResponse.IsSuccessStatusCode)
            {
                return (false, $"MCP endpoint 在线，但 initialize 失败 HTTP {(int)initResponse.StatusCode} {initResponse.ReasonPhrase} | {url} | {TrimForStatus(initBody)}");
            }
            if (!TryReadMcpSessionId(initResponse, out var sessionId))
            {
                return (false, $"MCP initialize 成功但缺少 mcp-session-id | {url}");
            }
            await SendInitializedNotificationAsync(client, url, sessionId, CancellationToken.None);

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            using var resourceRequest = new HttpRequestMessage(HttpMethod.Post, url);
            resourceRequest.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
            resourceRequest.Headers.TryAddWithoutValidation("mcp-session-id", sessionId);
            resourceRequest.Content = new StringContent(
                JsonSerializer.Serialize(new
                {
                    jsonrpc = "2.0",
                    id = 2,
                    method = "resources/read",
                    @params = new { uri = resourceUri },
                }),
                Encoding.UTF8,
                "application/json");

            using var resourceResponse = await client.SendAsync(resourceRequest, cts.Token);
            var resourceBody = await resourceResponse.Content.ReadAsStringAsync(cts.Token);
            var decoded = DecodeSsePayload(resourceBody);
            var resourceText = ExtractResourceText(decoded);
            if (!resourceResponse.IsSuccessStatusCode)
            {
                return (false, $"MCP protocol 在线，但资源健康检查读取失败 HTTP {(int)resourceResponse.StatusCode} {resourceResponse.ReasonPhrase} | {resourceUri} | {TrimForStatus(resourceText)}");
            }
            if (!string.IsNullOrWhiteSpace(failureRegex) && Regex.IsMatch(resourceText, failureRegex, RegexOptions.IgnoreCase))
            {
                return (false, $"MCP protocol 在线，但资源健康检查未通过 | {resourceUri} | {TrimForStatus(resourceText)}");
            }
            if (!string.IsNullOrWhiteSpace(successRegex) && !Regex.IsMatch(resourceText, successRegex, RegexOptions.IgnoreCase))
            {
                return (false, $"MCP protocol 在线，但资源健康检查未满足成功条件 | {resourceUri} | {TrimForStatus(resourceText)}");
            }
            return (true, $"MCP resource 健康检查通过 | {resourceUri} | {TrimForStatus(resourceText)}");
        }
        catch (TaskCanceledException)
        {
            return (false, $"MCP resource 健康检查超时 | {url} | {resourceUri}");
        }
        catch (HttpRequestException ex) when (ex.StatusCode.HasValue)
        {
            return (false, $"MCP endpoint HTTP {(int)ex.StatusCode.Value} | {url} | {ex.Message}");
        }
        catch (Exception ex)
        {
            return (false, $"MCP resource 健康检查失败 | {url} | {resourceUri} | {ex.Message}");
        }
    }

    private static HttpRequestMessage BuildMcpInitializeRequest(string url, string clientName)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
        request.Content = new StringContent(
            $"{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{{}},\"clientInfo\":{{\"name\":\"{clientName}\",\"version\":\"0.0.0\"}}}}}}",
            Encoding.UTF8,
            "application/json");
        return request;
    }

    private static bool TryReadMcpSessionId(HttpResponseMessage response, out string sessionId)
    {
        sessionId = "";
        if (!response.Headers.TryGetValues("mcp-session-id", out var values)) return false;
        sessionId = values.FirstOrDefault() ?? "";
        return !string.IsNullOrWhiteSpace(sessionId);
    }

    private static async Task SendInitializedNotificationAsync(HttpClient client, string url, string sessionId, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            request.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
            request.Headers.TryAddWithoutValidation("mcp-session-id", sessionId);
            request.Content = new StringContent(
                JsonSerializer.Serialize(new
                {
                    jsonrpc = "2.0",
                    method = "notifications/initialized",
                    @params = new { },
                }),
                Encoding.UTF8,
                "application/json");
            using var response = await client.SendAsync(request, cancellationToken);
            _ = await response.Content.ReadAsStringAsync(cancellationToken);
        }
        catch
        {
            // Some lightweight MCP test or proxy endpoints ignore notifications.
        }
    }

    private static string DecodeSsePayload(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "";
        var dataLines = body.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            .Select(line => line["data:".Length..].Trim())
            .ToArray();
        return dataLines.Length == 0 ? body : string.Join("\n", dataLines);
    }

    private static string ExtractResourceText(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "";
        try
        {
            using var document = JsonDocument.Parse(body);
            if (!document.RootElement.TryGetProperty("result", out var result)) return body;
            if (!result.TryGetProperty("contents", out var contents) || contents.ValueKind != JsonValueKind.Array) return body;
            var texts = contents.EnumerateArray()
                .Select(item => item.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String ? text.GetString() : null)
                .Where(text => !string.IsNullOrWhiteSpace(text))
                .ToArray();
            return texts.Length > 0 ? string.Join("\n", texts) : body;
        }
        catch
        {
            return body;
        }
    }

    private static string TrimForStatus(string text, int maxLen = 260)
    {
        var compact = Regex.Replace(text, "\\s+", " ").Trim();
        return compact.Length <= maxLen ? compact : compact[..maxLen] + "...";
    }
}
