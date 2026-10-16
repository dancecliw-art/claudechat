// Draws the ClaudeChat icon (green circle, white chat bubble, three dots) and replaces the
// exe's main icon with it. Usage: icon.exe <target.exe> [out.ico]
// Uses only System.Drawing and Windows resource APIs that ship with Windows.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

class AppIcon
{
    const int RT_ICON = 3, RT_GROUP_ICON = 14;
    const uint LOAD_LIBRARY_AS_DATAFILE = 0x2, LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;

    delegate bool EnumNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    delegate bool EnumLangProc(IntPtr module, IntPtr type, IntPtr name, ushort lang, IntPtr param);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc cb, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc cb, IntPtr param);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool UpdateResource(IntPtr h, IntPtr type, string name, ushort lang, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool EndUpdateResource(IntPtr h, bool discard);

    static GraphicsPath RoundRect(float x, float y, float w, float h, float r)
    {
        var p = new GraphicsPath();
        float d = r * 2;
        p.AddArc(x, y, d, d, 180, 90);
        p.AddArc(x + w - d, y, d, d, 270, 90);
        p.AddArc(x + w - d, y + h - d, d, d, 0, 90);
        p.AddArc(x, y + h - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    static byte[] Render(int s)
    {
        using (var bmp = new Bitmap(s, s, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);
            var green = Color.FromArgb(0x00, 0xA8, 0x84);
            float pad = s * 0.02f;
            using (var b = new SolidBrush(green)) g.FillEllipse(b, pad, pad, s - 2 * pad, s - 2 * pad);

            float bx = s * 0.21f, by = s * 0.25f, bw = s * 0.58f, bh = s * 0.40f;
            using (var white = new SolidBrush(Color.White))
            using (var bubble = RoundRect(bx, by, bw, bh, bh * 0.42f))
            using (var tail = new GraphicsPath())
            {
                g.FillPath(white, bubble);
                tail.AddPolygon(new[] {
                    new PointF(bx + bw * 0.16f, by + bh - s * 0.02f),
                    new PointF(bx + bw * 0.06f, by + bh + s * 0.14f),
                    new PointF(bx + bw * 0.42f, by + bh - s * 0.02f),
                });
                g.FillPath(white, tail);
            }
            float dot = Math.Max(1.5f, s * 0.085f), cy = by + bh / 2;
            using (var b = new SolidBrush(green))
                for (int i = -1; i <= 1; i++)
                {
                    float cx = s / 2f + i * s * 0.14f;
                    g.FillEllipse(b, cx - dot / 2, cy - dot / 2, dot, dot);
                }
            using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
        }
    }

    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("usage: icon <target.exe> [out.ico]"); return 2; }
        string target = args[0];
        int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
        var images = new List<byte[]>();
        foreach (int s in sizes) images.Add(Render(s));

        // Optional: also write a standalone .ico (handy for shortcuts).
        if (args.Length > 1)
        {
            using (var fs = new FileStream(args[1], FileMode.Create))
            using (var w = new BinaryWriter(fs))
            {
                w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)sizes.Length);
                int offset = 6 + 16 * sizes.Length;
                for (int i = 0; i < sizes.Length; i++)
                {
                    w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i])); w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                    w.Write((byte)0); w.Write((byte)0); w.Write((ushort)1); w.Write((ushort)32);
                    w.Write((uint)images[i].Length); w.Write((uint)offset);
                    offset += images[i].Length;
                }
                foreach (var img in images) w.Write(img);
            }
        }

        // Find the exe's main icon group (first RT_GROUP_ICON) and its language(s).
        IntPtr groupId = IntPtr.Zero; string groupName = null;
        var langs = new List<ushort>();
        IntPtr mod = LoadLibraryEx(target, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (mod != IntPtr.Zero)
        {
            bool found = false;
            EnumResourceNames(mod, (IntPtr)RT_GROUP_ICON, (m, t, name, p) =>
            {
                if (found) return false;
                found = true;
                if (((ulong)name.ToInt64() >> 16) == 0) groupId = name; else groupName = Marshal.PtrToStringUni(name);
                EnumResourceLanguages(m, t, name, (m2, t2, n2, lang, p2) => { langs.Add(lang); return true; }, IntPtr.Zero);
                return false;
            }, IntPtr.Zero);
            FreeLibrary(mod);
        }
        if (groupId == IntPtr.Zero && groupName == null) groupId = (IntPtr)1;
        if (langs.Count == 0) langs.Add(1033);
        ushort mainLang = langs[0];

        IntPtr h = BeginUpdateResource(target, false);
        if (h == IntPtr.Zero) { Console.Error.WriteLine("BeginUpdateResource failed: " + Marshal.GetLastWin32Error()); return 1; }

        // Remove the old group in every language, then add ours under the same name.
        foreach (ushort lang in langs)
        {
            if (groupName != null) UpdateResource(h, (IntPtr)RT_GROUP_ICON, groupName, lang, null, 0);
            else UpdateResource(h, (IntPtr)RT_GROUP_ICON, groupId, lang, null, 0);
        }

        var grp = new MemoryStream();
        var gw = new BinaryWriter(grp);
        gw.Write((ushort)0); gw.Write((ushort)1); gw.Write((ushort)sizes.Length);
        for (int i = 0; i < sizes.Length; i++)
        {
            ushort id = (ushort)(500 + i);
            if (!UpdateResource(h, (IntPtr)RT_ICON, (IntPtr)id, mainLang, images[i], (uint)images[i].Length))
            { Console.Error.WriteLine("Adding icon image failed: " + Marshal.GetLastWin32Error()); EndUpdateResource(h, true); return 1; }
            gw.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i])); gw.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
            gw.Write((byte)0); gw.Write((byte)0); gw.Write((ushort)1); gw.Write((ushort)32);
            gw.Write((uint)images[i].Length); gw.Write(id);
        }
        byte[] grpBytes = grp.ToArray();
        bool ok = groupName != null
            ? UpdateResource(h, (IntPtr)RT_GROUP_ICON, groupName, mainLang, grpBytes, (uint)grpBytes.Length)
            : UpdateResource(h, (IntPtr)RT_GROUP_ICON, groupId, mainLang, grpBytes, (uint)grpBytes.Length);
        if (!ok) { Console.Error.WriteLine("Adding icon group failed: " + Marshal.GetLastWin32Error()); EndUpdateResource(h, true); return 1; }
        if (!EndUpdateResource(h, false)) { Console.Error.WriteLine("EndUpdateResource failed: " + Marshal.GetLastWin32Error()); return 1; }

        Console.WriteLine("Set app icon (" + sizes.Length + " sizes) on group " + (groupName ?? groupId.ToInt64().ToString()) + ", lang " + mainLang);
        return 0;
    }
}
