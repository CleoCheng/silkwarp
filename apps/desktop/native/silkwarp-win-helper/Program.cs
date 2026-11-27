using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace SilkWarpWinHelper
{
    internal static class Win32Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DISPLAY_DEVICE
        {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceString;
            public uint StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceKey;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DEVMODEW
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string dmDeviceName;
            public ushort dmSpecVersion;
            public ushort dmDriverVersion;
            public ushort dmSize;
            public ushort dmDriverExtra;
            public uint dmFields;
            public int dmPositionX;
            public int dmPositionY;
            public uint dmDisplayOrientation;
            public uint dmDisplayFixedOutput;
            public short dmColor;
            public short dmDuplex;
            public short dmYResolution;
            public short dmTTOption;
            public short dmCollate;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string dmFormName;
            public ushort dmLogPixels;
            public uint dmBitsPerPel;
            public uint dmPelsWidth;
            public uint dmPelsHeight;
            public uint dmDisplayFlags;
            public uint dmDisplayFrequency;
            public uint dmICMMethod;
            public uint dmICMIntent;
            public uint dmMediaType;
            public uint dmDitherType;
            public uint dmReserved1;
            public uint dmReserved2;
            public uint dmPanningWidth;
            public uint dmPanningHeight;
        }

        public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

        [DllImport("user32.dll")]
        public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr rect, MonitorEnumProc proc, IntPtr data);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool EnumDisplayDevices(string device, uint devNum, ref DISPLAY_DEVICE info, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool EnumDisplaySettingsW(string lpszDeviceName, int iModeNum, ref DEVMODEW lpDevMode);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool LockWorkStation();

        [DllImport("sas.dll", SetLastError = true)]
        public static extern void SendSAS(bool asUser);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool SetWindowTextW(IntPtr hWnd, string lpString);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeoutW(
            IntPtr hWnd,
            uint Msg,
            IntPtr wParam,
            IntPtr lParam,
            uint fuFlags,
            uint uTimeout,
            out IntPtr lpdwResult
        );

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern uint GetKeyboardLayoutList(int nBuff, [Out] IntPtr[] lpList);

        [DllImport("user32.dll")]
        public static extern IntPtr GetKeyboardLayout(uint idThread);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("imm32.dll")]
        public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ClassInterface(ClassInterfaceType.None)]
    internal class MMDeviceEnumeratorComObject
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);

        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);

        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);

        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr client);

        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePtr);

        [PreserveSig]
        int OpenPropertyStore(int access, out IntPtr properties);

        [PreserveSig]
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);

        [PreserveSig]
        int GetState(out int state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig]
        int RegisterControlChangeNotify(IntPtr notify);

        [PreserveSig]
        int UnregisterControlChangeNotify(IntPtr notify);

        [PreserveSig]
        int GetChannelCount(out uint channelCount);

        [PreserveSig]
        int SetMasterVolumeLevel(float level, ref Guid eventContext);

        [PreserveSig]
        int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);

        [PreserveSig]
        int GetMasterVolumeLevel(out float level);

        [PreserveSig]
        int GetMasterVolumeLevelScalar(out float level);

        [PreserveSig]
        int SetChannelVolumeLevel(uint channelNumber, float level, ref Guid eventContext);

        [PreserveSig]
        int SetChannelVolumeLevelScalar(uint channelNumber, float level, ref Guid eventContext);

        [PreserveSig]
        int GetChannelVolumeLevel(uint channelNumber, out float level);

        [PreserveSig]
        int GetChannelVolumeLevelScalar(uint channelNumber, out float level);

        [PreserveSig]
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);

        [PreserveSig]
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    internal static class CoreAudioHelper
    {
        private static IAudioEndpointVolume Open(out object enumeratorObj, out object deviceObj)
        {
            enumeratorObj = null;
            deviceObj = null;
            MMDeviceEnumeratorComObject enumerator = new MMDeviceEnumeratorComObject();
            enumeratorObj = enumerator;
            IMMDeviceEnumerator enumeratorInterface = (IMMDeviceEnumerator)enumerator;
            IMMDevice device;
            int hr = enumeratorInterface.GetDefaultAudioEndpoint(0, 1, out device);
            if (hr != 0 || device == null)
            {
                throw new COMException("GetDefaultAudioEndpoint failed", hr);
            }
            deviceObj = device;
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object volumeObj;
            hr = device.Activate(ref iid, 0, IntPtr.Zero, out volumeObj);
            if (hr != 0 || volumeObj == null)
            {
                throw new COMException("Activate failed", hr);
            }
            return (IAudioEndpointVolume)volumeObj;
        }

        public static bool GetMute()
        {
            object enumeratorObj = null;
            object deviceObj = null;
            object volumeObj = null;
            try
            {
                volumeObj = Open(out enumeratorObj, out deviceObj);
                IAudioEndpointVolume volume = (IAudioEndpointVolume)volumeObj;
                bool muted;
                int hr = volume.GetMute(out muted);
                if (hr != 0)
                {
                    throw new COMException("GetMute failed", hr);
                }
                return muted;
            }
            finally
            {
                if (volumeObj != null) Marshal.ReleaseComObject(volumeObj);
                if (deviceObj != null) Marshal.ReleaseComObject(deviceObj);
                if (enumeratorObj != null) Marshal.ReleaseComObject(enumeratorObj);
            }
        }

        public static bool SetMute(bool muted)
        {
            object enumeratorObj = null;
            object deviceObj = null;
            object volumeObj = null;
            try
            {
                volumeObj = Open(out enumeratorObj, out deviceObj);
                IAudioEndpointVolume volume = (IAudioEndpointVolume)volumeObj;
                Guid context = Guid.Empty;
                int hr = volume.SetMute(muted, ref context);
                if (hr != 0)
                {
                    throw new COMException("SetMute failed", hr);
                }
                bool current;
                hr = volume.GetMute(out current);
                if (hr != 0)
                {
                    throw new COMException("GetMute failed", hr);
                }
                return current;
            }
            finally
            {
                if (volumeObj != null) Marshal.ReleaseComObject(volumeObj);
                if (deviceObj != null) Marshal.ReleaseComObject(deviceObj);
                if (enumeratorObj != null) Marshal.ReleaseComObject(enumeratorObj);
            }
        }
    }

    internal static class DisplaysHelper
    {
        private static string EscapeJson(string value)
        {
            if (value == null) return "";
            StringBuilder sb = new StringBuilder(value.Length + 8);
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '\\') sb.Append('\\').Append('\\');
                else if (c == '"') sb.Append('\\').Append('"');
                else if (c == '\n') sb.Append('\\').Append('n');
                else if (c == '\r') sb.Append('\\').Append('r');
                else if (c == '\t') sb.Append('\\').Append('t');
                else if (c < ' ') sb.Append('\\').Append('u').Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static bool IsVirtual(string friendly, string deviceId, string driver)
        {
            string haystack = ((friendly ?? "") + " " + (deviceId ?? "") + " " + (driver ?? "")).ToLowerInvariant();
            return haystack.Contains("virtual")
                || haystack.Contains("sudomaker")
                || haystack.Contains("apollo")
                || haystack.Contains("indirect display")
                || haystack.Contains("usb mobile monitor")
                || haystack.Contains("iddsample");
        }

        public static string[] GetDisplayJsonLines()
        {
            List<string> lines = new List<string>();
            Dictionary<string, string> adapters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            Win32Native.DISPLAY_DEVICE adapter = new Win32Native.DISPLAY_DEVICE();
            adapter.cb = Marshal.SizeOf(typeof(Win32Native.DISPLAY_DEVICE));
            uint adapterIndex = 0;
            while (Win32Native.EnumDisplayDevices(null, adapterIndex, ref adapter, 0))
            {
                if (!string.IsNullOrEmpty(adapter.DeviceName))
                {
                    adapters[adapter.DeviceName] = adapter.DeviceString;
                }
                adapter = new Win32Native.DISPLAY_DEVICE();
                adapter.cb = Marshal.SizeOf(typeof(Win32Native.DISPLAY_DEVICE));
                adapterIndex++;
            }

            int index = 0;
            Win32Native.MonitorEnumProc callback = delegate(IntPtr hMonitor, IntPtr hdc, ref Win32Native.RECT rect, IntPtr data)
            {
                Win32Native.MONITORINFOEX info = new Win32Native.MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(Win32Native.MONITORINFOEX));
                if (!Win32Native.GetMonitorInfo(hMonitor, ref info)) return true;

                Win32Native.DISPLAY_DEVICE device = new Win32Native.DISPLAY_DEVICE();
                device.cb = Marshal.SizeOf(typeof(Win32Native.DISPLAY_DEVICE));
                string friendly = "";
                string deviceId = "";
                if (Win32Native.EnumDisplayDevices(info.szDevice, 0, ref device, 0))
                {
                    friendly = device.DeviceString;
                    deviceId = device.DeviceID;
                }

                string driver;
                if (!adapters.TryGetValue(info.szDevice, out driver))
                {
                    driver = "";
                }

                int width = info.rcMonitor.Right - info.rcMonitor.Left;
                int height = info.rcMonitor.Bottom - info.rcMonitor.Top;
                int refreshHz = 0;
                Win32Native.DEVMODEW devMode = new Win32Native.DEVMODEW();
                devMode.dmSize = (ushort)Marshal.SizeOf(typeof(Win32Native.DEVMODEW));
                if (Win32Native.EnumDisplaySettingsW(info.szDevice, -1, ref devMode) && devMode.dmPelsWidth > 0 && devMode.dmPelsHeight > 0)
                {
                    width = (int)devMode.dmPelsWidth;
                    height = (int)devMode.dmPelsHeight;
                    if (devMode.dmDisplayFrequency > 0 && devMode.dmDisplayFrequency <= 1000)
                    {
                        refreshHz = (int)devMode.dmDisplayFrequency;
                    }
                }

                bool primary = (info.dwFlags & 1) == 1;
                bool virtualMonitor = IsVirtual(friendly, deviceId, driver);

                StringBuilder sb = new StringBuilder();
                sb.Append("{");
                sb.Append("\"index\":").Append(index).Append(",");
                sb.Append("\"id\":\"").Append(EscapeJson(info.szDevice)).Append("\",");
                sb.Append("\"deviceName\":\"").Append(EscapeJson(info.szDevice)).Append("\",");
                sb.Append("\"friendlyName\":\"").Append(EscapeJson(friendly)).Append("\",");
                sb.Append("\"deviceId\":\"").Append(EscapeJson(deviceId)).Append("\",");
                sb.Append("\"driver\":\"").Append(EscapeJson(driver)).Append("\",");
                sb.Append("\"width\":").Append(width).Append(",");
                sb.Append("\"height\":").Append(height).Append(",");
                sb.Append("\"refreshHz\":").Append(refreshHz).Append(",");
                sb.Append("\"x\":").Append(info.rcMonitor.Left).Append(",");
                sb.Append("\"y\":").Append(info.rcMonitor.Top).Append(",");
                sb.Append("\"isPrimary\":").Append(primary ? "true" : "false").Append(",");
                sb.Append("\"isVirtual\":").Append(virtualMonitor ? "true" : "false").Append(",");
                sb.Append("\"active\":true");
                sb.Append("}");
                lines.Add(sb.ToString());
                index++;
                return true;
            };

            Win32Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
            return lines.ToArray();
        }
    }

    internal static class SystemActionsHelper
    {
        public static int RunAction(string actionName)
        {
            string normalized = (actionName ?? "").Trim().ToLowerInvariant();
            if (normalized == "lock")
            {
                bool ok = Win32Native.LockWorkStation();
                Console.WriteLine(ok ? "<<<SILKWARP_ACTION:OK>>>" : "<<<SILKWARP_ACTION:FAILED>>>");
                return 0;
            }
            if (normalized == "show_desktop")
            {
                Type shellType = Type.GetTypeFromProgID("Shell.Application");
                if (shellType == null)
                {
                    Console.WriteLine("<<<SILKWARP_ACTION:FAILED>>>");
                    return 0;
                }
                object shellObj = null;
                try
                {
                    shellObj = Activator.CreateInstance(shellType);
                    shellType.InvokeMember("MinimizeAll", BindingFlags.InvokeMethod, null, shellObj, null);
                    Console.WriteLine("<<<SILKWARP_ACTION:OK>>>");
                }
                catch
                {
                    Console.WriteLine("<<<SILKWARP_ACTION:FAILED>>>");
                }
                finally
                {
                    if (shellObj != null && Marshal.IsComObject(shellObj))
                    {
                        Marshal.ReleaseComObject(shellObj);
                    }
                }
                return 0;
            }
            if (normalized == "sas")
            {
                try
                {
                    object policyObj = Registry.GetValue(
                        @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System",
                        "SoftwareSASGeneration",
                        null
                    );
                    if (policyObj == null || Convert.ToInt32(policyObj) < 2)
                    {
                        Console.WriteLine("<<<SILKWARP_SAS:DENIED>>>");
                        return 0;
                    }
                    Win32Native.SendSAS(false);
                    Console.WriteLine("<<<SILKWARP_SAS:OK>>>");
                }
                catch
                {
                    Console.WriteLine("<<<SILKWARP_SAS:DENIED>>>");
                }
                return 0;
            }
            if (normalized == "repair_ime")
            {
                string[] targets = new string[] { "TextInputHost", "ChsIME", "ctfmon" };
                for (int i = 0; i < targets.Length; i++)
                {
                    try
                    {
                        Process[] procs = Process.GetProcessesByName(targets[i]);
                        for (int j = 0; j < procs.Length; j++)
                        {
                            try
                            {
                                procs[j].Kill();
                            }
                            catch
                            {
                            }
                            finally
                            {
                                procs[j].Dispose();
                            }
                        }
                    }
                    catch
                    {
                    }
                }
                Thread.Sleep(150);
                try
                {
                    string windir = Environment.GetEnvironmentVariable("WINDIR");
                    if (string.IsNullOrEmpty(windir)) windir = @"C:\Windows";
                    string ctfmon = Path.Combine(windir, @"System32\ctfmon.exe");
                    if (File.Exists(ctfmon))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = ctfmon;
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        using (Process started = Process.Start(psi))
                        {
                        }
                    }
                }
                catch
                {
                }
                Console.WriteLine("<<<SILKWARP_ACTION:OK>>>");
                return 0;
            }

            Console.WriteLine("<<<SILKWARP_ACTION:FAILED>>>");
            return 1;
        }
    }

    internal static class WindowTrackerHelper
    {
        private const int PollIntervalMs = 200;
        private const byte VkControl = 0x11;
        private const byte VkMenu = 0x12;
        private const byte VkShift = 0x10;

        private static readonly ConcurrentQueue<string> InputQueue = new ConcurrentQueue<string>();
        private static volatile bool InputEof = false;

        private static void StartStdinReader()
        {
            Thread t = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        InputQueue.Enqueue(line);
                    }
                }
                catch
                {
                }
                InputEof = true;
            });
            t.IsBackground = true;
            t.Start();
        }

        private static void EmitJson(string json)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }

        private static void EnsureWindowTitle(IntPtr hWnd, string desired)
        {
            if (hWnd == IntPtr.Zero || string.IsNullOrEmpty(desired)) return;
            try
            {
                StringBuilder sb = new StringBuilder(256);
                Win32Native.GetWindowTextW(hWnd, sb, sb.Capacity);
                string current = sb.ToString();
                if (string.IsNullOrEmpty(current) || current.IndexOf("Moonlight", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    if (!string.Equals(current, desired, StringComparison.Ordinal))
                    {
                        Win32Native.SetWindowTextW(hWnd, desired);
                    }
                }
            }
            catch
            {
            }
        }

        private static void SuppressLocalIme(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return;
            try
            {
                IntPtr hImeWnd = Win32Native.ImmGetDefaultIMEWnd(hWnd);
                if (hImeWnd != IntPtr.Zero)
                {
                    IntPtr openStatus;
                    Win32Native.SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0005, IntPtr.Zero, 0x0002u, 50u, out openStatus);
                    if (openStatus != IntPtr.Zero)
                    {
                        IntPtr r1;
                        Win32Native.SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0006, IntPtr.Zero, 0x0002u, 50u, out r1);
                    }
                    IntPtr conv;
                    Win32Native.SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0001, IntPtr.Zero, 0x0002u, 50u, out conv);
                    if ((conv.ToInt64() & 1L) != 0L)
                    {
                        IntPtr r2;
                        Win32Native.SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0002, IntPtr.Zero, 0x0002u, 50u, out r2);
                    }
                }
                uint pid;
                uint tid = Win32Native.GetWindowThreadProcessId(hWnd, out pid);
                if (tid != 0)
                {
                    IntPtr cur = Win32Native.GetKeyboardLayout(tid);
                    if ((cur.ToInt64() & 0x3FFL) != 0x09L)
                    {
                        uint count = Win32Native.GetKeyboardLayoutList(0, null);
                        if (count > 0 && count <= 64)
                        {
                            IntPtr[] list = new IntPtr[count];
                            uint got = Win32Native.GetKeyboardLayoutList((int)count, list);
                            for (int i = 0; i < got; i++)
                            {
                                if ((list[i].ToInt64() & 0x3FFL) == 0x09L)
                                {
                                    Win32Native.PostMessageW(hWnd, 0x0050u, IntPtr.Zero, list[i]);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            catch
            {
            }
        }

        private static void SendHotkey(int vk)
        {
            byte[] stales = new byte[] { 0x46, 0x0D };
            for (int i = 0; i < stales.Length; i++)
            {
                byte s = stales[i];
                Win32Native.keybd_event(s, (byte)Win32Native.MapVirtualKey((uint)s, 0), 0x0002u, UIntPtr.Zero);
            }

            byte scan = (byte)Win32Native.MapVirtualKey((uint)vk, 0);
            byte[] mods = new byte[] { VkControl, VkMenu, VkShift };
            for (int i = 0; i < mods.Length; i++)
            {
                byte m = mods[i];
                Win32Native.keybd_event(m, (byte)Win32Native.MapVirtualKey((uint)m, 0), 0u, UIntPtr.Zero);
            }
            Win32Native.keybd_event((byte)vk, scan, 0u, UIntPtr.Zero);
            Thread.Sleep(25);
            Win32Native.keybd_event((byte)vk, scan, 0x0002u, UIntPtr.Zero);
            for (int i = mods.Length - 1; i >= 0; i--)
            {
                byte m = mods[i];
                Win32Native.keybd_event(m, (byte)Win32Native.MapVirtualKey((uint)m, 0), 0x0002u, UIntPtr.Zero);
            }
        }

        private static int ResolveHotkeyVk(string action)
        {
            if (action == "FULLSCREEN") return 0x58; // X
            if (action == "PERF") return 0x53; // S
            if (action == "MOUSE") return 0x5A; // Z
            return 0;
        }

        public static int RunTrack(string[] args)
        {
            int targetPid;
            if (args.Length < 2 || !int.TryParse(args[1], out targetPid) || targetPid <= 0)
            {
                return 1;
            }

            string desiredTitle = "";
            bool suppressLocalIme = true;
            for (int i = 2; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--title-b64" && i + 1 < args.Length)
                {
                    string b64 = args[++i];
                    if (!string.IsNullOrEmpty(b64))
                    {
                        try
                        {
                            desiredTitle = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
                        }
                        catch
                        {
                            desiredTitle = "";
                        }
                    }
                }
                else if (arg == "--no-suppress-ime")
                {
                    suppressLocalIme = false;
                }
            }

            StartStdinReader();

            string lastSig = "";
            bool exited = false;
            DateTime eofSince = DateTime.MinValue;
            IntPtr lastTitleHwnd = IntPtr.Zero;
            DateTime lastTitleSyncUtc = DateTime.MinValue;
            IntPtr lastImeHwnd = IntPtr.Zero;
            bool wasForeground = false;

            Process targetProc = null;
            try
            {
                targetProc = Process.GetProcessById(targetPid);
            }
            catch
            {
                EmitJson("{\"type\":\"exit\"}");
                return 0;
            }

            try
            {
                while (!exited)
                {
                    IntPtr hwnd = IntPtr.Zero;
                    try
                    {
                        targetProc.Refresh();
                        if (targetProc.HasExited)
                        {
                            EmitJson("{\"type\":\"exit\"}");
                            break;
                        }
                        hwnd = targetProc.MainWindowHandle;
                    }
                    catch
                    {
                        EmitJson("{\"type\":\"exit\"}");
                        break;
                    }

                    string cmd;
                    while (InputQueue.TryDequeue(out cmd))
                    {
                        string upper = (cmd ?? "").Trim().ToUpperInvariant();
                        if (upper == "QUIT")
                        {
                            exited = true;
                            break;
                        }
                        if (upper == "FOCUS")
                        {
                            if (hwnd != IntPtr.Zero)
                            {
                                Win32Native.SetForegroundWindow(hwnd);
                            }
                            continue;
                        }
                        if (upper.StartsWith("HOTKEY:"))
                        {
                            string action = upper.Substring(7).Trim();
                            if (hwnd != IntPtr.Zero)
                            {
                                Win32Native.SetForegroundWindow(hwnd);
                                Thread.Sleep(60);
                            }
                            int vk = ResolveHotkeyVk(action);
                            if (vk > 0)
                            {
                                SendHotkey(vk);
                            }
                        }
                    }
                    if (exited) break;

                    if (InputEof && InputQueue.IsEmpty)
                    {
                        if (eofSince == DateTime.MinValue) eofSince = DateTime.UtcNow;
                        if ((DateTime.UtcNow - eofSince).TotalSeconds >= 5.0) break;
                    }
                    else
                    {
                        eofSince = DateTime.MinValue;
                    }

                    if (hwnd != IntPtr.Zero)
                    {
                        Win32Native.RECT wr;
                        Win32Native.RECT cr;
                        if (Win32Native.GetWindowRect(hwnd, out wr) && Win32Native.GetClientRect(hwnd, out cr))
                        {
                            int width = wr.Right - wr.Left;
                            int height = wr.Bottom - wr.Top;
                            if (width > 0 && height > 0)
                            {
                                bool visible = Win32Native.IsWindowVisible(hwnd);
                                bool minimized = Win32Native.IsIconic(hwnd);
                                bool foreground = (Win32Native.GetForegroundWindow() == hwnd);

                                if (!string.IsNullOrEmpty(desiredTitle))
                                {
                                    DateTime nowUtc = DateTime.UtcNow;
                                    if (hwnd != lastTitleHwnd || (!foreground && (nowUtc - lastTitleSyncUtc).TotalSeconds >= 10.0))
                                    {
                                        EnsureWindowTitle(hwnd, desiredTitle);
                                        lastTitleHwnd = hwnd;
                                        lastTitleSyncUtc = nowUtc;
                                    }
                                }

                                if (suppressLocalIme && (hwnd != lastImeHwnd || (!wasForeground && foreground)))
                                {
                                    SuppressLocalIme(hwnd);
                                    lastImeHwnd = hwnd;
                                }
                                wasForeground = foreground;

                                string sig = string.Concat(
                                    wr.Left.ToString(), ",",
                                    wr.Top.ToString(), ",",
                                    width.ToString(), ",",
                                    height.ToString(), ",",
                                    cr.Right.ToString(), ",",
                                    cr.Bottom.ToString(), ",",
                                    visible ? "1" : "0", ",",
                                    minimized ? "1" : "0", ",",
                                    foreground ? "1" : "0"
                                );
                                if (!string.Equals(sig, lastSig, StringComparison.Ordinal))
                                {
                                    lastSig = sig;
                                    StringBuilder json = new StringBuilder();
                                    json.Append("{\"type\":\"rect\",");
                                    json.Append("\"x\":").Append(wr.Left).Append(",");
                                    json.Append("\"y\":").Append(wr.Top).Append(",");
                                    json.Append("\"width\":").Append(width).Append(",");
                                    json.Append("\"height\":").Append(height).Append(",");
                                    json.Append("\"clientWidth\":").Append(cr.Right).Append(",");
                                    json.Append("\"clientHeight\":").Append(cr.Bottom).Append(",");
                                    json.Append("\"visible\":").Append(visible ? "true" : "false").Append(",");
                                    json.Append("\"minimized\":").Append(minimized ? "true" : "false").Append(",");
                                    json.Append("\"foreground\":").Append(foreground ? "true" : "false");
                                    json.Append("}");
                                    EmitJson(json.ToString());
                                }
                            }
                        }
                    }

                    Thread.Sleep(PollIntervalMs);
                }
            }
            finally
            {
                if (targetProc != null)
                {
                    targetProc.Dispose();
                }
            }

            return 0;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.InputEncoding = new UTF8Encoding(false);
            }
            catch
            {
            }

            if (args == null || args.Length == 0)
            {
                return 1;
            }

            string cmd = (args[0] ?? "").Trim().ToLowerInvariant();
            if (cmd == "ping")
            {
                Console.WriteLine("<<<SILKWARP_HELPER:OK>>>");
                return 0;
            }

            if (cmd == "displays")
            {
                Console.WriteLine("<<<SILKWARP_MONITORS>>>");
                try
                {
                    string[] lines = DisplaysHelper.GetDisplayJsonLines();
                    for (int i = 0; i < lines.Length; i++)
                    {
                        Console.WriteLine(lines[i]);
                    }
                }
                catch
                {
                }
                Console.WriteLine("<<<SILKWARP_END>>>");
                return 0;
            }

            if (cmd == "mute-get")
            {
                try
                {
                    bool muted = CoreAudioHelper.GetMute();
                    Console.WriteLine(muted ? "<<<SILKWARP_MUTE:true>>>" : "<<<SILKWARP_MUTE:false>>>");
                }
                catch
                {
                    Console.WriteLine("<<<SILKWARP_MUTE:false>>>");
                }
                return 0;
            }

            if (cmd == "mute-set")
            {
                bool targetMute = args.Length >= 2 && string.Equals(args[1].Trim(), "true", StringComparison.OrdinalIgnoreCase);
                try
                {
                    bool current = CoreAudioHelper.SetMute(targetMute);
                    Console.WriteLine(current ? "<<<SILKWARP_MUTE:true>>>" : "<<<SILKWARP_MUTE:false>>>");
                }
                catch
                {
                    Console.WriteLine("<<<SILKWARP_MUTE:false>>>");
                }
                return 0;
            }

            if (cmd == "action")
            {
                string actionName = args.Length >= 2 ? args[1] : "";
                return SystemActionsHelper.RunAction(actionName);
            }

            if (cmd == "track")
            {
                return WindowTrackerHelper.RunTrack(args);
            }

            return 1;
        }
    }
}
