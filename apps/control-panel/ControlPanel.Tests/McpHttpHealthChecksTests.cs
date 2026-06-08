using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class McpHttpHealthChecksTests
{
    [Fact]
    public async Task RunResourceAsync_PassesOnlyWhenConfiguredResourceMatchesSuccessCondition()
    {
        await using var server = await FakeMcpServer.StartAsync("""{"success":true,"instance_count":1,"instances":[{"name":"Editor@abcd"}]}""");

        var health = await McpHttpHealthChecks.RunResourceAsync(
            server.Url,
            "mcpforunity://instances",
            "\\\\?\"instance_count\\\\?\"\\s*:\\s*[1-9][0-9]*",
            "\\\\?\"instance_count\\\\?\"\\s*:\\s*0");

        Assert.True(health.Success);
        Assert.Contains("mcpforunity://instances", health.Message);
        Assert.Equal(1, server.ResourceReadCount);
    }

    [Fact]
    public async Task RunResourceAsync_FailsWhenConfiguredResourceReportsNoEditorInstance()
    {
        await using var server = await FakeMcpServer.StartAsync("""{"success":true,"instance_count":0,"instances":[]}""");

        var health = await McpHttpHealthChecks.RunResourceAsync(
            server.Url,
            "mcpforunity://instances",
            "\\\\?\"instance_count\\\\?\"\\s*:\\s*[1-9][0-9]*",
            "\\\\?\"instance_count\\\\?\"\\s*:\\s*0");

        Assert.False(health.Success);
        Assert.Contains("资源健康检查未通过", health.Message);
        Assert.Equal(1, server.ResourceReadCount);
    }

    [Fact]
    public async Task RunGenericAsync_DoesNotReadUnityResourceByNameOrEndpointShape()
    {
        await using var server = await FakeMcpServer.StartAsync("""{"success":true,"instance_count":0,"instances":[]}""");

        var health = await McpHttpHealthChecks.RunGenericAsync(server.Url);

        Assert.True(health.Success);
        Assert.Contains("initialize", health.Message);
        Assert.Equal(0, server.ResourceReadCount);
    }

    private sealed class FakeMcpServer : IAsyncDisposable
    {
        private readonly HttpListener _listener;
        private readonly CancellationTokenSource _cts = new();
        private readonly Task _loop;
        private readonly string _resourceText;

        private FakeMcpServer(HttpListener listener, string url, string resourceText)
        {
            _listener = listener;
            Url = url;
            _resourceText = resourceText;
            _loop = Task.Run(ServeAsync);
        }

        public string Url { get; }
        public int ResourceReadCount { get; private set; }

        public static Task<FakeMcpServer> StartAsync(string resourceText)
        {
            var port = AllocatePort();
            var url = $"http://127.0.0.1:{port}/mcp";
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Start();
            return Task.FromResult(new FakeMcpServer(listener, url, resourceText));
        }

        public async ValueTask DisposeAsync()
        {
            _cts.Cancel();
            _listener.Close();
            try
            {
                await _loop.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch
            {
                // best-effort test server shutdown
            }
            _cts.Dispose();
        }

        private async Task ServeAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync();
                }
                catch when (_cts.IsCancellationRequested)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }

                _ = Task.Run(() => HandleAsync(context));
            }
        }

        private async Task HandleAsync(HttpListenerContext context)
        {
            using var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding);
            var body = await reader.ReadToEndAsync();
            var request = JsonSerializer.Deserialize<JsonElement>(body);
            var method = request.TryGetProperty("method", out var methodElement) ? methodElement.GetString() : "";
            var id = request.TryGetProperty("id", out var idElement) ? idElement.Clone() : default;

            context.Response.ContentType = "application/json";
            if (method == "initialize")
            {
                context.Response.Headers["mcp-session-id"] = "test-session";
                await WriteJsonAsync(context.Response, new
                {
                    jsonrpc = "2.0",
                    id,
                    result = new
                    {
                        protocolVersion = "2024-11-05",
                        capabilities = new { },
                        serverInfo = new { name = "fake-http-mcp", version = "1.0.0" },
                    },
                });
                return;
            }

            if (method == "resources/read")
            {
                ResourceReadCount += 1;
                await WriteJsonAsync(context.Response, new
                {
                    jsonrpc = "2.0",
                    id,
                    result = new
                    {
                        contents = new[] { new { uri = "mcpforunity://instances", text = _resourceText } },
                    },
                });
                return;
            }

            context.Response.StatusCode = 404;
            await WriteJsonAsync(context.Response, new { error = "unknown method" });
        }

        private static async Task WriteJsonAsync(HttpListenerResponse response, object value)
        {
            var json = JsonSerializer.Serialize(value);
            var bytes = Encoding.UTF8.GetBytes(json);
            response.ContentLength64 = bytes.Length;
            await response.OutputStream.WriteAsync(bytes);
            response.Close();
        }

        private static int AllocatePort()
        {
            using var socket = new TcpListener(IPAddress.Loopback, 0);
            socket.Start();
            var port = ((IPEndPoint)socket.LocalEndpoint).Port;
            socket.Stop();
            return port;
        }
    }
}
