using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace ClaudeToImControlPanel;

internal readonly record struct JsonUnicodeSanitizationResult(string Text, int ReplacementCount);

internal static class ControlPanelJsonBoundary
{
    /// <summary>
    /// 修复 JSON 字符串中的孤立 Unicode 代理项转义，同时保留合法 emoji、中文和字面量 "\\uXXXX"。
    /// 这用于兼容旧 Runtime 已经持久化的坏记录；不会修改来源文件。
    /// </summary>
    internal static JsonUnicodeSanitizationResult SanitizeMalformedUnicodeEscapes(string json)
    {
        if (string.IsNullOrEmpty(json)) return new JsonUnicodeSanitizationResult(json, 0);

        StringBuilder? output = null;
        var inString = false;
        var replacements = 0;

        void Append(string value, int sourceIndex)
        {
            if (output is null)
            {
                output = new StringBuilder(json.Length + 16);
                output.Append(json, 0, sourceIndex);
            }
            output.Append(value);
        }

        for (var index = 0; index < json.Length; index++)
        {
            var current = json[index];
            if (!inString)
            {
                if (current == '"') inString = true;
                output?.Append(current);
                continue;
            }

            if (current == '"')
            {
                inString = false;
                output?.Append(current);
                continue;
            }

            if (current == '\\')
            {
                if (index + 1 >= json.Length)
                {
                    output?.Append(current);
                    continue;
                }

                var escapeKind = json[index + 1];
                if (escapeKind != 'u' || !TryReadHexCodeUnit(json, index + 2, out var codeUnit))
                {
                    output?.Append(current);
                    output?.Append(escapeKind);
                    index += 1;
                    continue;
                }

                if (char.IsHighSurrogate((char)codeUnit))
                {
                    var lowEscapeIndex = index + 6;
                    if (
                        lowEscapeIndex + 5 < json.Length
                        && json[lowEscapeIndex] == '\\'
                        && json[lowEscapeIndex + 1] == 'u'
                        && TryReadHexCodeUnit(json, lowEscapeIndex + 2, out var lowCodeUnit)
                        && char.IsLowSurrogate((char)lowCodeUnit)
                    )
                    {
                        output?.Append(json, index, 12);
                        index += 11;
                        continue;
                    }

                    Append("\\uFFFD", index);
                    replacements += 1;
                    index += 5;
                    continue;
                }

                if (char.IsLowSurrogate((char)codeUnit))
                {
                    Append("\\uFFFD", index);
                    replacements += 1;
                    index += 5;
                    continue;
                }

                output?.Append(json, index, 6);
                index += 5;
                continue;
            }

            if (char.IsHighSurrogate(current))
            {
                if (index + 1 < json.Length && char.IsLowSurrogate(json[index + 1]))
                {
                    output?.Append(current);
                    output?.Append(json[index + 1]);
                    index += 1;
                    continue;
                }
                Append("\uFFFD", index);
                replacements += 1;
                continue;
            }

            if (char.IsLowSurrogate(current))
            {
                Append("\uFFFD", index);
                replacements += 1;
                continue;
            }

            output?.Append(current);
        }

        return output is null
            ? new JsonUnicodeSanitizationResult(json, 0)
            : new JsonUnicodeSanitizationResult(output.ToString(), replacements);
    }

    internal static JsonObject? ParseObject(string json, out int replacementCount)
    {
        var sanitized = SanitizeMalformedUnicodeEscapes(json);
        replacementCount = sanitized.ReplacementCount;
        return JsonNode.Parse(sanitized.Text) as JsonObject;
    }

    private static bool TryReadHexCodeUnit(string value, int start, out int codeUnit)
    {
        codeUnit = 0;
        if (start < 0 || start + 4 > value.Length) return false;
        return int.TryParse(value.AsSpan(start, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out codeUnit);
    }
}
