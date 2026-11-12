// Codex emits compact envelopes: id first on success, error then id on failure.
const BASH = String.raw`
set -eu
command -v codex >/dev/null 2>&1 || exit 127
set -m
usage_dir=$(mktemp -d -t herdr-usage.XXXXXXXX)
usage_pid=
cleanup() {
  exec 3>&- 4<&-
  if [ -n "$usage_pid" ]; then
    usage_until=$((SECONDS + 2))
    while kill -0 "$usage_pid" 2>/dev/null && [ "$SECONDS" -lt "$usage_until" ]; do sleep 0.05; done
    kill -KILL -- "-$usage_pid" 2>/dev/null || true
    wait "$usage_pid" 2>/dev/null || true
  fi
  rm -rf "$usage_dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkfifo "$usage_dir/in" "$usage_dir/out"
exec 3<>"$usage_dir/in"
codex app-server --listen stdio:// 3>&- <"$usage_dir/in" >"$usage_dir/out" 2>/dev/null &
usage_pid=$!
exec 4<"$usage_dir/out"
usage_deadline=$((SECONDS + 30))
printf '%s\n' '{"id":"usage-init","method":"initialize","params":{"clientInfo":{"name":"herdr-usage","version":"1"},"capabilities":{}}}' >&3
usage_phase=init
while [ "$SECONDS" -lt "$usage_deadline" ] && IFS= read -r -t "$((usage_deadline - SECONDS))" usage_line <&4; do
  case "$usage_phase:$usage_line" in
    init:'{"id":"usage-init",'*|init:'{"error":'*',"id":"usage-init"}')
      case "$usage_line" in *'"error":'*) printf '%s\n' "$usage_line"; exit 1;; esac
      printf '%s\n' '{"method":"initialized"}' '{"id":"usage-account","method":"account/read","params":{"refreshToken":false}}' >&3
      usage_phase=account;;
    account:'{"id":"usage-account",'*|account:'{"error":'*',"id":"usage-account"}')
      printf '%s\n' "$usage_line"
      case "$usage_line" in *'"error":'*) exit 1;; esac
      printf '%s\n' '{"id":"usage-limits","method":"account/rateLimits/read"}' >&3
      usage_phase=limits;;
    limits:'{"id":"usage-limits",'*|limits:'{"error":'*',"id":"usage-limits"}') printf '%s\n' "$usage_line"; exit 0;;
  esac
done
if [ "$SECONDS" -ge "$usage_deadline" ]; then exit 124; fi
exit 1
`;

const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$usageProcess = $null
$usageJob = [IntPtr]::Zero
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HerdrUsageJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Counters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Limits {
    public Basic Basic;
    public Counters Counters;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Could not create usage process job");
    var limits = new Limits();
    limits.Basic.Flags = 0x2000; // Kill the owned process tree when its job handle closes.
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits)))) {
      CloseHandle(job);
      throw new Exception("Could not configure usage process job");
    }
    return job;
  }
}
'@
  $usageCommand = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$usageCommand) { exit 127 }
  $usageInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $usageInfo.FileName = $usageCommand.Source
  $usageInfo.Arguments = 'app-server --listen stdio://'
  if ([IO.Path]::GetExtension($usageCommand.Source) -in '.cmd', '.bat') {
    $usageInfo.FileName = $env:ComSpec
    $usageInfo.Arguments = '/d /s /c ""' + $usageCommand.Source + '" app-server --listen stdio://"'
  }
  $usageInfo.UseShellExecute = $false
  $usageInfo.CreateNoWindow = $true
  $usageInfo.RedirectStandardInput = $true
  $usageInfo.RedirectStandardOutput = $true
  $usageInfo.RedirectStandardError = $true
  $usageInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $usageProcess = [System.Diagnostics.Process]::new()
  $usageProcess.StartInfo = $usageInfo
  $usageJob = [HerdrUsageJob]::Create()
  if (![HerdrUsageJob]::AssignProcessToJobObject($usageJob, [HerdrUsageJob]::GetCurrentProcess())) {
    throw 'Could not contain usage process'
  }
  [void]$usageProcess.Start()
  $usageErrors = $usageProcess.StandardError.ReadToEndAsync()
  $usageDeadline = [DateTime]::UtcNow.AddSeconds(30)
  $usageProcess.StandardInput.WriteLine('{"id":"usage-init","method":"initialize","params":{"clientInfo":{"name":"herdr-usage","version":"1"},"capabilities":{}}}')
  $usagePhase = 'init'
  while ($true) {
    $usageRemaining = [int][Math]::Max(0, ($usageDeadline - [DateTime]::UtcNow).TotalMilliseconds)
    $usageRead = $usageProcess.StandardOutput.ReadLineAsync()
    if (!$usageRead.Wait($usageRemaining)) { exit 124 }
    if ($null -eq $usageRead.Result) { exit 1 }
    try { $usageReply = $usageRead.Result | ConvertFrom-Json } catch { continue }
    if ($usagePhase -eq 'init' -and $usageReply.id -eq 'usage-init') {
      if ($usageReply.error) { exit 1 }
      $usageProcess.StandardInput.WriteLine('{"method":"initialized"}')
      $usageProcess.StandardInput.WriteLine('{"id":"usage-account","method":"account/read","params":{"refreshToken":false}}')
      $usagePhase = 'account'
    } elseif ($usagePhase -eq 'account' -and $usageReply.id -eq 'usage-account') {
      [Console]::WriteLine($usageRead.Result)
      if ($usageReply.error) { exit 1 }
      $usageProcess.StandardInput.WriteLine('{"id":"usage-limits","method":"account/rateLimits/read"}')
      $usagePhase = 'limits'
    } elseif ($usagePhase -eq 'limits' -and $usageReply.id -eq 'usage-limits') {
      [Console]::WriteLine($usageRead.Result)
      exit 0
    }
  }
} catch { exit 1 } finally {
  if ($usageProcess) {
    try { $usageProcess.StandardInput.Close() } catch {}
    try {
      [void]$usageProcess.WaitForExit(2000)
    } catch {}
  }
  # Keep the wrapper's sole job handle until process exit, so even early launcher exits cannot orphan descendants.
  if ($usageProcess) { try { [void]$usageProcess.WaitForExit(2000) } catch {}; $usageProcess.Dispose() }
}
`;

export function codexCommand(platform) {
  return platform === "windows"
    ? ["powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL]]
    : ["bash", ["-c", BASH, "herdr-codex-usage"]];
}
