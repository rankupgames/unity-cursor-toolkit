$ErrorActionPreference = 'Stop'

# CIM ExecutablePath needs debug privileges for other users' processes.
# Query only the image path; never request debug, termination or memory access.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class UnityCiProcessImage
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static string Read(uint processId)
    {
        IntPtr handle = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            uint size = 32768;
            var path = new StringBuilder((int)size);
            if (!QueryFullProcessImageName(handle, 0, path, ref size))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return path.ToString();
        }
        finally { CloseHandle(handle); }
    }
}
'@

foreach ($unityProcess in @(Get-CimInstance Win32_Process -Filter "Name = 'Unity.exe'" -ErrorAction Stop)) {
    try { $imagePath = [UnityCiProcessImage]::Read([uint32]$unityProcess.ProcessId) }
    catch { throw 'A Unity process path cannot be verified. Leave it open and run this check after normal save and quit.' }
    if ([string]::IsNullOrWhiteSpace($imagePath) -or $imagePath -notmatch '[\\/]Unity\.exe$') {
        throw 'A Unity process path cannot be verified. Leave it open and run this check after normal save and quit.'
    }
    if ($imagePath -match '[\\/]Editor[\\/]Unity\.exe$') {
        throw 'An existing Unity Editor is running. Leave it open and run this check after normal save and quit.'
    }
}
