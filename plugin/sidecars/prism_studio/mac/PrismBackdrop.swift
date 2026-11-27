import AppKit
import CoreGraphics
import CoreImage
import Foundation
import QuartzCore

struct CompanionConfig: Decodable {
    let enabled: Bool
    let imagePath: String
    let opacity: Double
    let blur: Double
    let vignette: Double
    let cornerRadius: Double
    let onlyWhenFrontmost: Bool
    let fit: String
    let blendStyle: String
    let tintHex: String
    let accentHex: String?
    let glassRim: Bool?
    let seamlessRightPane: Bool?
    let excludeRightWidth: Double?
    let excludeRightHeight: Double?
    let metricsPath: String?
    let updatedAt: Double?
}

final class BackdropCanvasView: NSView {
    private let imageLayer = CALayer()
    private let rightExcludeMaskLayer = CAShapeLayer()
    private let rimLayer = CALayer()
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    private var cachedImageKey: String = ""
    private var cachedCGImage: CGImage?
    private var currentExcludeRightWidth: CGFloat = 0
    private var currentExcludeRightHeight: CGFloat = 0
    private(set) var lastCutoutTopDown: CGRect = .zero

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.clear.cgColor

        imageLayer.contentsGravity = .resizeAspectFill
        imageLayer.masksToBounds = true

        rightExcludeMaskLayer.fillColor = NSColor.white.cgColor
        rightExcludeMaskLayer.fillRule = .evenOdd

        rimLayer.backgroundColor = NSColor.clear.cgColor
        rimLayer.borderWidth = 1.5
        rimLayer.borderColor = NSColor.clear.cgColor

        layer?.addSublayer(imageLayer)
        layer?.addSublayer(rimLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    private func updateImageMask() {
        let excludeW = currentExcludeRightWidth
        let excludeH = currentExcludeRightHeight
        let w = bounds.width
        let h = bounds.height
        if excludeW > 1.0 && w > 240.0 && h > 160.0 {
            let rightInset: CGFloat = 8.0
            let bottomInset: CGFloat = 8.0
            let defaultTopHeader: CGFloat = 70.0
            let clampedW = min(excludeW, w * 0.72)
            let cutRight = max(80.0, w - rightInset)
            let cutLeft = max(80.0, cutRight - clampedW)
            let cutBottom = max(100.0, h - bottomInset)
            let cutTop: CGFloat = (excludeH > 120.0 && excludeH < h)
                ? max(0.0, cutBottom - excludeH)
                : min(cutBottom, defaultTopHeader)
            let cutW = max(0.0, cutRight - cutLeft)
            let cutH = max(0.0, cutBottom - cutTop)
            lastCutoutTopDown = CGRect(x: cutLeft, y: cutTop, width: cutW, height: cutH)

            // Convert top-down cutout rect into AppKit bottom-up coordinates
            let appKitY = h - cutBottom
            let cutRect = CGRect(x: cutLeft, y: appKitY, width: cutW, height: cutH)
            let path = CGMutablePath()
            path.addRect(bounds)
            if cutW > 2.0 && cutH > 2.0 {
                let rad = min(8.0, min(cutW, cutH) * 0.5)
                path.addRoundedRect(in: cutRect, cornerWidth: rad, cornerHeight: rad)
            }
            rightExcludeMaskLayer.frame = bounds
            rightExcludeMaskLayer.path = path
            imageLayer.mask = rightExcludeMaskLayer
        } else {
            lastCutoutTopDown = .zero
            imageLayer.mask = nil
        }
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = bounds
        rimLayer.frame = bounds.insetBy(dx: 0.75, dy: 0.75)
        updateImageMask()
        CATransaction.commit()
    }

    private func parseHexColor(_ hex: String) -> NSColor {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&int)
        let r = CGFloat((int >> 16) & 0xFF) / 255.0
        let g = CGFloat((int >> 8) & 0xFF) / 255.0
        let b = CGFloat(int & 0xFF) / 255.0
        return NSColor(srgbRed: r, green: g, blue: b, alpha: 1.0)
    }

    /// Downscales ultra-high-res wallpapers (e.g. 4K/8K) before CPU/CI filtering
    /// so dragging opacity/vignette/blur sliders stays instant and smooth.
    private func downscaleIfNeeded(_ cgImage: CGImage, maxDim: Int = 1920) -> CGImage {
        let w = cgImage.width
        let h = cgImage.height
        let longest = max(w, h)
        guard longest > maxDim, w > 0, h > 0 else { return cgImage }

        let scale = Double(maxDim) / Double(longest)
        let nw = max(1, Int(round(Double(w) * scale)))
        let nh = max(1, Int(round(Double(h) * scale)))
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(
            data: nil,
            width: nw,
            height: nh,
            bitsPerComponent: 8,
            bytesPerRow: nw * 4,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else { return cgImage }

        ctx.interpolationQuality = .high
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: nw, height: nh))
        return ctx.makeImage() ?? cgImage
    }

    /// Unified premultiplied RGBA compositor supporting both:
    /// - "screen": luminance-keyed glow over dark backgrounds (crisp white text, glowing highlights)
    /// - "soft": uniform misty translucent veil
    /// Both modes apply smooth radial edge vignette so the edge-fade slider is clearly visible.
    private func renderBlendedBackdrop(_ cgImage: CGImage, style: String, strength: Double, edgeFade: Double) -> CGImage? {
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return cgImage }

        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var buffer = [UInt8](repeating: 0, count: height * bytesPerRow)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let readInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.noneSkipLast.rawValue
        guard let readCtx = CGContext(
            data: &buffer,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: readInfo
        ) else { return cgImage }

        readCtx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        let isSoft = (style == "soft")
        let baseK = Float(max(0.08, min(0.95, strength)))
        let softAlpha = Float(max(0.05, min(0.68, strength * 0.68)))
        let fadeAmt = Float(max(0.0, min(0.90, edgeFade)))
        let invW = 1.0 / Float(max(1, width - 1))
        let invH = 1.0 / Float(max(1, height - 1))

        buffer.withUnsafeMutableBufferPointer { ptr in
            guard let base = ptr.baseAddress else { return }
            for y in 0..<height {
                let ny = (Float(y) * invH - 0.5) * 2.0
                let ny2 = ny * ny
                let rowOffset = y * bytesPerRow
                for x in 0..<width {
                    let nx = (Float(x) * invW - 0.5) * 2.0
                    let dist2 = min(1.0, (nx * nx * 0.78 + ny2 * 0.68))
                    let vigFactor = max(0.04, 1.0 - fadeAmt * dist2 * 0.96)

                    let idx = rowOffset + x * 4
                    let r = Float(base[idx])
                    let g = Float(base[idx + 1])
                    let b = Float(base[idx + 2])

                    if isSoft {
                        let aNorm = softAlpha * vigFactor
                        let a = min(255.0, 255.0 * aNorm)
                        base[idx] = UInt8(min(a, r * aNorm))
                        base[idx + 1] = UInt8(min(a, g * aNorm))
                        base[idx + 2] = UInt8(min(a, b * aNorm))
                        base[idx + 3] = UInt8(a)
                    } else {
                        let k = baseK * vigFactor
                        let luma = max(r, max(g, b))
                        let a = min(255.0, luma * k)
                        base[idx] = UInt8(min(a, r * k))
                        base[idx + 1] = UInt8(min(a, g * k))
                        base[idx + 2] = UInt8(min(a, b * k))
                        base[idx + 3] = UInt8(a)
                    }
                }
            }
        }

        let outInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        guard let outCtx = CGContext(
            data: &buffer,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: outInfo
        ) else { return cgImage }

        return outCtx.makeImage()
    }

    private func loadRenderedImage(config: CompanionConfig) -> CGImage? {
        let path = config.imagePath
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else {
            cachedImageKey = ""
            cachedCGImage = nil
            return nil
        }

        let blurBucket = Int(round(config.blur))
        let opacityBucket = Int(round(config.opacity * 100))
        let vigBucket = Int(round(config.vignette * 100))
        let style = config.blendStyle
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(path)|\(mtime)|\(blurBucket)|\(opacityBucket)|\(vigBucket)|\(style)"
        if key == cachedImageKey, let img = cachedCGImage {
            return img
        }

        guard let nsImg = NSImage(contentsOfFile: path),
              let cgRaw = nsImg.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }

        var working: CGImage = downscaleIfNeeded(cgRaw)
        if blurBucket > 0 {
            let input = CIImage(cgImage: working)
            let clamped = input.clampedToExtent()
            if let filter = CIFilter(name: "CIGaussianBlur") {
                filter.setValue(clamped, forKey: kCIInputImageKey)
                filter.setValue(Double(blurBucket) * 1.4, forKey: kCIInputRadiusKey)
                if let output = filter.outputImage?.cropped(to: input.extent),
                   let blurred = ciContext.createCGImage(output, from: input.extent) {
                    working = blurred
                }
            }
        }

        if let blended = renderBlendedBackdrop(working, style: style, strength: config.opacity, edgeFade: config.vignette) {
            working = blended
        }

        cachedImageKey = key
        cachedCGImage = working
        return working
    }

    func apply(config: CompanionConfig) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        let radius = CGFloat(max(0, min(28, config.cornerRadius)))
        layer?.cornerRadius = radius
        rimLayer.cornerRadius = max(0, radius - 0.75)

        // Always cut out the exact right sidecar iframe when open so both sides keep independent brightness & glass controls
        currentExcludeRightWidth = CGFloat(max(0, config.excludeRightWidth ?? 0))
        currentExcludeRightHeight = CGFloat(max(0, config.excludeRightHeight ?? 0))
        updateImageMask()

        imageLayer.contentsGravity = (config.fit == "contain") ? .resizeAspect : .resizeAspectFill
        imageLayer.contents = loadRenderedImage(config: config)
        imageLayer.opacity = 1.0

        if config.glassRim ?? true {
            let accent = parseHexColor(config.accentHex ?? "#6EA8FF")
            rimLayer.borderWidth = 1.5
            rimLayer.borderColor = accent.withAlphaComponent(0.52).cgColor
        } else {
            rimLayer.borderWidth = 0
            rimLayer.borderColor = NSColor.clear.cgColor
        }

        CATransaction.commit()
    }
}

struct TrackedWindow {
    let windowNumber: Int
    let frame: NSRect
    let listIndex: Int
    let isTopmostRegular: Bool
    let isMostlyOccluded: Bool
    let myIndex: Int?
}

final class BackdropController: NSObject {
    private static let activeOverlayLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.normalWindow)) + 1)

    private let configPath: String
    private let parentPid: pid_t
    private let window: NSWindow
    private let canvasView: BackdropCanvasView
    private var activityToken: NSObjectProtocol?

    private var config: CompanionConfig?
    private var lastConfigSig: String = ""
    private var lastMetricsSig: String = ""
    private var lastAppliedFrame: NSRect = .zero
    private var lastOrderedRelativeTo: Int = 0
    private var isOrderedIn = false
    private var isElevated = false
    private var isDimmedHidden = false
    private var lostFocusAt: TimeInterval = 0

    init(configPath: String, parentPid: pid_t) {
        self.configPath = configPath
        self.parentPid = parentPid
        self.canvasView = BackdropCanvasView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))

        self.window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        super.init()

        // Prevent macOS App Nap from throttling our background accessory tracker
        self.activityToken = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical],
            reason: "Keep PrismBackdrop Z-order and frame locked to Antigravity"
        )

        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        // Hybrid 2-level strategy:
        // - Layer +1 (normal + 1) when Antigravity is topmost: left-clicking anywhere inside
        //   Antigravity raises Antigravity within Layer 0, NEVER overtaking Layer +1 (zero click flash!),
        //   while menus/IME/popovers (Layer 3..101) remain completely above.
        // - Layer 0 glued immediately above Antigravity when another app is in front: other apps
        //   naturally cover our backdrop without tearing down the WindowServer surface.
        window.level = .normal
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.contentView = canvasView
        window.alphaValue = 1.0
        window.orderOut(nil)

        reloadConfig(force: true)
        registerWorkspaceObservers()
        tick(forceOrder: true)

        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            self?.tick(forceOrder: false)
        }
    }

    deinit {
        if let token = activityToken {
            ProcessInfo.processInfo.endActivity(token)
        }
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        NotificationCenter.default.removeObserver(self)
    }

    private func registerWorkspaceObservers() {
        let wsCenter = NSWorkspace.shared.notificationCenter
        let wsEvents: [NSNotification.Name] = [
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.didDeactivateApplicationNotification,
            NSWorkspace.didHideApplicationNotification,
            NSWorkspace.didUnhideApplicationNotification,
            NSWorkspace.activeSpaceDidChangeNotification,
        ]
        for name in wsEvents {
            wsCenter.addObserver(self, selector: #selector(handleWorkspaceEvent(_:)), name: name, object: nil)
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWorkspaceEvent(_:)),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    @objc private func handleWorkspaceEvent(_ notification: Notification) {
        // React instantaneously (<1ms) to app/space switches + catch post-animation frames
        tick(forceOrder: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
            self?.tick(forceOrder: true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            self?.tick(forceOrder: true)
        }
    }

    private func isParentAlive() -> Bool {
        if parentPid <= 1 { return true }
        return kill(parentPid, 0) == 0
    }

    private func reloadConfig(force: Bool) {
        guard FileManager.default.fileExists(atPath: configPath) else { return }
        let attrs = try? FileManager.default.attributesOfItem(atPath: configPath)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let inode = (attrs?[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        let size = (attrs?[.size] as? NSNumber)?.uint64Value ?? 0
        let sig = "\(inode)|\(mtime)|\(size)"
        if !force && sig == lastConfigSig { return }

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
              let decoded = try? JSONDecoder().decode(CompanionConfig.self, from: data) else {
            return
        }
        lastConfigSig = sig
        config = decoded
        canvasView.apply(config: decoded)
    }

    private func isAntigravityFrontmost() -> Bool {
        guard let app = NSWorkspace.shared.frontmostApplication else { return false }
        let name = (app.localizedName ?? "").lowercased()
        let bundle = (app.bundleIdentifier ?? "").lowercased()
        return name.contains("antigravity") || bundle.contains("antigravity")
    }

    private func inspectAntigravityWindow() -> TrackedWindow? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        let primaryHeight = CGDisplayBounds(CGMainDisplayID()).height
        let myWid = window.windowNumber
        var myRank: Int? = nil
        var regularRank = 0
        var higherRects: [CGRect] = []
        var firstRegularOwner: String? = nil

        var targetInfo: (wid: Int, cgRect: CGRect, rank: Int)? = nil

        for info in list {
            let wid = (info[kCGWindowNumber as String] as? Int) ?? 0
            let layer = (info[kCGWindowLayer as String] as? Int) ?? -1
            if wid == myWid {
                if layer == 0 {
                    myRank = regularRank
                    regularRank += 1
                }
                continue
            }
            if layer != 0 { continue }

            let alpha = (info[kCGWindowAlpha as String] as? Double) ?? 1.0
            if alpha <= 0.01 { continue }

            guard let owner = info[kCGWindowOwnerName as String] as? String,
                  let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else {
                continue
            }
            if rect.width < 120 || rect.height < 100 { continue }

            let currentRank = regularRank
            regularRank += 1

            if firstRegularOwner == nil {
                firstRegularOwner = owner
            }

            if targetInfo == nil && owner.lowercased().contains("antigravity") && rect.width >= 360 && rect.height >= 260 {
                targetInfo = (wid, rect, currentRank)
            } else if targetInfo == nil {
                higherRects.append(rect)
            }
        }

        guard let target = targetInfo else { return nil }

        let targetArea = max(1.0, target.cgRect.width * target.cgRect.height)
        var maxCoverRatio: CGFloat = 0
        for hr in higherRects {
            let inter = hr.intersection(target.cgRect)
            if !inter.isNull {
                let ratio = (inter.width * inter.height) / targetArea
                if ratio > maxCoverRatio { maxCoverRatio = ratio }
            }
        }

        let isTopmost = (firstRegularOwner ?? "").lowercased().contains("antigravity")
        let appKitY = primaryHeight - (target.cgRect.origin.y + target.cgRect.size.height)
        let frame = NSRect(x: target.cgRect.origin.x, y: appKitY, width: target.cgRect.size.width, height: target.cgRect.size.height)

        return TrackedWindow(
            windowNumber: target.wid,
            frame: frame,
            listIndex: target.rank,
            isTopmostRegular: isTopmost,
            isMostlyOccluded: maxCoverRatio >= 0.85,
            myIndex: myRank
        )
    }

    private func publishCompanionMetrics(frame: NSRect) {
        guard let outPath = config?.metricsPath, !outPath.isEmpty else { return }
        let cut = canvasView.lastCutoutTopDown
        let winW = Double(frame.size.width)
        let winH = Double(frame.size.height)
        let pl = Double(cut.origin.x)
        let pt = Double(cut.origin.y)
        let pw = Double(cut.size.width)
        let ph = Double(cut.size.height)
        let sig = String(format: "%.2f|%.2f|%.2f|%.2f|%.2f|%.2f", winW, winH, pl, pt, pw, ph)
        if sig == lastMetricsSig { return }
        lastMetricsSig = sig
        let ts = Int64(Date().timeIntervalSince1970 * 1000.0)
        let json = String(
            format: "{\"winWidth\":%.2f,\"winHeight\":%.2f,\"paneLeft\":%.2f,\"paneTop\":%.2f,\"paneWidth\":%.2f,\"paneHeight\":%.2f,\"dpiScale\":1,\"updatedAt\":%lld}",
            winW, winH, pl, pt, pw, ph, ts
        )
        let tmp = "\(outPath).tmp.\(getpid())"
        do {
            try json.write(toFile: tmp, atomically: false, encoding: .utf8)
            _ = rename(tmp, outPath)
        } catch {
            // ignore
        }
    }

    private func orderOutCompletely() {
        if isOrderedIn {
            window.orderOut(nil)
            isOrderedIn = false
            isElevated = false
            lastOrderedRelativeTo = 0
        }
    }

    private func setBackdropAlpha(_ alpha: CGFloat) {
        if abs(window.alphaValue - alpha) > 0.001 {
            window.alphaValue = alpha
        }
        isDimmedHidden = (alpha < 0.01)
    }

    private func tick(forceOrder: Bool) {
        if !isParentAlive() {
            NSApp.terminate(nil)
            return
        }

        reloadConfig(force: false)

        guard let cfg = config, cfg.enabled else {
            orderOutCompletely()
            return
        }

        // Only completely order out when Antigravity is minimized, hidden, or on another Space
        guard let tracked = inspectAntigravityWindow() else {
            orderOutCompletely()
            return
        }

        let frameChanged =
            abs(tracked.frame.origin.x - lastAppliedFrame.origin.x) > 0.5 ||
            abs(tracked.frame.origin.y - lastAppliedFrame.origin.y) > 0.5 ||
            abs(tracked.frame.size.width - lastAppliedFrame.size.width) > 0.5 ||
            abs(tracked.frame.size.height - lastAppliedFrame.size.height) > 0.5

        if frameChanged {
            window.setFrame(tracked.frame, display: true)
            lastAppliedFrame = tracked.frame
        }
        publishCompanionMetrics(frame: tracked.frame)

        let agyIsTop = tracked.isTopmostRegular
        let isActive = isAntigravityFrontmost() || agyIsTop
        let now = Date().timeIntervalSinceReferenceDate

        if cfg.onlyWhenFrontmost && !isActive && !tracked.isMostlyOccluded {
            if lostFocusAt == 0 {
                lostFocusAt = now
            }
            if now - lostFocusAt >= 0.18 {
                setBackdropAlpha(0.0)
            }
        } else {
            lostFocusAt = 0
            setBackdropAlpha(1.0)
        }

        if agyIsTop {
            // Antigravity is the topmost Layer-0 window: promote backdrop to Layer +1 so
            // left-clicking anywhere inside Antigravity can NEVER raise Antigravity above it!
            if !isElevated {
                window.level = Self.activeOverlayLevel
                isElevated = true
            }
            if !isOrderedIn {
                window.orderFrontRegardless()
                isOrderedIn = true
            }
            lastOrderedRelativeTo = tracked.windowNumber
        } else {
            // Another normal app window is above Antigravity: drop to Layer 0 glued right above
            // Antigravity so the frontmost app cleanly covers our backdrop with zero surface teardown.
            let wasElevated = isElevated
            if isElevated {
                window.level = .normal
                isElevated = false
            }
            let zOrderDrifted: Bool = {
                guard let myIdx = tracked.myIndex else { return true }
                return myIdx != tracked.listIndex - 1
            }()
            if !isOrderedIn || wasElevated || forceOrder || zOrderDrifted || lastOrderedRelativeTo != tracked.windowNumber {
                window.order(.above, relativeTo: tracked.windowNumber)
                isOrderedIn = true
                lastOrderedRelativeTo = tracked.windowNumber
            }
        }
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: PrismBackdrop <config.json> [parentPid]\n", stderr)
    exit(2)
}

let configPath = args[1]
let parentPid: pid_t = (args.count >= 3 ? Int32(args[2]) : nil) ?? getppid()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = BackdropController(configPath: configPath, parentPid: parentPid)
withExtendedLifetime(controller) {
    app.run()
}
