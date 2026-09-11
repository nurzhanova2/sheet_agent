namespace SheetAgent.Companion;

public sealed class TrayApplicationContext : ApplicationContext
{
    private readonly NotifyIcon tray;
    private readonly PairingService pairing;
    private readonly ICredentialStore credentials;
    private readonly StartupManager startup;
    public TrayApplicationContext(PairingService pairing, ICredentialStore credentials, StartupManager startup)
    {
        this.pairing = pairing; this.credentials = credentials; this.startup = startup;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Настройки", null, (_, _) => ShowSettings());
        menu.Items.Add("Копировать код подключения", null, (_, _) => Clipboard.SetText(pairing.CurrentCode));
        menu.Items.Add("Выход", null, (_, _) => ExitThread());
        tray = new NotifyIcon { Text = "Sheet Agent", Icon = SystemIcons.Application, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => ShowSettings();
    }
    private void ShowSettings() { using var form = new SettingsForm(pairing, credentials, startup); form.ShowDialog(); }
    protected override void ExitThreadCore() { tray.Visible = false; tray.Dispose(); base.ExitThreadCore(); }
}

internal sealed class SettingsForm : Form
{
    public SettingsForm(PairingService pairing, ICredentialStore credentials, StartupManager startup)
    {
        Text = "Sheet Agent — настройки"; Width = 430; Height = 265; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
        var code = new Label { Left = 20, Top = 20, Width = 370, Text = $"Код подключения: {pairing.CurrentCode}" };
        var key = new TextBox { Left = 20, Top = 70, Width = 370, UseSystemPasswordChar = true, PlaceholderText = "LLM API key" };
        var save = new Button { Left = 20, Top = 110, Width = 110, Text = "Сохранить" };
        var delete = new Button { Left = 140, Top = 110, Width = 110, Text = "Удалить ключ" };
        var autoStart = new CheckBox { Left = 20, Top = 160, Width = 300, Text = "Запускать вместе с Windows", Checked = startup.IsEnabled };
        var status = new Label { Left = 20, Top = 195, Width = 370, Text = credentials.Exists("LLM_API_KEY") ? "Ключ сохранён и защищён DPAPI" : "Ключ не сохранён" };
        save.Click += async (_, _) => { if (!string.IsNullOrWhiteSpace(key.Text)) { await credentials.SetAsync("LLM_API_KEY", key.Text); key.Clear(); status.Text = "Ключ сохранён и защищён DPAPI"; } };
        delete.Click += async (_, _) => { await credentials.DeleteAsync("LLM_API_KEY"); status.Text = "Ключ не сохранён"; };
        autoStart.CheckedChanged += (_, _) => startup.SetEnabled(autoStart.Checked);
        Controls.AddRange([code, key, save, delete, autoStart, status]);
    }
}
