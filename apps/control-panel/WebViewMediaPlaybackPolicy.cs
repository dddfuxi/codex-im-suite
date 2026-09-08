using Microsoft.Web.WebView2.Core;

namespace ClaudeToImControlPanel;

/// <summary>
/// 控制面板只承载本机受信页面；试听媒体又是在用户点击后异步生成，
/// 因此需要允许生成完成后的同一请求继续自动播放，而不是被短暂手势窗口拦截。
/// </summary>
internal static class WebViewMediaPlaybackPolicy
{
    internal const string AutoplayBrowserArgument = "--autoplay-policy=no-user-gesture-required";

    internal static CoreWebView2EnvironmentOptions CreateEnvironmentOptions()
        => new(AutoplayBrowserArgument);
}
