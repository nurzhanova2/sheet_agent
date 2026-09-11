# Excel Windows end-to-end tests

Automation validates the exact installer/checksum/signature, silent install, files, Office registry registration, Companion launch/HTTPS health, a realistic 20-sheet × 10,000-row workbook fixture, save/reopen, uninstall cleanup, and absence of a leftover SheetAgent process after uninstall.

Run artifact-only validation (safe and non-mutating):

```powershell
.\tests\excel-e2e\validate-windows-release.ps1
```

On a disposable clean Windows 10/11 x64 VM with supported Microsoft Excel Desktop installed, close Excel and run:

```powershell
.\tests\excel-e2e\validate-windows-release.ps1 -RequireSigned -Install -RunExcel
```

Then perform the native UI portion; record Windows/Office versions, timings, Excel and SheetAgent peak working set, and screenshots in the release evidence:

1. Start Excel and confirm it opens normally.
2. Open the generated `%TEMP%\SheetAgent-large-workbook.xlsx`; confirm sheets, formulas, scrolling, editing, save, close, and reopen work.
3. On Home, choose **AI Assistant** in the **Excel AI** group. Confirm the task pane renders and remains responsive.
4. Open Sheet Agent from the tray, save a non-production test provider key, and send `Reply with the word Ready`. Confirm `Ready` streams into the pane.
5. In a blank cell enter `=AI.SUMMARIZE("The quarterly result improved")`; confirm text is returned.
6. Enter a deliberately invalid function input and disconnect the network; verify actionable errors appear and Excel remains usable.
7. Restore the network, recalculate repeatedly, save, close, and reopen the workbook.
8. Close Excel. Confirm no EXCEL process remains. SheetAgent may remain intentionally because it is a tray/autostart application; **Exit** must stop it.
9. Test same-AppId upgrade with desktop/autostart tasks toggled, then run the script again with `-Uninstall`. Confirm files, registry, certificate, and process cleanup.

Do not mark native Excel E2E passed from the PowerShell result alone. The task-pane/ribbon checks require observation in real Excel. The `-IncludeSingleAiSmoke` fixture switch is intentionally opt-in because it can generate real provider traffic; 100/1000-function scale is tested with a mock by `pnpm test:performance`.
