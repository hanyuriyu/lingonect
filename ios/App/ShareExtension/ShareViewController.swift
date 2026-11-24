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
@objc(ShareViewController)
class ShareViewController: UIViewController {

    private let maxChars = 5000
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

        loadSharedText { [weak self] text in
            guard let self = self else { return }
            guard let text = text, !text.isEmpty, let url = self.shareLink(for: text) else {
                self.finish()
                return
            }
            self.openMainApp(url)
            self.finish()
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

        // Some apps put the selection only in the item's text, with no attachment.
        let fallback = items.compactMap { $0.attributedContentText?.string }.first
        completion(clean(fallback))
    }

    private func clean(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxChars))
    }

    private func shareLink(for text: String) -> URL? {
        var components = URLComponents()
        components.scheme = "com.lingonect.app"
        components.host = "share"
        components.queryItems = [
            URLQueryItem(name: "text", value: text),
            URLQueryItem(name: "id", value: UUID().uuidString),
        ]
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
