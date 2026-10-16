// Embeds a Node single-executable-app blob into a copy of node.exe, the same thing
// `postject` does, using only Windows' own resource APIs (no downloads needed).
// Usage: inject.exe <target.exe> <sea-prep.blob>
using System;
using System.IO;
using System.Runtime.InteropServices;

class Inject
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool UpdateResource(IntPtr h, IntPtr type, string name, ushort lang, byte[] data, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EndUpdateResource(IntPtr h, bool discard);

    const int RT_RCDATA = 10;

    // The copied node.exe is signed; that signature can't survive edits anyway, so drop the
    // certificate table first (the same step Node's docs suggest with signtool).
    static void StripSignature(string file)
    {
        using (var fs = new FileStream(file, FileMode.Open, FileAccess.ReadWrite))
        using (var br = new BinaryReader(fs))
        using (var bw = new BinaryWriter(fs))
        {
            fs.Position = 0x3C;
            int peOffset = br.ReadInt32();
            fs.Position = peOffset + 4 + 20;
            ushort magic = br.ReadUInt16();
            int dirStart = peOffset + 4 + 20 + (magic == 0x20B ? 112 : 96);
            long secEntry = dirStart + 4 * 8;
            fs.Position = secEntry;
            uint certOffset = br.ReadUInt32();
            uint certSize = br.ReadUInt32();
            if (certOffset == 0 || certSize == 0) return;
            fs.Position = secEntry;
            bw.Write(0u);
            bw.Write(0u);
            if (certOffset + certSize >= fs.Length) fs.SetLength(certOffset);
            Console.WriteLine("Removed Authenticode signature (" + certSize + " bytes)");
        }
    }

    static int Main(string[] args)
    {
        if (args.Length != 2) { Console.Error.WriteLine("usage: inject <target.exe> <blob>"); return 2; }
        string target = args[0];
        byte[] blob = File.ReadAllBytes(args[1]);

        StripSignature(target);

        IntPtr h = BeginUpdateResource(target, false);
        if (h == IntPtr.Zero) { Console.Error.WriteLine("BeginUpdateResource failed: " + Marshal.GetLastWin32Error()); return 1; }
        if (!UpdateResource(h, (IntPtr)RT_RCDATA, "NODE_SEA_BLOB", 0, blob, (uint)blob.Length))
        {
            Console.Error.WriteLine("UpdateResource failed: " + Marshal.GetLastWin32Error());
            EndUpdateResource(h, true);
            return 1;
        }
        if (!EndUpdateResource(h, false)) { Console.Error.WriteLine("EndUpdateResource failed: " + Marshal.GetLastWin32Error()); return 1; }
        Console.WriteLine("Injected NODE_SEA_BLOB (" + blob.Length + " bytes)");
        return 0;
    }
}
