import ImageIO
import UIKit
import UniformTypeIdentifiers

// "Share to Lingonect": highlight text in any app, tap Share, pick Lingonect.
//
// This extension has no UI of its own. It reads the shared text, opens the
// main app with an internal link,
//   com.lingonect.app://share?text=<text>&id=<unique id>
// and closes. The Capacitor App plugin delivers that link to the web page
// (appUrlOpen / getLaunchUrl), where app-native.js puts the text into the
// Engines input box. Android does the same in MainActivity.java.
//
// A shared image (a screenshot, a photo) is shrunk, saved as a JPEG in the
// App Group container the main app can also read (shared-image/<uuid>.jpg),
// and its path is passed instead:
//   com.lingonect.app://share?image=<path>&id=<unique id>
// The Engines page loads that copy and reads the text out of it. Only the
// newest shared image is kept; each share clears the folder first.
@objc(ShareViewController)
class ShareViewController: UIViewController {

    private let maxChars = 5000
    private let appGroup = "group.com.lingonect.app"
    // Matches what the Engines page sends on to the text reader anyway.
    private let maxImageSide: CGFloat = 2048
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    // The responder chain only reaches UIApplication once the view is on
    // screen, so open the app from here rather than viewDidLoad.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !handled else { return }
        handled = true

        let open: (URL?) -> Void = { [weak self] url in
            guard let self = self else { return }
            if let url = url { self.openMainApp(url) }
            self.finish()
        }

        // Highlighted text wins; otherwise look for an image.
        loadSharedText { [weak self] text in
            guard let self = self else { return }
            if let text = text, !text.isEmpty {
                open(self.shareLink(["text": text]))
                return
            }
            self.loadSharedImage { path in
                open(path.flatMap { self.shareLink(["image": $0]) })
            }
        }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    // MARK: - Reading the shared text

    private func loadSharedText(_ completion: @escaping (String?) -> Void) {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let textType = UTType.plainText.identifier

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(textType) }) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { item, _ in
                var text: String?
                if let s = item as? String {
                    text = s
                } else if let data = item as? Data {
                    text = String(data: data, encoding: .utf8)
                } else if let fileURL = item as? URL, fileURL.isFileURL {
                    text = try? String(contentsOf: fileURL, encoding: .utf8)
                }
                DispatchQueue.main.async { completion(self.clean(text)) }
            }
            return
        }

        // Some apps put the selection only in the item's text, with no
        // attachment. If an image is attached, that text is just a caption:
        // leave it so the image is read instead.
        if providers.contains(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) {
            completion(nil)
            return
        }
        let fallback = items.compactMap { $0.attributedContentText?.string }.first
        completion(clean(fallback))
    }

    private func clean(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxChars))
    }

    // MARK: - Reading a shared image

    private func loadSharedImage(_ completion: @escaping (String?) -> Void) {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let imageType = UTType.image.identifier
        guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(imageType) }) else {
            completion(nil)
            return
        }
        // Photos and the screenshot editor hand over a file URL, Data or a UIImage.
        provider.loadItem(forTypeIdentifier: imageType, options: nil) { [weak self] item, _ in
            guard let self = self else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            // Decode straight to the reduced size: a full-size 48 MP photo
            // would exceed a share extension's memory limit.
            var image: UIImage?
            if let img = item as? UIImage {
                image = img
            } else if let data = item as? Data {
                image = CGImageSourceCreateWithData(data as CFData, nil).flatMap(self.downsample)
            } else if let fileURL = item as? URL {
                image = CGImageSourceCreateWithURL(fileURL as CFURL, nil).flatMap(self.downsample)
            }
            let path = image.flatMap { self.saveForApp($0) }
            DispatchQueue.main.async { completion(path) }
        }
    }

    private func downsample(_ source: CGImageSource) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,   // honour EXIF rotation
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(maxImageSide),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    // Shrinks the image and writes it into the App Group container; returns
    // its path, or nil (e.g. if the App Group isn't set up on this build).
    private func saveForApp(_ image: UIImage) -> String? {
        guard let container = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let dir = container.appendingPathComponent("shared-image", isDirectory: true)
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        for old in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: old)
        }

        let size = image.size
        let scale = min(1, maxImageSide / max(size.width, size.height, 1))
        let target = CGSize(width: max(1, floor(size.width * scale)), height: max(1, floor(size.height * scale)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { ctx in
            UIColor.white.setFill()                       // transparent PNGs → white
            ctx.fill(CGRect(origin: .zero, size: target))
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let jpeg = resized.jpegData(compressionQuality: 0.85) else { return nil }
        let file = dir.appendingPathComponent(UUID().uuidString + ".jpg")
        do {
            try jpeg.write(to: file, options: .atomic)
        } catch {
            return nil
        }
        return file.path
    }

    private func shareLink(_ values: [String: String]) -> URL? {
        var components = URLComponents()
        components.scheme = "com.lingonect.app"
        components.host = "share"
        components.queryItems = values.map { URLQueryItem(name: $0.key, value: $0.value) }
            + [URLQueryItem(name: "id", value: UUID().uuidString)]
        // URLComponents leaves "+" unescaped in queries, but URLSearchParams on
        // the web side reads "+" as a space; escape it so "C++" survives.
        components.percentEncodedQuery = components.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }

    // MARK: - Opening the main app

    // Share extensions may not call UIApplication.shared. The standard way to
    // hand off to the containing app is to walk the responder chain to the
    // UIApplication instance and call open(_:options:completionHandler:)
    // through the Objective-C runtime.
    private func openMainApp(_ url: URL) {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                typealias OpenURL = @convention(c) (
                    NSObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?
                ) -> Void
                let open = unsafeBitCast(current.method(for: selector), to: OpenURL.self)
                open(current, selector, url as NSURL, NSDictionary(), nil)
                return
            }
            responder = current.next
        }
    }
}
