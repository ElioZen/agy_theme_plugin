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
    let updatedAt: Double?
}

final class BackdropCanvasView: NSView {
    private let imageLayer = CALayer()
    private let rimLayer = CALayer()
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    private var cachedImageKey: String = ""
    private var cachedCGImage: CGImage?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.clear.cgColor

        imageLayer.contentsGravity = .resizeAspectFill
        imageLayer.masksToBounds = true

        rimLayer.backgroundColor = NSColor.clear.cgColor
        rimLayer.borderWidth = 1.5
        rimLayer.borderColor = NSColor.clear.cgColor

        layer?.addSublayer(imageLayer)
        layer?.addSublayer(rimLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = bounds
        rimLayer.frame = bounds.insetBy(dx: 0.75, dy: 0.75)
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

    /// Emulates hardware Screen-like blending over dark-mode windows via
    /// luminance-keyed premultiplied RGBA:
    ///   Out = k*C + (1 - k*L)*D
    /// Dark sky pixels get tiny alpha so white/colored text stays 95-100% crisp,
    /// while Milky Way stardust, moon, and warm train windows glow vividly over
    /// dark Antigravity backgrounds.
    private func renderLuminanceScreen(_ cgImage: CGImage, strength: Double, edgeFade: Double) -> CGImage? {
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

        let baseK = Float(max(0.08, min(0.92, strength)))
        let fadeAmt = Float(max(0.0, min(0.80, edgeFade)))
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
                    let dist2 = min(1.0, (nx * nx * 0.72 + ny2 * 0.55))
                    let k = baseK * (1.0 - fadeAmt * dist2 * 0.65)

                    let idx = rowOffset + x * 4
                    let r = Float(base[idx])
                    let g = Float(base[idx + 1])
                    let b = Float(base[idx + 2])
                    let luma = max(r, max(g, b))

                    let a = min(255.0, luma * k)
                    base[idx] = UInt8(min(a, r * k))
                    base[idx + 1] = UInt8(min(a, g * k))
                    base[idx + 2] = UInt8(min(a, b * k))
                    base[idx + 3] = UInt8(a)
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

        var working: CGImage = cgRaw
        if blurBucket > 0 {
            let input = CIImage(cgImage: cgRaw)
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

        if style != "soft" {
            if let screened = renderLuminanceScreen(working, strength: config.opacity, edgeFade: config.vignette) {
                working = screened
            }
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

        imageLayer.contentsGravity = (config.fit == "contain") ? .resizeAspect : .resizeAspectFill
        imageLayer.contents = loadRenderedImage(config: config)

        // In screen mode opacity is already baked into luminance-keyed premultiplied alpha.
        if config.blendStyle == "soft" {
            imageLayer.opacity = Float(max(0.05, min(0.55, config.opacity * 0.55)))
        } else {
            imageLayer.opacity = 1.0
        }

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
    private let configPath: String
    private let parentPid: pid_t
    private let window: NSWindow
    private let canvasView: BackdropCanvasView
    private var activityToken: NSObjectProtocol?

    private var config: CompanionConfig?
    private var lastConfigMtime: TimeInterval = 0
    private var lastAppliedFrame: NSRect = .zero
    private var lastOrderedRelativeTo: Int = 0
    private var isOrderedIn = false
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
        // Normal window level + order(.above, relativeTo: agyWid) locks the backdrop
        // directly to Antigravity's layer-0 window so other apps naturally cover it
        // without tearing down the WindowServer surface (zero flash, zero click needed).
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
        if !force && mtime == lastConfigMtime { return }
        lastConfigMtime = mtime

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
              let decoded = try? JSONDecoder().decode(CompanionConfig.self, from: data) else {
            return
        }
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
            if wid == myWid {
                myRank = regularRank
                regularRank += 1
                continue
            }
            let layer = (info[kCGWindowLayer as String] as? Int) ?? -1
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

    private func orderOutCompletely() {
        if isOrderedIn {
            window.orderOut(nil)
            isOrderedIn = false
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

        // Antigravity counts as active if macOS reports it frontmost OR its window is
        // already the topmost layer-0 window on screen (eliminates needing a click after switch).
        let isActive = isAntigravityFrontmost() || tracked.isTopmostRegular
        let now = Date().timeIntervalSinceReferenceDate

        if cfg.onlyWhenFrontmost && !isActive && !tracked.isMostlyOccluded {
            // Uncovered split-screen background: brief 180ms grace avoids IME/popover flicker
            if lostFocusAt == 0 {
                lostFocusAt = now
            }
            if now - lostFocusAt >= 0.18 {
                setBackdropAlpha(0.0)
            }
        } else {
            // Either Antigravity is active OR cleanly occluded behind another full-size app:
            // keep alpha=1.0 & Z-glued directly above Antigravity so returning is 100% instant!
            lostFocusAt = 0
            setBackdropAlpha(1.0)
        }

        let zOrderDrifted: Bool = {
            guard let myIdx = tracked.myIndex else { return true }
            // Healthy state: our backdrop sits immediately above Antigravity (myIdx == listIndex - 1)
            return myIdx != tracked.listIndex - 1
        }()

        if !isOrderedIn || forceOrder || zOrderDrifted || lastOrderedRelativeTo != tracked.windowNumber {
            window.order(.above, relativeTo: tracked.windowNumber)
            isOrderedIn = true
            lastOrderedRelativeTo = tracked.windowNumber
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
