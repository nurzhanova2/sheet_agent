# Excel Add-in Development

## Local HTTPS

Office Add-ins require HTTPS. The Vite development server uses a locally generated certificate through `@vitejs/plugin-basic-ssl`. The browser/Office webview must trust the development certificate before the Task Pane can load without certificate errors.

```bash
pnpm install --frozen-lockfile
pnpm --filter @sheet-agent/addin dev
```

The development manifest is `apps/addin/manifest/manifest.dev.xml` and points to `https://localhost:3000`.

## Windows

For development, expose the directory containing `manifest.dev.xml` through a trusted network share catalog in Excel Trust Center, restart Excel, then install the add-in from Shared Folder. Centrally managed environments should use Microsoft 365 integrated deployment.

## Excel Web

Open Excel Web, choose Add-ins and upload `manifest.dev.xml`. The browser must be able to reach and trust the local HTTPS server.

## macOS

Copy `manifest.dev.xml` to the Excel `wef` sideload directory, restart Excel and select Excel AI Assistant from My Add-ins.

## Smoke checklist

Run this checklist on Windows, Excel Web and macOS:

1. Start the HTTPS development server.
2. Install the development manifest.
3. Confirm that Home → Excel AI → AI Assistant opens the Task Pane.
4. Confirm the loading state changes to the ready empty state.
5. Resize the pane to a narrow width; content must remain usable without horizontal scrolling.
6. Navigate settings, message input and send button using the keyboard.
7. Enable high contrast and reduced motion; focus and loading state remain visible.
8. Open the HTML page outside Excel; a recoverable Office initialization error must appear.

## Production manifest

`manifest.prod.xml` intentionally contains the placeholder origin `https://excel-ai.example.com`. Deployment must replace it with the owned production HTTPS origin and validate the manifest before release. Provider secrets are never placed in either manifest.
