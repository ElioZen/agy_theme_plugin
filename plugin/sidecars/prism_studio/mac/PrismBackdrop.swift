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
    let updatedAt: Double?
}

final class BackdropCanvasView: NSView {
    private let imageLayer = CALayer()
    private let tintLayer = CALayer()
    private let vignetteLayer = CAGradientLayer()
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

        tintLayer.backgroundColor = NSColor.clear.cgColor

        vignetteLayer.type = .radial
        vignetteLayer.startPoint = CGPoint(x: 0.5, y: 0.5)
        vignetteLayer.endPoint = CGPoint(x: 1.0, y: 1.0)
        vignetteLayer.colors = [
            NSColor.clear.cgColor,
            NSColor.black.withAlphaComponent(0.45).cgColor
        ]

        layer?.addSublayer(imageLayer)
        layer?.addSublayer(tintLayer)
        layer?.addSublayer(vignetteLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = bounds
        tintLayer.frame = bounds
        vignetteLayer.frame = bounds
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

    private func loadRenderedImage(path: String, blur: Double) -> CGImage? {
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else {
            cachedImageKey = ""
            cachedCGImage = nil
            return nil
        }

        let blurBucket = Int(round(blur))
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(path)|\(mtime)|\(blurBucket)"
        if key == cachedImageKey, let img = cachedCGImage {
            return img
        }

        guard let nsImg = NSImage(contentsOfFile: path),
              let cgRaw = nsImg.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }

        var result: CGImage = cgRaw
        if blurBucket > 0 {
            let input = CIImage(cgImage: cgRaw)
            let clamped = input.clampedToExtent()
            if let filter = CIFilter(name: "CIGaussianBlur") {
                filter.setValue(clamped, forKey: kCIInputImageKey)
                filter.setValue(Double(blurBucket) * 1.4, forKey: kCIInputRadiusKey)
                if let output = filter.outputImage?.cropped(to: input.extent),
                   let blurred = ciContext.createCGImage(output, from: input.extent) {
                    result = blurred
                }
            }
        }

        cachedImageKey = key
        cachedCGImage = result
        return result
    }

    func apply(config: CompanionConfig) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        layer?.cornerRadius = CGFloat(max(0, min(28, config.cornerRadius)))
        imageLayer.contentsGravity = (config.fit == "contain") ? .resizeAspect : .resizeAspectFill
        imageLayer.contents = loadRenderedImage(path: config.imagePath, blur: config.blur)

        let tint = parseHexColor(config.tintHex)
        let softTintAlpha: CGFloat = (config.blendStyle == "soft") ? 0.16 : 0.04
        tintLayer.backgroundColor = tint.withAlphaComponent(softTintAlpha).cgColor

        let vig = CGFloat(max(0, min(0.85, config.vignette)))
        vignetteLayer.colors = [
            NSColor.clear.cgColor,
            NSColor.black.withAlphaComponent(vig).cgColor
        ]

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
        window.alphaValue = 0.22
        window.orderOut(nil)

        reloadConfig(force: true)

        Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
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
        window.alphaValue = CGFloat(max(0.04, min(0.68, decoded.opacity)))
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

            // Convert Quartz top-left origin to AppKit bottom-left origin
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

        guard let cfg = config, cfg.enabled, !cfg.imagePath.isEmpty else {
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
