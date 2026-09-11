# Sheet Agent user guide

After installation, Sheet Agent runs as a tray application and serves the Excel add-in only on `https://localhost:47831`. If it is not running, open **Sheet Agent** from the Start menu. Its tray menu provides **Settings**, a connection code, and **Exit**.

## Configure the AI provider

Right-click the Sheet Agent tray icon, open **Settings**, paste your provider API key, and choose **Save**. The key is encrypted with Windows DPAPI for your current Windows account. It is never stored in the workbook, manifest, JavaScript bundle, or Git repository. Use **Delete key** to remove it or save a new value to replace it. The installed release uses the organization’s configured LiteLLM HTTPS endpoint and Qwen model.

## Open the Excel extension

1. Start or restart Excel and open or create a workbook.
2. On the **Home** ribbon, find the **Excel AI** group and choose **AI Assistant**.
3. Enter a short request such as `Summarize the selected cells` and send it. A response should stream into the task pane.
4. In a cell, enter `=AI.SUMMARIZE("Revenue increased from 10 to 12")` and press Enter. A short summary confirms the custom-function path works.

Also available are `AI.ASK`, `AI.CLASSIFY`, `AI.EXTRACT`, `AI.TRANSLATE`, and `AI.CLEAN`. AI calls send the supplied text—and task-pane calls may send selected workbook context—to the configured provider. Avoid including data your organization does not permit the provider to process.

Sheet Agent errors do not prevent ordinary workbook editing. `#AUTH!` means the key is missing or rejected, `#RATE!` means the provider rate-limited the request, `#TIMEOUT!` means it was too slow, `#CANCELLED!` means recalculation was cancelled, and `#AI!` is a provider/network failure. Correct the cause and recalculate.
