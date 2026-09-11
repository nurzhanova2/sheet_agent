param(
  [Parameter(Mandatory=$true)][string]$Path,
  [int]$WorksheetCount = 20,
  [int]$RowsPerSheet = 10000,
  [switch]$IncludeSingleAiSmoke
)
$ErrorActionPreference = 'Stop'
if ($WorksheetCount -lt 1 -or $RowsPerSheet -lt 2) { throw 'WorksheetCount must be >= 1 and RowsPerSheet must be >= 2.' }
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.Calculation = -4135 # xlCalculationManual: do not create accidental provider traffic
$workbook = $null
$started = Get-Date
try {
  $workbook = $excel.Workbooks.Add()
  while ($workbook.Worksheets.Count -lt $WorksheetCount) { $null = $workbook.Worksheets.Add() }
  for ($sheetIndex = 1; $sheetIndex -le $WorksheetCount; $sheetIndex++) {
    $sheet = $workbook.Worksheets.Item($sheetIndex)
    $sheet.Name = "Data$sheetIndex"
    $sheet.Cells.Item(1, 1) = 'Row'; $sheet.Cells.Item(1, 2) = 'Value'; $sheet.Cells.Item(1, 3) = 'Calculated'
    $sheet.Range("A2:A$RowsPerSheet").Formula = '=ROW()-1'
    $sheet.Range("B2:B$RowsPerSheet").Formula = "=A2*$sheetIndex"
    $sheet.Range("C2:C$RowsPerSheet").Formula = '=B2*2+1'
  }
  if ($IncludeSingleAiSmoke) { $workbook.Worksheets.Item(1).Range('E1').Formula = '=AI.SUMMARIZE("Sheet Agent smoke test")' }
  $absolute = [IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $absolute
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $workbook.SaveAs($absolute, 51)
  $workbook.Close($true)
  $workbook = $excel.Workbooks.Open($absolute, 0, $false)
  if ($workbook.Worksheets.Count -ne $WorksheetCount) { throw 'Workbook worksheet count changed after reopen.' }
  $workbook.Close($false)
  $peakBytes = (Get-Process EXCEL -ErrorAction SilentlyContinue | Measure-Object PeakWorkingSet64 -Maximum).Maximum
  [pscustomobject]@{ Path = $absolute; Worksheets = $WorksheetCount; RowsPerSheet = $RowsPerSheet; ElapsedSeconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 2); PeakWorkingSetMB = if ($peakBytes) { [Math]::Round($peakBytes / 1MB, 2) } else { $null } }
} finally {
  if ($workbook) { try { $workbook.Close($false) } catch {} }
  $excel.Quit()
  [Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) | Out-Null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
