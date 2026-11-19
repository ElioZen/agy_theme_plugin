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

final class BackdropController: NSObject {
    private let configPath: String
    private let parentPid: pid_t
    private let window: NSWindow
    private let canvasView: BackdropCanvasView

    private var config: CompanionConfig?
    private var lastConfigMtime: TimeInterval = 0
    private var lastAppliedFrame: NSRect = .zero
    private var isVisible = false

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

        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        window.contentView = canvasView
        window.alphaValue = 1.0
        window.orderOut(nil)

        reloadConfig(force: true)

        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.tick()
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

    private func findAntigravityWindowFrame() -> NSRect? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        let primaryHeight = CGDisplayBounds(CGMainDisplayID()).height

        for info in list {
            guard let owner = info[kCGWindowOwnerName as String] as? String else { continue }
            if !owner.lowercased().contains("antigravity") { continue }
            let layer = (info[kCGWindowLayer as String] as? Int) ?? -1
            if layer != 0 { continue }
            guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else {
                continue
            }
            if rect.width < 360 || rect.height < 260 { continue }

            let appKitY = primaryHeight - (rect.origin.y + rect.size.height)
            return NSRect(x: rect.origin.x, y: appKitY, width: rect.size.width, height: rect.size.height)
        }
        return nil
    }

    private func hideWindow() {
        if isVisible {
            window.orderOut(nil)
            isVisible = false
        }
    }

    private func tick() {
        if !isParentAlive() {
            NSApp.terminate(nil)
            return
        }

        reloadConfig(force: false)

        guard let cfg = config, cfg.enabled else {
            hideWindow()
            return
        }

        if cfg.onlyWhenFrontmost && !isAntigravityFrontmost() {
            hideWindow()
            return
        }

        guard let targetFrame = findAntigravityWindowFrame() else {
            hideWindow()
            return
        }

        if abs(targetFrame.origin.x - lastAppliedFrame.origin.x) > 0.5 ||
            abs(targetFrame.origin.y - lastAppliedFrame.origin.y) > 0.5 ||
            abs(targetFrame.size.width - lastAppliedFrame.size.width) > 0.5 ||
            abs(targetFrame.size.height - lastAppliedFrame.size.height) > 0.5 {
            window.setFrame(targetFrame, display: true)
            lastAppliedFrame = targetFrame
        }

        if !isVisible {
            window.orderFrontRegardless()
            isVisible = true
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
