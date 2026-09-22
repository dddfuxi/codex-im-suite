using Microsoft.AspNetCore.Http;

namespace ClaudeToImControlPanel;

internal static class ControlPanelWebCachePolicy
{
    internal const string CacheControlValue = "no-cache, no-store, must-revalidate";

    internal static void Apply(HttpResponse response)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Headers.CacheControl = CacheControlValue;
        response.Headers.Pragma = "no-cache";
        response.Headers.Expires = "0";
    }
}
