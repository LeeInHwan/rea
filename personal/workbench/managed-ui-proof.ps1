param([Parameter(Mandatory=$true)][string]$AppExe, [Parameter(Mandatory=$true)][string]$DataDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$memoText = 'REA unicode ' + [char]0xD55C + [char]0xAE00 + ' 42'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$cases = [System.Collections.Generic.List[object]]::new()
$app = $null
function Start-App {
    $script:app = Start-Process -FilePath $AppExe -ArgumentList @('--data-dir', ('"' + $DataDirectory + '"')) -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $script:app.Refresh()
        if ($script:app.HasExited) { throw 'Application exited before creating its window' }
        if ($script:app.MainWindowHandle -ne [IntPtr]::Zero) {
            $script:window = [System.Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Window not available within deadline'
}
function Element([string]$Name) {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Name)
    $element = $script:window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $element) { throw "Missing UI control $Name" }
    return $element
}
function Set-Value([string]$Name, [string]$Value) {
    $pattern = (Element $Name).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $pattern.SetValue($Value)
}
function Read-Value([string]$Name) {
    return (Element $Name).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
}
function Click([string]$Name) {
    (Element $Name).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function Expect([string]$Name, [string]$Control, [string]$Expected) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $actual = Read-Value $Control
        if ($actual -ceq $Expected) {
            $cases.Add(@{ name=$Name; expected=$Expected; actual=$actual; passed=$true })
            return
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name expected <$Expected> but observed <$actual>"
}
function Close-App {
    if ($null -ne $script:app -and -not $script:app.HasExited) {
        [void]$script:app.CloseMainWindow()
        if (-not $script:app.WaitForExit(5000)) { throw 'Window did not close gracefully' }
    }
}
try {
    Start-App
    Click 'load'; Expect 'empty persistence' 'status' 'Missing'
    Set-Value 'left' '12'; Set-Value 'right' '30'; Click 'calculate'; Expect 'integer addition' 'result' '42'
    Set-Value 'left' '-2.5'; Set-Value 'right' '1.25'; Click 'calculate'; Expect 'negative decimals' 'result' '-1.25'
    Set-Value 'left' 'invalid'; Click 'calculate'; Expect 'invalid input' 'result' 'Invalid input'
    Set-Value 'left' '79228162514264337593543950335'; Set-Value 'right' '1'; Click 'calculate'; Expect 'overflow' 'result' 'Overflow'
    Click 'clear'; Expect 'clear left' 'left' ''; Expect 'clear right' 'right' ''; Expect 'clear result' 'result' ''
    Set-Value 'memo' $memoText; Click 'save'; Expect 'save' 'status' 'Saved'
    Close-App
    Start-App
    Click 'load'; Expect 'load after restart' 'status' 'Loaded'; Expect 'persistent unicode memo' 'memo' $memoText
    Close-App
    @{ passed=$true; cases=@($cases.ToArray()); process_exit=$app.ExitCode } | ConvertTo-Json -Depth 8 -Compress
} finally {
    # The enclosing production Job Object owns this process and all descendants;
    # a failure here propagates to that owner for identity-checked cleanup.
    Close-App
}
