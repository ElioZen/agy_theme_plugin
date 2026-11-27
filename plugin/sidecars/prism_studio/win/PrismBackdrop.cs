using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PrismBackdropWin
{
    public sealed class CompanionConfig
    {
        public bool enabled { get; set; }
        public string imagePath { get; set; }
        public string winImagePath { get; set; }
        public double opacity { get; set; }
        public double blur { get; set; }
        public double vignette { get; set; }
        public double cornerRadius { get; set; }
        public bool onlyWhenFrontmost { get; set; }
        public string fit { get; set; }
        public string blendStyle { get; set; }
        public string tintHex { get; set; }
        public string accentHex { get; set; }
        public bool? glassRim { get; set; }
        public bool? seamlessRightPane { get; set; }
        public double? excludeRightWidth { get; set; }
        public double? excludeRightHeight { get; set; }
        public string metricsPath { get; set; }
        public string winMetricsPath { get; set; }
        public double? updatedAt { get; set; }

        public CompanionConfig()
        {
            opacity = 0.62;
            blur = 0;
            vignette = 0.18;
            cornerRadius = 12;
            fit = "cover";
            blendStyle = "screen";
            tintHex = "#0E121B";
            accentHex = "#6EA8FF";
        }
    }

    internal static class Native
    {
        public const int WS_POPUP = unchecked((int)0x80000000);
        public const int WS_EX_LAYERED = 0x00080000;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_TOPMOST = 0x00000008;

        public const int GWL_EXSTYLE = -20;

        public const int SW_HIDE = 0;
        public const int SW_SHOWNOACTIVATE = 4;

        public static readonly IntPtr HWND_TOP = new IntPtr(0);
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;
        public const uint SWP_HIDEWINDOW = 0x0080;
        public const uint SWP_NOOWNERZORDER = 0x0200;

        public const uint GW_HWNDFIRST = 0;
        public const uint GW_HWNDNEXT = 2;
        public const uint GW_HWNDPREV = 3;
        public const uint GW_OWNER = 4;

        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int DWMWA_CLOAKED = 14;

        public const byte AC_SRC_OVER = 0x00;
        public const byte AC_SRC_ALPHA = 0x01;
        public const uint ULW_ALPHA = 0x00000002;

        public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
        public const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
        public const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
        public const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
        public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
        public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
        public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;

        public const int WM_MOUSEACTIVATE = 0x0021;
        public const int MA_NOACTIVATE = 3;
        public const int WM_NCHITTEST = 0x0084;
        public const int HTTRANSPARENT = -1;

        public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
            public int Width { get { return Right - Left; } }
            public int Height { get { return Bottom - Top; } }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
            public POINT(int x, int y) { X = x; Y = y; }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SIZE
        {
            public int Width;
            public int Height;
            public SIZE(int w, int h) { Width = w; Height = h; }
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        public delegate void WinEventDelegate(
            IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        public static string GetWindowClassName(IntPtr hWnd)
        {
            StringBuilder sb = new StringBuilder(128);
            int len = GetClassName(hWnd, sb, sb.Capacity);
            return len > 0 ? sb.ToString() : "";
        }

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(
            IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UpdateLayeredWindow(
            IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
            IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(
            IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(
            IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [DllImport("user32.dll")]
        public static extern IntPtr SetWinEventHook(
            uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
            WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

        public static void EnableDpiAwareness()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
                    return;
            }
            catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        public static double GetDpiScale(IntPtr hwnd)
        {
            try
            {
                uint dpi = GetDpiForWindow(hwnd);
                if (dpi >= 72 && dpi <= 480) return dpi / 96.0;
            }
            catch { }
            return 1.0;
        }

        public static bool IsWindowCloaked(IntPtr hwnd)
        {
            try
            {
                int cloaked = 0;
                if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, Marshal.SizeOf(typeof(int))) == 0)
                    return cloaked != 0;
            }
            catch { }
            return false;
        }

        public static bool TryGetExtendedBounds(IntPtr hwnd, out RECT rect)
        {
            try
            {
                if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) == 0
                    && rect.Width > 0 && rect.Height > 0)
                {
                    return true;
                }
            }
            catch { }
            return GetWindowRect(hwnd, out rect);
        }
    }

    internal sealed class BackdropRenderer : IDisposable
    {
        private string _sourceKey = "";
        private Bitmap _processedSource; // downscaled + optional blur

        private string _compositeKey = "";
        private Bitmap _compositeBitmap; // final premultiplied BGRA bitmap sized to target window
        public Rectangle LastCutoutRect { get; private set; }

        private static Color ParseHexColor(string hex, Color fallback)
        {
            if (string.IsNullOrWhiteSpace(hex)) return fallback;
            string clean = hex.Trim().TrimStart('#');
            if (clean.Length != 6) return fallback;
            try
            {
                int r = Convert.ToInt32(clean.Substring(0, 2), 16);
                int g = Convert.ToInt32(clean.Substring(2, 2), 16);
                int b = Convert.ToInt32(clean.Substring(4, 2), 16);
                return Color.FromArgb(255, r, g, b);
            }
            catch
            {
                return fallback;
            }
        }

        private static Bitmap DownscaleIfNeeded(Image src, int maxDim)
        {
            int w = src.Width;
            int h = src.Height;
            int longest = Math.Max(w, h);
            int nw = w;
            int nh = h;
            if (longest > maxDim && w > 0 && h > 0)
            {
                double scale = (double)maxDim / longest;
                nw = Math.Max(1, (int)Math.Round(w * scale));
                nh = Math.Max(1, (int)Math.Round(h * scale));
            }
            Bitmap bmp = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(src, 0, 0, nw, nh);
            }
            return bmp;
        }

        // Fast O(N) 3-pass separable box blur approximating Gaussian blur
        private static unsafe void FastGaussianBlur(Bitmap bmp, int radius)
        {
            if (radius <= 0) return;
            int w = bmp.Width;
            int h = bmp.Height;
            if (w <= 2 || h <= 2) return;

            Rectangle rect = new Rectangle(0, 0, w, h);
            BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            try
            {
                int stride = data.Stride;
                int total = h * stride;
                byte[] src = new byte[total];
                byte[] dst = new byte[total];
                Marshal.Copy(data.Scan0, src, 0, total);

                int r = Math.Max(1, Math.Min(48, (int)Math.Round(radius * 0.72)));
                for (int pass = 0; pass < 3; pass++)
                {
                    BoxBlurH(src, dst, w, h, stride, r);
                    BoxBlurV(dst, src, w, h, stride, r);
                }

                Marshal.Copy(src, 0, data.Scan0, total);
            }
            finally
            {
                bmp.UnlockBits(data);
            }
        }

        private static void BoxBlurH(byte[] src, byte[] dst, int w, int h, int stride, int r)
        {
            float inv = 1.0f / (r + r + 1);
            for (int y = 0; y < h; y++)
            {
                int row = y * stride;
                int bSum = 0, gSum = 0, rSum = 0;
                int first = row;
                int last = row + (w - 1) * 4;
                bSum = src[first] * (r + 1);
                gSum = src[first + 1] * (r + 1);
                rSum = src[first + 2] * (r + 1);
                for (int j = 1; j <= r; j++)
                {
                    int idx = row + Math.Min(w - 1, j) * 4;
                    bSum += src[idx];
                    gSum += src[idx + 1];
                    rSum += src[idx + 2];
                }
                for (int x = 0; x < w; x++)
                {
                    int o = row + x * 4;
                    dst[o] = (byte)Math.Min(255, Math.Max(0, (int)(bSum * inv + 0.5f)));
                    dst[o + 1] = (byte)Math.Min(255, Math.Max(0, (int)(gSum * inv + 0.5f)));
                    dst[o + 2] = (byte)Math.Min(255, Math.Max(0, (int)(rSum * inv + 0.5f)));
                    dst[o + 3] = 255;

                    int addIdx = row + Math.Min(w - 1, x + r + 1) * 4;
                    int subIdx = row + Math.Max(0, x - r) * 4;
                    bSum += src[addIdx] - src[subIdx];
                    gSum += src[addIdx + 1] - src[subIdx + 1];
                    rSum += src[addIdx + 2] - src[subIdx + 2];
                }
            }
        }

        private static void BoxBlurV(byte[] src, byte[] dst, int w, int h, int stride, int r)
        {
            float inv = 1.0f / (r + r + 1);
            for (int x = 0; x < w; x++)
            {
                int col = x * 4;
                int bSum = src[col] * (r + 1);
                int gSum = src[col + 1] * (r + 1);
                int rSum = src[col + 2] * (r + 1);
                for (int j = 1; j <= r; j++)
                {
                    int idx = Math.Min(h - 1, j) * stride + col;
                    bSum += src[idx];
                    gSum += src[idx + 1];
                    rSum += src[idx + 2];
                }
                for (int y = 0; y < h; y++)
                {
                    int o = y * stride + col;
                    dst[o] = (byte)Math.Min(255, Math.Max(0, (int)(bSum * inv + 0.5f)));
                    dst[o + 1] = (byte)Math.Min(255, Math.Max(0, (int)(gSum * inv + 0.5f)));
                    dst[o + 2] = (byte)Math.Min(255, Math.Max(0, (int)(rSum * inv + 0.5f)));
                    dst[o + 3] = 255;

                    int addIdx = Math.Min(h - 1, y + r + 1) * stride + col;
                    int subIdx = Math.Max(0, y - r) * stride + col;
                    bSum += src[addIdx] - src[subIdx];
                    gSum += src[addIdx + 1] - src[subIdx + 1];
                    rSum += src[addIdx + 2] - src[subIdx + 2];
                }
            }
        }

        private Bitmap EnsureProcessedSource(string imagePath, int blurBucket)
        {
            if (string.IsNullOrEmpty(imagePath) || !File.Exists(imagePath))
            {
                if (_processedSource != null) { _processedSource.Dispose(); _processedSource = null; }
                _sourceKey = "";
                return null;
            }

            long mtime = 0;
            try { mtime = File.GetLastWriteTimeUtc(imagePath).Ticks; } catch { }
            string key = imagePath + "|" + mtime + "|" + blurBucket;
            if (key == _sourceKey && _processedSource != null)
            {
                return _processedSource;
            }

            try
            {
                byte[] bytes = File.ReadAllBytes(imagePath);
                using (MemoryStream ms = new MemoryStream(bytes))
                using (Image img = Image.FromStream(ms))
                {
                    Bitmap working = DownscaleIfNeeded(img, 1920);
                    if (blurBucket > 0)
                    {
                        FastGaussianBlur(working, (int)Math.Round(blurBucket * 1.4));
                    }
                    if (_processedSource != null) _processedSource.Dispose();
                    _processedSource = working;
                    _sourceKey = key;
                    return _processedSource;
                }
            }
            catch
            {
                return _processedSource;
            }
        }

        private static GraphicsPath CreateRoundedRect(RectangleF r, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float d = Math.Max(0, Math.Min(radius * 2f, Math.Min(r.Width, r.Height)));
            if (d <= 0.5f)
            {
                path.AddRectangle(r);
                return path;
            }
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public Bitmap Render(CompanionConfig cfg, int width, int height, double dpiScale, bool isMaximized, out bool changed)
        {
            changed = false;
            if (width <= 0 || height <= 0) return null;

            string imgPath = !string.IsNullOrEmpty(cfg.winImagePath) ? cfg.winImagePath : (cfg.imagePath ?? "");
            int blurBucket = (int)Math.Round(Math.Max(0, Math.Min(36, cfg.blur)));
            int opacityBucket = (int)Math.Round(Math.Max(0.08, Math.Min(0.95, cfg.opacity)) * 100);
            int vigBucket = (int)Math.Round(Math.Max(0.0, Math.Min(0.90, cfg.vignette)) * 100);
            string style = cfg.blendStyle == "soft" ? "soft" : "screen";
            string fit = cfg.fit == "contain" ? "contain" : "cover";
            bool glassRim = cfg.glassRim ?? true;
            string accentHex = cfg.accentHex ?? "#6EA8FF";
            // Always cut out the exact right sidecar iframe when open so both sides keep independent brightness & glass controls
            int excludePx = (int)Math.Round(Math.Max(0, cfg.excludeRightWidth ?? 0) * dpiScale);
            int excludeHeightPx = (int)Math.Round(Math.Max(0, cfg.excludeRightHeight ?? 0) * dpiScale);
            int rightInsetPx = (int)Math.Round(8.0 * dpiScale);
            int bottomInsetPx = (int)Math.Round(8.0 * dpiScale);
            int defaultTopHeaderPx = (int)Math.Round(70.0 * dpiScale);
            int radiusPx = isMaximized ? 0 : (int)Math.Round(Math.Max(0, Math.Min(28, cfg.cornerRadius)) * dpiScale);

            int cutLeft = width;
            int cutRight = width;
            int cutTop = height;
            int cutBottom = height;
            if (excludePx > 1 && width > 240)
            {
                int clampedW = Math.Min(excludePx, (int)(width * 0.72f));
                cutRight = Math.Max(80, width - rightInsetPx);
                cutLeft = Math.Max(80, cutRight - clampedW);
                cutBottom = Math.Max(100, height - bottomInsetPx);
                if (excludeHeightPx > 120 && excludeHeightPx < height)
                {
                    cutTop = Math.Max(0, cutBottom - excludeHeightPx);
                }
                else
                {
                    cutTop = Math.Min(cutBottom, defaultTopHeaderPx);
                }
            }
            LastCutoutRect = new Rectangle(cutLeft, cutTop, Math.Max(0, cutRight - cutLeft), Math.Max(0, cutBottom - cutTop));

            long mtime = 0;
            if (!string.IsNullOrEmpty(imgPath))
            {
                try { if (File.Exists(imgPath)) mtime = File.GetLastWriteTimeUtc(imgPath).Ticks; } catch { }
            }

            string key = string.Join("|", new string[] {
                imgPath, mtime.ToString(), blurBucket.ToString(), opacityBucket.ToString(),
                vigBucket.ToString(), style, fit, width.ToString(), height.ToString(),
                glassRim ? "1" : "0", accentHex, excludePx.ToString(), excludeHeightPx.ToString(), radiusPx.ToString()
            });

            if (key == _compositeKey && _compositeBitmap != null)
            {
                return _compositeBitmap;
            }

            Bitmap src = EnsureProcessedSource(imgPath, blurBucket);
            Bitmap result = new Bitmap(width, height, PixelFormat.Format32bppPArgb);

            if (src != null)
            {
                // Draw fitted source into temporary 32bppArgb buffer
                using (Bitmap fitted = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(fitted))
                    {
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.SmoothingMode = SmoothingMode.HighQuality;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                        float sw = src.Width;
                        float sh = src.Height;
                        float scale = (fit == "contain")
                            ? Math.Min(width / sw, height / sh)
                            : Math.Max(width / sw, height / sh);
                        float dw = sw * scale;
                        float dh = sh * scale;
                        float dx = (width - dw) * 0.5f;
                        float dy = (height - dh) * 0.5f;
                        g.DrawImage(src, dx, dy, dw, dh);
                    }

                    // Pixel blend matching PrismBackdrop.swift (Luminance-Screen / Soft + Radial Vignette + Exact Right-pane iframe cutout + Corner mask)
                    ApplyBlendAndMask(
                        fitted, result,
                        style == "soft",
                        (float)(opacityBucket / 100.0),
                        (float)(vigBucket / 100.0),
                        cutLeft, cutTop, cutRight, cutBottom,
                        (int)Math.Round(8.0 * dpiScale),
                        radiusPx
                    );
                }
            }

            // Optional Liquid Glass Rim border (1.5px scaled by DPI)
            if (glassRim)
            {
                Color accent = ParseHexColor(accentHex, Color.FromArgb(255, 110, 168, 255));
                float borderW = (float)(1.5 * dpiScale);
                using (Graphics g = Graphics.FromImage(result))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    RectangleF rimRect = new RectangleF(
                        borderW * 0.5f, borderW * 0.5f,
                        Math.Max(1f, width - borderW), Math.Max(1f, height - borderW));
                    using (GraphicsPath path = CreateRoundedRect(rimRect, Math.Max(0f, radiusPx - borderW * 0.5f)))
                    using (Pen pen = new Pen(Color.FromArgb((int)Math.Round(255 * 0.52), accent.R, accent.G, accent.B), borderW))
                    {
                        g.DrawPath(pen, path);
                    }
                }
            }

            if (_compositeBitmap != null) _compositeBitmap.Dispose();
            _compositeBitmap = result;
            _compositeKey = key;
            changed = true;
            return _compositeBitmap;
        }

        private static unsafe void ApplyBlendAndMask(
            Bitmap srcBmp, Bitmap dstBmp,
            bool isSoft, float strength, float edgeFade,
            int cutLeft, int cutTop, int cutRight, int cutBottom,
            int cutRadiusPx, int radiusPx)
        {
            int w = srcBmp.Width;
            int h = srcBmp.Height;
            bool hasCutout = cutLeft < cutRight && cutTop < cutBottom;
            float cutRad = hasCutout ? Math.Max(0f, Math.Min(cutRadiusPx, Math.Min(cutRight - cutLeft, cutBottom - cutTop) * 0.5f)) : 0f;

            float baseK = Math.Max(0.08f, Math.Min(0.95f, strength));
            float softAlpha = Math.Max(0.05f, Math.Min(0.68f, strength * 0.68f));
            float fadeAmt = Math.Max(0.0f, Math.Min(0.90f, edgeFade));
            float invW = 1.0f / Math.Max(1, w - 1);
            float invH = 1.0f / Math.Max(1, h - 1);
            float rad = Math.Max(0f, Math.Min(radiusPx, Math.Min(w, h) * 0.5f));

            Rectangle rect = new Rectangle(0, 0, w, h);
            BitmapData sData = srcBmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            BitmapData dData = dstBmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
            try
            {
                byte* sBase = (byte*)sData.Scan0;
                byte* dBase = (byte*)dData.Scan0;
                int sStride = sData.Stride;
                int dStride = dData.Stride;

                for (int y = 0; y < h; y++)
                {
                    float ny = (y * invH - 0.5f) * 2.0f;
                    float ny2 = ny * ny;
                    byte* sRow = sBase + y * sStride;
                    byte* dRow = dBase + y * dStride;
                    bool inCutY = hasCutout && y >= cutTop && y < cutBottom;

                    for (int x = 0; x < w; x++)
                    {
                        int idx = x * 4;
                        float cutKeep = 1.0f;
                        if (inCutY && x >= cutLeft && x < cutRight)
                        {
                            // Exclude only the exact right-pane iframe interior (with rounded corners matching Antigravity's card)
                            if (cutRad > 0.5f)
                            {
                                float cx = -1f, cy = -1f;
                                if (x < cutLeft + cutRad && y < cutTop + cutRad) { cx = cutLeft + cutRad; cy = cutTop + cutRad; }
                                else if (x >= cutRight - cutRad && y < cutTop + cutRad) { cx = cutRight - cutRad; cy = cutTop + cutRad; }
                                else if (x < cutLeft + cutRad && y >= cutBottom - cutRad) { cx = cutLeft + cutRad; cy = cutBottom - cutRad; }
                                else if (x >= cutRight - cutRad && y >= cutBottom - cutRad) { cx = cutRight - cutRad; cy = cutBottom - cutRad; }

                                if (cx >= 0f)
                                {
                                    float dx = (x + 0.5f) - cx;
                                    float dy = (y + 0.5f) - cy;
                                    float dist = (float)Math.Sqrt(dx * dx + dy * dy);
                                    if (dist <= cutRad - 0.5f) cutKeep = 0f;
                                    else if (dist < cutRad + 0.5f) cutKeep = dist - (cutRad - 0.5f);
                                    else cutKeep = 1.0f;
                                }
                                else
                                {
                                    cutKeep = 0f;
                                }
                            }
                            else
                            {
                                cutKeep = 0f;
                            }
                        }

                        if (cutKeep <= 0.001f)
                        {
                            dRow[idx] = 0;
                            dRow[idx + 1] = 0;
                            dRow[idx + 2] = 0;
                            dRow[idx + 3] = 0;
                            continue;
                        }

                        byte srcA = sRow[idx + 3];
                        if (srcA == 0)
                        {
                            dRow[idx] = 0;
                            dRow[idx + 1] = 0;
                            dRow[idx + 2] = 0;
                            dRow[idx + 3] = 0;
                            continue;
                        }

                        // Anti-aliased outer rounded corner coverage
                        float cornerCov = cutKeep;
                        if (rad > 0.5f)
                        {
                            float cx = -1f, cy = -1f;
                            if (x < rad && y < rad) { cx = rad; cy = rad; }
                            else if (x >= w - rad && y < rad) { cx = w - rad; cy = rad; }
                            else if (x < rad && y >= h - rad) { cx = rad; cy = h - rad; }
                            else if (x >= w - rad && y >= h - rad) { cx = w - rad; cy = h - rad; }

                            if (cx >= 0f)
                            {
                                float dx = (x + 0.5f) - cx;
                                float dy = (y + 0.5f) - cy;
                                float dist = (float)Math.Sqrt(dx * dx + dy * dy);
                                if (dist >= rad + 0.5f) cornerCov = 0f;
                                else if (dist > rad - 0.5f) cornerCov *= (rad + 0.5f - dist);
                            }
                        }

                        if (cornerCov <= 0.001f)
                        {
                            dRow[idx] = 0;
                            dRow[idx + 1] = 0;
                            dRow[idx + 2] = 0;
                            dRow[idx + 3] = 0;
                            continue;
                        }

                        float nx = (x * invW - 0.5f) * 2.0f;
                        float dist2 = Math.Min(1.0f, nx * nx * 0.78f + ny2 * 0.68f);
                        float vigFactor = Math.Max(0.04f, 1.0f - fadeAmt * dist2 * 0.96f);

                        float b = sRow[idx];
                        float g = sRow[idx + 1];
                        float r = sRow[idx + 2];
                        float srcAlphaFactor = (srcA / 255.0f) * cornerCov;

                        float a, ob, og, orr;
                        if (isSoft)
                        {
                            float aNorm = softAlpha * vigFactor * srcAlphaFactor;
                            a = Math.Min(255.0f, 255.0f * aNorm);
                            ob = Math.Min(a, b * aNorm);
                            og = Math.Min(a, g * aNorm);
                            orr = Math.Min(a, r * aNorm);
                        }
                        else
                        {
                            float k = baseK * vigFactor * srcAlphaFactor;
                            float luma = Math.Max(r, Math.Max(g, b));
                            a = Math.Min(255.0f, luma * k);
                            ob = Math.Min(a, b * k);
                            og = Math.Min(a, g * k);
                            orr = Math.Min(a, r * k);
                        }

                        dRow[idx] = (byte)ob;
                        dRow[idx + 1] = (byte)og;
                        dRow[idx + 2] = (byte)orr;
                        dRow[idx + 3] = (byte)a;
                    }
                }
            }
            finally
            {
                srcBmp.UnlockBits(sData);
                dstBmp.UnlockBits(dData);
            }
        }

        public void Dispose()
        {
            if (_processedSource != null) { _processedSource.Dispose(); _processedSource = null; }
            if (_compositeBitmap != null) { _compositeBitmap.Dispose(); _compositeBitmap = null; }
        }
    }

    internal sealed class BackdropOverlayForm : Form
    {
        public BackdropOverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = false;
            Bounds = new Rectangle(-32000, -32000, 1, 1);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style = Native.WS_POPUP;
                cp.ExStyle |= Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_MOUSEACTIVATE)
            {
                m.Result = new IntPtr(Native.MA_NOACTIVATE);
                return;
            }
            if (m.Msg == Native.WM_NCHITTEST)
            {
                m.Result = new IntPtr(Native.HTTRANSPARENT);
                return;
            }
            base.WndProc(ref m);
        }

        public void Present(Bitmap premultipliedBmp, int x, int y, byte masterAlpha)
        {
            if (premultipliedBmp == null || !IsHandleCreated) return;

            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memDc = Native.CreateCompatibleDC(screenDc);
            IntPtr hBitmap = IntPtr.Zero;
            IntPtr oldBitmap = IntPtr.Zero;
            try
            {
                hBitmap = premultipliedBmp.GetHbitmap(Color.FromArgb(0));
                oldBitmap = Native.SelectObject(memDc, hBitmap);

                Native.SIZE size = new Native.SIZE(premultipliedBmp.Width, premultipliedBmp.Height);
                Native.POINT srcPt = new Native.POINT(0, 0);
                Native.POINT dstPt = new Native.POINT(x, y);
                Native.BLENDFUNCTION blend = new Native.BLENDFUNCTION
                {
                    BlendOp = Native.AC_SRC_OVER,
                    BlendFlags = 0,
                    SourceConstantAlpha = masterAlpha,
                    AlphaFormat = Native.AC_SRC_ALPHA
                };

                Native.UpdateLayeredWindow(
                    Handle, screenDc, ref dstPt, ref size,
                    memDc, ref srcPt, 0, ref blend, Native.ULW_ALPHA);
            }
            finally
            {
                if (oldBitmap != IntPtr.Zero) Native.SelectObject(memDc, oldBitmap);
                if (hBitmap != IntPtr.Zero) Native.DeleteObject(hBitmap);
                Native.DeleteDC(memDc);
                Native.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }
    }

    internal sealed class TrackedWindowInfo
    {
        public IntPtr Hwnd;
        public uint Pid;
        public Native.RECT Bounds;
        public bool IsForeground;
        public bool HasOwnedPopupAbove;
        public IntPtr InsertAfterHwnd; // window directly above target in Z-order (or IntPtr.Zero if target is top)
    }

    internal sealed class BackdropController : ApplicationContext
    {
        private readonly string _configPath;
        private readonly int _winParentPid;
        private readonly BackdropOverlayForm _overlay;
        private readonly BackdropRenderer _renderer;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly JavaScriptSerializer _serializer = new JavaScriptSerializer();
        private readonly Dictionary<uint, string> _pidNameCache = new Dictionary<uint, string>();
        private readonly List<IntPtr> _eventHooks = new List<IntPtr>();
        private Native.WinEventDelegate _winEventDelegate;

        private CompanionConfig _config;
        private string _lastConfigSig = "";
        private string _lastMetricsSig = "";
        private Native.RECT _lastBounds;
        private byte _lastAlpha = 255;
        private bool _isVisible = false;
        private bool _isTopmost = false;
        private IntPtr _lastTargetHwnd = IntPtr.Zero;
        private DateTime _lostFocusAt = DateTime.MinValue;
        private DateTime _lastPidCacheClear = DateTime.UtcNow;

        public BackdropController(string configPath, int winParentPid)
        {
            _configPath = configPath;
            _winParentPid = winParentPid;
            _renderer = new BackdropRenderer();
            _overlay = new BackdropOverlayForm();
            // Ensure handle exists before hooks/timers run
            IntPtr _ = _overlay.Handle;

            StartStdinExitWatcher();
            InstallWinEventHooks();

            ReloadConfig(true);
            Tick(true);

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 33; // ~30Hz responsive tracking
            _timer.Tick += (s, e) => Tick(false);
            _timer.Start();
        }

        private void StartStdinExitWatcher()
        {
            // Reliable across BOTH native Windows and WSL2 interop:
            // parent Node sidecar keeps stdin pipe open; when parent dies/stops, Read() returns -1 immediately.
            Thread t = new Thread(() =>
            {
                try
                {
                    while (Console.In.Read() != -1) { }
                }
                catch { }
                try
                {
                    if (_overlay.IsHandleCreated && !_overlay.IsDisposed)
                        _overlay.BeginInvoke(new Action(ExitThread));
                    else
                        ExitThread();
                }
                catch { }
            });
            t.IsBackground = true;
            t.Start();
        }

        private void InstallWinEventHooks()
        {
            _winEventDelegate = OnWinEvent;
            uint flags = Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS;
            uint[] events = new uint[] {
                Native.EVENT_SYSTEM_FOREGROUND,
                Native.EVENT_SYSTEM_MOVESIZEEND,
                Native.EVENT_SYSTEM_MINIMIZESTART,
                Native.EVENT_SYSTEM_MINIMIZEEND,
                Native.EVENT_OBJECT_LOCATIONCHANGE
            };
            foreach (uint ev in events)
            {
                IntPtr hook = Native.SetWinEventHook(ev, ev, IntPtr.Zero, _winEventDelegate, 0, 0, flags);
                if (hook != IntPtr.Zero) _eventHooks.Add(hook);
            }
        }

        private void OnWinEvent(
            IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
        {
            if (eventType == Native.EVENT_OBJECT_LOCATIONCHANGE && hwnd != _lastTargetHwnd)
                return;
            Tick(eventType == Native.EVENT_SYSTEM_FOREGROUND);
        }

        private bool IsWinParentAlive()
        {
            if (_winParentPid <= 0) return true;
            try
            {
                using (Process p = Process.GetProcessById(_winParentPid))
                {
                    return !p.HasExited;
                }
            }
            catch
            {
                return false;
            }
        }

        private string GetProcessNameCached(uint pid)
        {
            if ((DateTime.UtcNow - _lastPidCacheClear).TotalSeconds > 30)
            {
                _pidNameCache.Clear();
                _lastPidCacheClear = DateTime.UtcNow;
            }
            string cached;
            if (_pidNameCache.TryGetValue(pid, out cached)) return cached;
            string name = "";
            try
            {
                using (Process p = Process.GetProcessById((int)pid))
                {
                    name = (p.ProcessName ?? "").ToLowerInvariant();
                }
            }
            catch { }
            _pidNameCache[pid] = name;
            return name;
        }

        private void ReloadConfig(bool force)
        {
            if (string.IsNullOrEmpty(_configPath) || !File.Exists(_configPath)) return;
            try
            {
                FileInfo fi = new FileInfo(_configPath);
                string sig = fi.LastWriteTimeUtc.Ticks + "|" + fi.Length;
                if (!force && sig == _lastConfigSig) return;
                _lastConfigSig = sig;

                string json = File.ReadAllText(_configPath);
                CompanionConfig decoded = _serializer.Deserialize<CompanionConfig>(json);
                if (decoded != null)
                {
                    _config = decoded;
                }
            }
            catch { }
        }

        private TrackedWindowInfo InspectAntigravityWindow()
        {
            IntPtr myHwnd = _overlay.Handle;
            IntPtr fgHwnd = Native.GetForegroundWindow();
            TrackedWindowInfo best = null;

            Native.EnumWindows((hwnd, lParam) =>
            {
                if (hwnd == myHwnd) return true;
                if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd)) return true;
                if (Native.IsWindowCloaked(hwnd)) return true;

                uint pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0) return true;

                string procName = GetProcessNameCached(pid);
                if (!procName.Contains("antigravity")) return true;

                // Only target real Electron main windows (skip native #32770 file/folder pickers & tool dialogs)
                string cls = Native.GetWindowClassName(hwnd);
                if (!string.Equals(cls, "Chrome_WidgetWin_1", StringComparison.Ordinal)) return true;
                int exStyle = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
                if ((exStyle & Native.WS_EX_TOOLWINDOW) != 0) return true;

                // Skip tiny helper/popup/menu windows; pick main Electron host window
                Native.RECT rect;
                if (!Native.TryGetExtendedBounds(hwnd, out rect)) return true;
                if (rect.Width < 360 || rect.Height < 260) return true;

                // Skip owned popups
                if (Native.GetWindow(hwnd, Native.GW_OWNER) != IntPtr.Zero) return true;

                bool isFg = (hwnd == fgHwnd);
                // EnumWindows enumerates top-to-bottom in Z-order: prefer foreground, else topmost Antigravity window
                if (best == null || (isFg && !best.IsForeground))
                {
                    best = new TrackedWindowInfo
                    {
                        Hwnd = hwnd,
                        Pid = pid,
                        Bounds = rect,
                        IsForeground = isFg
                    };
                    if (isFg) return false;
                }
                return true;
            }, IntPtr.Zero);

            if (best == null) return null;

            // Inspect Z-order immediately above Antigravity:
            // find the nearest visible non-overlay window directly above target, and check for Antigravity popups/menus
            IntPtr cursor = Native.GetWindow(best.Hwnd, Native.GW_HWNDPREV);
            IntPtr insertAfter = IntPtr.Zero;
            bool hasOwnedPopupAbove = false;
            int guard = 0;

            while (cursor != IntPtr.Zero && guard++ < 64)
            {
                if (cursor != myHwnd && Native.IsWindowVisible(cursor) && !Native.IsWindowCloaked(cursor))
                {
                    int ex = Native.GetWindowLong(cursor, Native.GWL_EXSTYLE);
                    bool cursorTopmost = (ex & Native.WS_EX_TOPMOST) != 0;

                    uint cPid;
                    Native.GetWindowThreadProcessId(cursor, out cPid);
                    IntPtr owner = Native.GetWindow(cursor, Native.GW_OWNER);
                    if (owner == best.Hwnd || cPid == best.Pid)
                    {
                        Native.RECT cRect;
                        if (Native.GetWindowRect(cursor, out cRect) && cRect.Width >= 20 && cRect.Height >= 20)
                        {
                            hasOwnedPopupAbove = true;
                        }
                    }

                    if (!cursorTopmost && insertAfter == IntPtr.Zero)
                    {
                        insertAfter = cursor;
                    }
                }
                cursor = Native.GetWindow(cursor, Native.GW_HWNDPREV);
            }

            // Also check if foreground window is an owned popup/menu/IME belonging to Antigravity
            if (!best.IsForeground && fgHwnd != IntPtr.Zero && fgHwnd != myHwnd)
            {
                uint fgPid;
                Native.GetWindowThreadProcessId(fgHwnd, out fgPid);
                if (fgPid == best.Pid || Native.GetWindow(fgHwnd, Native.GW_OWNER) == best.Hwnd)
                {
                    hasOwnedPopupAbove = true;
                }
            }

            best.HasOwnedPopupAbove = hasOwnedPopupAbove;
            best.InsertAfterHwnd = insertAfter;
            return best;
        }

        private void PublishCompanionMetrics(int winW, int winH, Rectangle cutout, double dpiScale)
        {
            if (_config == null) return;
            string outPath = !string.IsNullOrEmpty(_config.winMetricsPath) ? _config.winMetricsPath : (_config.metricsPath ?? "");
            if (string.IsNullOrEmpty(outPath)) return;
            double inv = dpiScale > 0.1 ? (1.0 / dpiScale) : 1.0;
            double lw = Math.Round(winW * inv, 2);
            double lh = Math.Round(winH * inv, 2);
            double pl = Math.Round(cutout.Left * inv, 2);
            double pt = Math.Round(cutout.Top * inv, 2);
            double pw = Math.Round(cutout.Width * inv, 2);
            double ph = Math.Round(cutout.Height * inv, 2);
            string sig = string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "{0}|{1}|{2}|{3}|{4}|{5}|{6:0.###}", lw, lh, pl, pt, pw, ph, dpiScale);
            if (sig == _lastMetricsSig) return;
            _lastMetricsSig = sig;
            try
            {
                string json = string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "{{\"winWidth\":{0},\"winHeight\":{1},\"paneLeft\":{2},\"paneTop\":{3},\"paneWidth\":{4},\"paneHeight\":{5},\"dpiScale\":{6:0.###},\"updatedAt\":{7}}}",
                    lw, lh, pl, pt, pw, ph, dpiScale, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                string tmp = outPath + ".tmp." + Process.GetCurrentProcess().Id;
                File.WriteAllText(tmp, json);
                if (File.Exists(outPath)) File.Delete(outPath);
                File.Move(tmp, outPath);
            }
            catch { }
        }

        private void HideOverlay()
        {
            if (_isVisible)
            {
                Native.ShowWindow(_overlay.Handle, Native.SW_HIDE);
                _isVisible = false;
                _isTopmost = false;
            }
        }

        private void Tick(bool forceZOrder)
        {
            if (!IsWinParentAlive())
            {
                ExitThread();
                return;
            }

            ReloadConfig(false);

            if (_config == null || !_config.enabled)
            {
                HideOverlay();
                return;
            }

            TrackedWindowInfo tracked = InspectAntigravityWindow();
            if (tracked == null)
            {
                HideOverlay();
                return;
            }

            _lastTargetHwnd = tracked.Hwnd;

            // Compute focus fade alpha
            byte targetAlpha = 255;
            if (_config.onlyWhenFrontmost && !tracked.IsForeground && !tracked.HasOwnedPopupAbove)
            {
                if (_lostFocusAt == DateTime.MinValue) _lostFocusAt = DateTime.UtcNow;
                if ((DateTime.UtcNow - _lostFocusAt).TotalMilliseconds >= 180)
                    targetAlpha = 0;
            }
            else
            {
                _lostFocusAt = DateTime.MinValue;
            }

            if (targetAlpha == 0)
            {
                HideOverlay();
                return;
            }

            double dpiScale = Native.GetDpiScale(tracked.Hwnd);
            bool isMaximized = Native.IsZoomed(tracked.Hwnd);
            bool bitmapChanged;
            Bitmap bmp = _renderer.Render(
                _config,
                tracked.Bounds.Width,
                tracked.Bounds.Height,
                dpiScale,
                isMaximized,
                out bitmapChanged);

            if (bmp == null)
            {
                HideOverlay();
                return;
            }

            PublishCompanionMetrics(tracked.Bounds.Width, tracked.Bounds.Height, _renderer.LastCutoutRect, dpiScale);

            bool boundsChanged =
                tracked.Bounds.Left != _lastBounds.Left ||
                tracked.Bounds.Top != _lastBounds.Top ||
                tracked.Bounds.Width != _lastBounds.Width ||
                tracked.Bounds.Height != _lastBounds.Height;

            if (!_isVisible || bitmapChanged || boundsChanged || targetAlpha != _lastAlpha)
            {
                _overlay.Present(bmp, tracked.Bounds.Left, tracked.Bounds.Top, targetAlpha);
                _lastBounds = tracked.Bounds;
                _lastAlpha = targetAlpha;
            }

            // Hybrid 2-level Z-order matching macOS PrismBackdrop.swift:
            // - When Antigravity is foreground with no popup/menu open: promote overlay to HWND_TOPMOST
            //   so left-clicking anywhere inside Antigravity can NEVER raise Antigravity above it (zero flash!).
            // - When another app is in front OR Antigravity opens a popup/menu: drop to HWND_NOTOPMOST
            //   and glue directly above Antigravity so menus and other apps cleanly stay above.
            bool shouldElevate = tracked.IsForeground && !tracked.HasOwnedPopupAbove;
            uint showFlags = Native.SWP_NOACTIVATE | Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOOWNERZORDER;
            if (!_isVisible) showFlags |= Native.SWP_SHOWWINDOW;

            if (shouldElevate)
            {
                if (!_isVisible || !_isTopmost || forceZOrder)
                {
                    Native.SetWindowPos(_overlay.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, showFlags);
                    _isVisible = true;
                    _isTopmost = true;
                }
            }
            else
            {
                bool wasTopmost = _isTopmost;
                if (wasTopmost)
                {
                    Native.SetWindowPos(_overlay.Handle, Native.HWND_NOTOPMOST, 0, 0, 0, 0, showFlags);
                    _isTopmost = false;
                }

                // Check if our overlay is already directly above Antigravity
                IntPtr prevOfTarget = Native.GetWindow(tracked.Hwnd, Native.GW_HWNDPREV);
                bool alreadyGlued = (prevOfTarget == _overlay.Handle);
                if (!_isVisible || wasTopmost || forceZOrder || !alreadyGlued)
                {
                    IntPtr insertAfter = tracked.InsertAfterHwnd != IntPtr.Zero
                        ? tracked.InsertAfterHwnd
                        : Native.HWND_TOP;
                    Native.SetWindowPos(_overlay.Handle, insertAfter, 0, 0, 0, 0, showFlags);
                    _isVisible = true;
                }
            }
        }

        protected override void ExitThreadCore()
        {
            try { _timer.Stop(); _timer.Dispose(); } catch { }
            foreach (IntPtr h in _eventHooks)
            {
                try { Native.UnhookWinEvent(h); } catch { }
            }
            _eventHooks.Clear();
            try { HideOverlay(); _overlay.Dispose(); } catch { }
            try { _renderer.Dispose(); } catch { }
            base.ExitThreadCore();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("Usage: PrismBackdrop.exe <config.json> [winParentPid]");
                return 2;
            }

            Native.EnableDpiAwareness();

            string configPath = args[0];
            int winParentPid = 0;
            if (args.Length >= 2) int.TryParse(args[1], out winParentPid);

            Application.EnableVisualStyles();
            using (BackdropController controller = new BackdropController(configPath, winParentPid))
            {
                Application.Run(controller);
            }
            return 0;
        }
    }
}
