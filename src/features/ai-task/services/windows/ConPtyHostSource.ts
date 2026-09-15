/**
 * AI Task - Windows ConPTY host program
 *
 * The Windows counterpart of `script(1)`: Windows PowerShell 5.1 compiles the
 * C# below with Add-Type and runs the CLI inside a pseudo console (ConPTY).
 *
 *   stdio 3 (frames) → ConPTY input     stdout ← ConPTY output (+ transcript)
 *   stderr ← errors and the exit sentinel
 *
 * Input uses descriptor 3 because PowerShell may consume a redirected stdin.
 * Session values and the gzipped source travel in TASKCHUTE_CONPTY_* env vars
 * (cleared before the CLI starts), keeping the PowerShell text fixed.
 */

import { gzipBase64 } from '../broker-source/EmbeddedProgramSource'
import {
  CONPTY_FRAME_INPUT,
  CONPTY_FRAME_RESIZE,
} from './ConPtyControlFrames'

/** Windows 10 1809: the first build with CreatePseudoConsole. */
export const MIN_CONPTY_WINDOWS_BUILD = 17763

export const CONPTY_HOST_ENV_PREFIX = 'TASKCHUTE_CONPTY_'
export const CONPTY_HOST_SOURCE_ENV = `${CONPTY_HOST_ENV_PREFIX}HOST`

export const CONPTY_PROBE_INPUT = 'TASKCHUTE_CONPTY_PROBE_INPUT'
export const CONPTY_PROBE_OK_MARKER = 'TASKCHUTE_CONPTY_OK'

/** Same value as TERMINAL_EXIT_SENTINEL (pinned by a test). */
export const CONPTY_HOST_EXIT_SENTINEL = '__TASKCHUTE_AI_EXIT__'

export const CONPTY_HOST_FAILURE_EXIT_CODE = 70
/** PowerShell is in Constrained Language Mode. */
export const CONPTY_CONSTRAINED_LANGUAGE_EXIT_CODE = 65

/** Must compile with the C# 5 compiler behind PowerShell 5.1's Add-Type. */
export const CONPTY_HOST_CSHARP = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TaskChute
{
    public static class ConPtyHost
    {
        private const string EnvPrefix = "${CONPTY_HOST_ENV_PREFIX}";
        private const string ExitSentinel = "${CONPTY_HOST_EXIT_SENTINEL}";
        private const string ProbeInput = "${CONPTY_PROBE_INPUT}";
        private const string ProbeOk = "${CONPTY_PROBE_OK_MARKER}";
        private const string ProbeOutput = "TASKCHUTE_CONPTY_PROBE_OUTPUT";
        private const int HostFailureExitCode = ${CONPTY_HOST_FAILURE_EXIT_CODE};
        private const int FrameInput = ${CONPTY_FRAME_INPUT};
        private const int FrameResize = ${CONPTY_FRAME_RESIZE};
        private const int ControlDescriptor = 3;
        private const int MaxFramePayload = 16 * 1024 * 1024;
        private const int MaxDimension = 999;
        // Let conhost render its last frame before closing the pseudo console.
        private const int ExitQuietMs = 150;
        private const int ExitQuietLimitMs = 1000;
        private const int OutputDrainLimitMs = 3000;

        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const int STARTF_USESTDHANDLES = 0x00000100;
        private const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint INFINITE = 0xFFFFFFFF;
        private const uint WAIT_OBJECT_0 = 0;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const byte CRT_FOPEN = 0x01;

        [StructLayout(LayoutKind.Sequential)]
        private struct COORD
        {
            public short X;
            public short Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, int nSize);

        [DllImport("kernel32.dll")]
        private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

        [DllImport("kernel32.dll")]
        private static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

        [DllImport("kernel32.dll")]
        private static extern void ClosePseudoConsole(IntPtr hPC);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadFile(IntPtr hFile, [Out] byte[] lpBuffer, int nNumberOfBytesToRead, out int lpNumberOfBytesRead, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll")]
        private static extern uint WaitForSingleObject(IntPtr hObject, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern int ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll")]
        private static extern void GetStartupInfoW(out STARTUPINFO lpStartupInfo);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandleW(string lpModuleName);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, BestFitMapping = false)]
        private static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

        public static int Run()
        {
            string mode = TakeEnvironment("MODE");
            string commandLine = TakeEnvironment("COMMAND_LINE");
            string cols = TakeEnvironment("COLS");
            string rows = TakeEnvironment("ROWS");
            string transcriptPath = TakeEnvironment("TRANSCRIPT");
            ClearHostEnvironment();
            try
            {
                if (!HasPseudoConsoleApi())
                {
                    return Fail("this Windows build has no pseudo console (ConPTY) API");
                }
                IntPtr control = FindInheritedControlPipe();
                if (control == IntPtr.Zero)
                {
                    return Fail("the control pipe was not inherited");
                }
                if (mode == "probe")
                {
                    return Probe(control);
                }
                if (string.IsNullOrEmpty(commandLine))
                {
                    return Fail("no command line was provided");
                }
                return RunSession(
                    control,
                    commandLine,
                    ParseDimension(cols, 80),
                    ParseDimension(rows, 24),
                    transcriptPath);
            }
            catch (Exception error)
            {
                return Fail(error.Message);
            }
        }

        private static int RunSession(IntPtr control, string commandLine, short cols, short rows, string transcriptPath)
        {
            FileStream transcript = OpenTranscript(transcriptPath);
            PseudoConsole console;
            try
            {
                console = PseudoConsole.Start(commandLine, cols, rows);
            }
            catch (Exception error)
            {
                CloseQuietly(transcript);
                return Fail(error.Message);
            }

            OutputPump output = new OutputPump(console.OutputRead, GetStdHandle(STD_OUTPUT_HANDLE), transcript, null);
            StartBackground(output.Run);
            ControlPump controlPump = new ControlPump(control, console);
            StartBackground(controlPump.Run);

            WaitForSingleObject(console.Process, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(console.Process, out exitCode))
            {
                exitCode = (uint)HostFailureExitCode;
            }
            output.WaitForQuiet(ExitQuietMs, ExitQuietLimitMs);
            console.Close();
            output.Finished.WaitOne(OutputDrainLimitMs);
            output.DetachTranscript();
            CloseQuietly(transcript);
            // Closing the job ends anything the CLI left running.
            console.ReleaseJob();
            WriteExitSentinel(exitCode);
            return unchecked((int)exitCode);
        }

        private static int Probe(IntPtr control)
        {
            ControlReader reader = new ControlReader(control);
            byte[] expected = Encoding.UTF8.GetBytes(ProbeInput);
            byte[] header = new byte[5];
            if (!reader.ReadExact(header, header.Length) || header[0] != FrameInput || ReadLength(header) != expected.Length)
            {
                return Fail("the control pipe carried no probe frame");
            }
            byte[] payload = new byte[expected.Length];
            if (!reader.ReadExact(payload, payload.Length) || Encoding.UTF8.GetString(payload) != ProbeInput)
            {
                return Fail("the control pipe carried an unexpected probe frame");
            }

            string shell = Environment.GetEnvironmentVariable("ComSpec");
            if (string.IsNullOrEmpty(shell) || shell.IndexOf('"') >= 0)
            {
                shell = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            }
            PseudoConsole console = PseudoConsole.Start("\"" + shell + "\" /d /c echo " + ProbeOutput, 80, 24);
            ProbeSink sink = new ProbeSink(ProbeOutput);
            OutputPump output = new OutputPump(console.OutputRead, IntPtr.Zero, null, sink.Append);
            StartBackground(output.Run);
            bool exited = WaitForSingleObject(console.Process, 10000) == WAIT_OBJECT_0;
            bool seen = sink.Seen.WaitOne(exited ? 3000 : 0);
            if (!exited)
            {
                console.Terminate();
            }
            console.Close();
            output.Finished.WaitOne(2000);
            console.ReleaseJob();
            if (!exited)
            {
                return Fail("the probe shell did not exit");
            }
            // The marker must arrive via the pseudo console, not an inherited stdout.
            if (!seen)
            {
                return Fail("the pseudo console did not relay the probe output");
            }
            WriteText(GetStdHandle(STD_OUTPUT_HANDLE), ProbeOk + "\n");
            return 0;
        }

        private sealed class PseudoConsole
        {
            public IntPtr Handle;
            public IntPtr InputWrite;
            public IntPtr OutputRead;
            public IntPtr Process;
            private IntPtr job;
            private readonly object sync = new object();
            private bool closed;

            public static PseudoConsole Start(string commandLine, short cols, short rows)
            {
                IntPtr inputRead;
                IntPtr inputWrite;
                IntPtr outputRead;
                IntPtr outputWrite;
                if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0))
                {
                    throw LastError("CreatePipe");
                }
                if (!CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0))
                {
                    int code = Marshal.GetLastWin32Error();
                    CloseHandle(inputRead);
                    CloseHandle(inputWrite);
                    throw Win32Error("CreatePipe", code);
                }
                COORD size = new COORD();
                size.X = cols;
                size.Y = rows;
                IntPtr handle;
                int result = CreatePseudoConsole(size, inputRead, outputWrite, 0, out handle);
                // The pseudo console holds its own duplicates of these ends.
                CloseHandle(inputRead);
                CloseHandle(outputWrite);
                if (result != 0)
                {
                    CloseHandle(inputWrite);
                    CloseHandle(outputRead);
                    throw new InvalidOperationException("CreatePseudoConsole failed (0x" + result.ToString("X8") + ")");
                }

                PseudoConsole console = new PseudoConsole();
                console.Handle = handle;
                console.InputWrite = inputWrite;
                console.OutputRead = outputRead;
                console.job = CreateKillOnCloseJob();

                IntPtr attributes = IntPtr.Zero;
                try
                {
                    IntPtr attributesSize = IntPtr.Zero;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributesSize);
                    attributes = Marshal.AllocHGlobal(attributesSize);
                    if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref attributesSize))
                    {
                        Marshal.FreeHGlobal(attributes);
                        attributes = IntPtr.Zero;
                        throw LastError("InitializeProcThreadAttributeList");
                    }
                    if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE), handle, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    {
                        throw LastError("UpdateProcThreadAttribute");
                    }

                    STARTUPINFOEX startup = new STARTUPINFOEX();
                    startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                    // Keep the CLI off this host's redirected stdio.
                    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                    startup.lpAttributeList = attributes;

                    PROCESS_INFORMATION process;
                    StringBuilder mutableCommandLine = new StringBuilder(commandLine, commandLine.Length + 1);
                    if (!CreateProcessW(null, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out process))
                    {
                        throw LastError("CreateProcess");
                    }
                    // Assign while suspended so every descendant starts in the job.
                    if (console.job != IntPtr.Zero && !AssignProcessToJobObject(console.job, process.hProcess))
                    {
                        CloseHandle(console.job);
                        console.job = IntPtr.Zero;
                    }
                    ResumeThread(process.hThread);
                    CloseHandle(process.hThread);
                    console.Process = process.hProcess;
                    return console;
                }
                catch
                {
                    // Close our ends first: undrained output blocks ClosePseudoConsole on older builds.
                    CloseHandle(inputWrite);
                    CloseHandle(outputRead);
                    console.Close();
                    console.ReleaseJob();
                    throw;
                }
                finally
                {
                    if (attributes != IntPtr.Zero)
                    {
                        DeleteProcThreadAttributeList(attributes);
                        Marshal.FreeHGlobal(attributes);
                    }
                }
            }

            public void Resize(int cols, int rows)
            {
                COORD size = new COORD();
                size.X = (short)Math.Min(cols, MaxDimension);
                size.Y = (short)Math.Min(rows, MaxDimension);
                lock (sync)
                {
                    if (!closed)
                    {
                        ResizePseudoConsole(Handle, size);
                    }
                }
            }

            public void Close()
            {
                lock (sync)
                {
                    if (closed)
                    {
                        return;
                    }
                    closed = true;
                }
                // May block on older builds until the output pump drains the pipe.
                ClosePseudoConsole(Handle);
            }

            public void Terminate()
            {
                if (job != IntPtr.Zero && TerminateJobObject(job, 1))
                {
                    return;
                }
                if (Process != IntPtr.Zero)
                {
                    TerminateProcess(Process, 1);
                }
            }

            public void ReleaseJob()
            {
                IntPtr current = Interlocked.Exchange(ref job, IntPtr.Zero);
                if (current != IntPtr.Zero)
                {
                    CloseHandle(current);
                }
            }
        }

        private sealed class OutputPump
        {
            private readonly IntPtr source;
            private readonly IntPtr destination;
            private readonly Action<byte[], int> observer;
            private FileStream transcript;
            private long lastOutputTicks = DateTime.UtcNow.Ticks;
            public readonly ManualResetEvent Finished = new ManualResetEvent(false);

            public OutputPump(IntPtr source, IntPtr destination, FileStream transcript, Action<byte[], int> observer)
            {
                this.source = source;
                this.destination = destination;
                this.transcript = transcript;
                this.observer = observer;
            }

            public void Run()
            {
                byte[] buffer = new byte[65536];
                try
                {
                    while (true)
                    {
                        int read;
                        if (!ReadFile(source, buffer, buffer.Length, out read, IntPtr.Zero) || read <= 0)
                        {
                            break;
                        }
                        Interlocked.Exchange(ref lastOutputTicks, DateTime.UtcNow.Ticks);
                        if (destination != IntPtr.Zero)
                        {
                            WriteAll(destination, buffer, read);
                        }
                        FileStream file = transcript;
                        if (file != null)
                        {
                            try
                            {
                                file.Write(buffer, 0, read);
                                file.Flush();
                            }
                            catch (Exception)
                            {
                                transcript = null;
                            }
                        }
                        if (observer != null)
                        {
                            observer(buffer, read);
                        }
                    }
                }
                finally
                {
                    Finished.Set();
                }
            }

            public void WaitForQuiet(int quietMs, int limitMs)
            {
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(limitMs);
                while (DateTime.UtcNow < deadline && !Finished.WaitOne(0))
                {
                    long last = Interlocked.Read(ref lastOutputTicks);
                    if ((DateTime.UtcNow.Ticks - last) / TimeSpan.TicksPerMillisecond >= quietMs)
                    {
                        return;
                    }
                    Thread.Sleep(25);
                }
            }

            public void DetachTranscript()
            {
                transcript = null;
            }
        }

        private sealed class ControlPump
        {
            private readonly ControlReader reader;
            private readonly PseudoConsole console;

            public ControlPump(IntPtr control, PseudoConsole console)
            {
                reader = new ControlReader(control);
                this.console = console;
            }

            public void Run()
            {
                byte[] header = new byte[5];
                while (reader.ReadExact(header, header.Length))
                {
                    long length = ReadLength(header);
                    if (length > MaxFramePayload)
                    {
                        break;
                    }
                    byte[] payload = new byte[length];
                    if (length > 0 && !reader.ReadExact(payload, payload.Length))
                    {
                        break;
                    }
                    if (header[0] == FrameInput)
                    {
                        if (payload.Length > 0)
                        {
                            WriteAll(console.InputWrite, payload, payload.Length);
                        }
                    }
                    else if (header[0] == FrameResize && payload.Length == 4)
                    {
                        int cols = (payload[0] << 8) | payload[1];
                        int rows = (payload[2] << 8) | payload[3];
                        if (cols > 0 && rows > 0)
                        {
                            console.Resize(cols, rows);
                        }
                    }
                }
                // The plugin closed the pipe, so nobody can drive this CLI.
                console.Terminate();
            }
        }

        private sealed class ControlReader
        {
            private readonly IntPtr handle;
            private readonly byte[] buffer = new byte[65536];
            private int offset;
            private int count;

            public ControlReader(IntPtr handle)
            {
                this.handle = handle;
            }

            public bool ReadExact(byte[] target, int length)
            {
                int filled = 0;
                while (filled < length)
                {
                    if (offset == count)
                    {
                        int read;
                        if (!ReadFile(handle, buffer, buffer.Length, out read, IntPtr.Zero) || read <= 0)
                        {
                            return false;
                        }
                        offset = 0;
                        count = read;
                    }
                    int take = Math.Min(length - filled, count - offset);
                    Buffer.BlockCopy(buffer, offset, target, filled, take);
                    filled += take;
                    offset += take;
                }
                return true;
            }
        }

        private sealed class ProbeSink
        {
            private readonly string marker;
            private readonly StringBuilder text = new StringBuilder();
            public readonly ManualResetEvent Seen = new ManualResetEvent(false);

            public ProbeSink(string marker)
            {
                this.marker = marker;
            }

            public void Append(byte[] buffer, int length)
            {
                if (text.Length > 65536)
                {
                    return;
                }
                text.Append(Encoding.UTF8.GetString(buffer, 0, length));
                if (text.ToString().IndexOf(marker, StringComparison.Ordinal) >= 0)
                {
                    Seen.Set();
                }
            }
        }

        private static long ReadLength(byte[] header)
        {
            return ((long)header[1] << 24) | ((long)header[2] << 16) | ((long)header[3] << 8) | header[4];
        }

        private static bool HasPseudoConsoleApi()
        {
            IntPtr kernel32 = GetModuleHandleW("kernel32.dll");
            return kernel32 != IntPtr.Zero && GetProcAddress(kernel32, "CreatePseudoConsole") != IntPtr.Zero;
        }

        // Node's extra stdio in STARTUPINFO.lpReserved2 (MSVC CRT layout):
        // int count, one flag byte and one unaligned HANDLE per descriptor.
        private static IntPtr FindInheritedControlPipe()
        {
            STARTUPINFO info;
            GetStartupInfoW(out info);
            int size = info.cbReserved2;
            if (info.lpReserved2 == IntPtr.Zero || size < 4)
            {
                return IntPtr.Zero;
            }
            int descriptors = Marshal.ReadInt32(info.lpReserved2);
            if (descriptors <= ControlDescriptor || descriptors > 255)
            {
                return IntPtr.Zero;
            }
            if (4L + descriptors + (long)descriptors * IntPtr.Size > size)
            {
                return IntPtr.Zero;
            }
            byte flags = Marshal.ReadByte(info.lpReserved2, 4 + ControlDescriptor);
            if ((flags & CRT_FOPEN) == 0)
            {
                return IntPtr.Zero;
            }
            IntPtr handle = Marshal.ReadIntPtr(info.lpReserved2, 4 + descriptors + ControlDescriptor * IntPtr.Size);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1))
            {
                return IntPtr.Zero;
            }
            return handle;
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                return IntPtr.Zero;
            }
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }

        private static FileStream OpenTranscript(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return null;
            }
            try
            {
                return new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void CloseQuietly(FileStream stream)
        {
            if (stream == null)
            {
                return;
            }
            try
            {
                stream.Dispose();
            }
            catch (Exception)
            {
            }
        }

        private static string TakeEnvironment(string name)
        {
            string value = Environment.GetEnvironmentVariable(EnvPrefix + name);
            Environment.SetEnvironmentVariable(EnvPrefix + name, null);
            return value;
        }

        private static void ClearHostEnvironment()
        {
            List<string> names = new List<string>();
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                string name = entry.Key as string;
                if (name != null && name.StartsWith(EnvPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    names.Add(name);
                }
            }
            foreach (string name in names)
            {
                Environment.SetEnvironmentVariable(name, null);
            }
        }

        private static short ParseDimension(string value, short fallback)
        {
            int parsed;
            if (!int.TryParse(value, out parsed) || parsed < 1)
            {
                return fallback;
            }
            return (short)Math.Min(parsed, MaxDimension);
        }

        private static void StartBackground(ThreadStart body)
        {
            Thread thread = new Thread(body);
            thread.IsBackground = true;
            thread.Start();
        }

        // A failed write means the reader is gone; drop the bytes.
        private static void WriteAll(IntPtr handle, byte[] data, int length)
        {
            byte[] pending = data;
            int remaining = length;
            while (remaining > 0)
            {
                int written;
                if (!WriteFile(handle, pending, remaining, out written, IntPtr.Zero) || written <= 0)
                {
                    return;
                }
                remaining -= written;
                if (remaining > 0)
                {
                    byte[] rest = new byte[remaining];
                    Buffer.BlockCopy(pending, written, rest, 0, remaining);
                    pending = rest;
                }
            }
        }

        private static void WriteText(IntPtr handle, string text)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(text);
            WriteAll(handle, bytes, bytes.Length);
        }

        private static void WriteExitSentinel(uint exitCode)
        {
            WriteText(GetStdHandle(STD_ERROR_HANDLE), ExitSentinel + exitCode.ToString() + "\n");
        }

        private static int Fail(string message)
        {
            IntPtr stderr = GetStdHandle(STD_ERROR_HANDLE);
            WriteText(stderr, "TaskChute ConPTY host: " + message + "\r\n");
            WriteExitSentinel((uint)HostFailureExitCode);
            return HostFailureExitCode;
        }

        private static Exception LastError(string operation)
        {
            return Win32Error(operation, Marshal.GetLastWin32Error());
        }

        private static Exception Win32Error(string operation, int code)
        {
            return new InvalidOperationException(operation + " failed: " + new System.ComponentModel.Win32Exception(code).Message + " (" + code + ")");
        }
    }
}
`

/** Fixed loader: reads everything from env and has no double quotes to re-escape. */
export const CONPTY_HOST_LOADER = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  `if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){exit ${CONPTY_CONSTRAINED_LANGUAGE_EXIT_CODE}}`,
  `$b=[Convert]::FromBase64String($env:${CONPTY_HOST_SOURCE_ENV})`,
  '$m=New-Object System.IO.MemoryStream(,$b)',
  '$g=New-Object System.IO.Compression.GZipStream($m,[System.IO.Compression.CompressionMode]::Decompress)',
  '$s=(New-Object System.IO.StreamReader($g)).ReadToEnd()',
  'Add-Type -TypeDefinition $s -Language CSharp',
  '[Environment]::Exit([TaskChute.ConPtyHost]::Run())',
].join(';')

export const CONPTY_HOST_POWERSHELL_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  CONPTY_HOST_LOADER,
]

let cachedEncodedSource: string | undefined

/** gzip+base64 of the C# source, built lazily because zlib is desktop-only. */
export function getEncodedConPtyHostSource(): string {
  cachedEncodedSource ??= gzipBase64(CONPTY_HOST_CSHARP)
  return cachedEncodedSource
}

export interface ConPtyHostSessionOptions {
  commandLine: string
  cols: number
  rows: number
  transcriptPath: string
}

export function buildConPtyHostEnv(
  options: ConPtyHostSessionOptions | { probe: true },
): Record<string, string> {
  const env: Record<string, string> = {
    [CONPTY_HOST_SOURCE_ENV]: getEncodedConPtyHostSource(),
  }
  if ('probe' in options) {
    env[`${CONPTY_HOST_ENV_PREFIX}MODE`] = 'probe'
    return env
  }
  env[`${CONPTY_HOST_ENV_PREFIX}MODE`] = 'session'
  env[`${CONPTY_HOST_ENV_PREFIX}COMMAND_LINE`] = options.commandLine
  env[`${CONPTY_HOST_ENV_PREFIX}COLS`] = String(options.cols)
  env[`${CONPTY_HOST_ENV_PREFIX}ROWS`] = String(options.rows)
  env[`${CONPTY_HOST_ENV_PREFIX}TRANSCRIPT`] = options.transcriptPath
  return env
}

/** Absolute path, never a `powershell.exe` found on PATH. */
export function getWindowsPowerShellPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  return (
    `${systemRoot.replace(/[\\/]+$/u, '')}` +
    '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
}

/** Build number from `os.release()` ("10.0.22631" → 22631). */
export function parseWindowsBuildNumber(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)/u.exec(release.trim())
  if (!match) return null
  const build = Number(match[1])
  return Number.isSafeInteger(build) ? build : null
}
