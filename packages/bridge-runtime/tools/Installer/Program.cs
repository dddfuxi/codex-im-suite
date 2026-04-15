using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ClaudeToImInstaller;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        try
        {
            var source = Path.Combine(AppContext.BaseDirectory, "payload");
            if (!Directory.Exists(source))
            {
                MessageBox.Show("安装包缺少 payload 目录。请确认 ClaudeToImInstaller.exe 与 payload 在同一目录。", "Claude-to-IM Installer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            var target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeToImControlPanel");
            CopyDirectory(source, target);
            var exe = Path.Combine(target, "ClaudeToImControlPanel.exe");
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "飞书-Codex-MCP中控面板.lnk"), exe, target);
            var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Claude-to-IM");
            Directory.CreateDirectory(startMenu);
            CreateShortcut(Path.Combine(startMenu, "飞书-Codex-MCP中控面板.lnk"), exe, target);

            MessageBox.Show($"安装完成：\n{target}", "Claude-to-IM Installer", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = target });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Claude-to-IM Installer", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(source, directory)));
        }
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var dest = Path.Combine(target, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(file, dest, overwrite: true);
        }
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("WScript.Shell is unavailable.");
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic shortcut = shell.CreateShortcut(shortcutPath);
        shortcut.TargetPath = targetPath;
        shortcut.WorkingDirectory = workingDirectory;
        shortcut.Description = "Claude-to-IM Feishu/Codex/MCP Control Panel";
        shortcut.Save();
        Marshal.FinalReleaseComObject(shortcut);
        Marshal.FinalReleaseComObject(shell);
    }
}
