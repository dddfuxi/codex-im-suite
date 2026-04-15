using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CodexImSuiteInstaller;

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
                MessageBox.Show("Missing payload directory.", "Codex IM Suite Installer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            var target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexImSuite");
            CopyDirectory(source, target);
            var exe = Path.Combine(target, "CodexImSuiteControlPanel.exe");
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Codex IM Suite.lnk"), exe, target);
            var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Codex IM Suite");
            Directory.CreateDirectory(startMenu);
            CreateShortcut(Path.Combine(startMenu, "Codex IM Suite.lnk"), exe, target);
            MessageBox.Show($"Installed to:\n{target}", "Codex IM Suite Installer", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = target });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Codex IM Suite Installer", MessageBoxButtons.OK, MessageBoxIcon.Error);
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
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("WScript.Shell unavailable");
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic shortcut = shell.CreateShortcut(shortcutPath);
        shortcut.TargetPath = targetPath;
        shortcut.WorkingDirectory = workingDirectory;
        shortcut.Description = "Codex IM Suite Control Panel";
        shortcut.Save();
        Marshal.FinalReleaseComObject(shortcut);
        Marshal.FinalReleaseComObject(shell);
    }
}
