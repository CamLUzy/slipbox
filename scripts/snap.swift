// Renders a web page to PNG with WebKit, off screen. Used for the README screenshots,
// banner and diagrams (see scripts/screenshots.sh).
//
//   swiftc -O scripts/snap.swift -o build/snap -framework Cocoa -framework WebKit
//   build/snap --url URL --out file.png [--width 1280] [--height 800]
//              [--inject inject.js]    run before the page's own scripts, on every load
//              [--setup setup.js]      run once after the first load, then reload the page
//              [--script script.js]    run after the (final) load
//              [--wait-for "js expr"]  poll until the expression is true
//              [--timeout 180] [--delay 0.8]
// Scripts are the body of an async function. The page gets a fresh, non-persistent data store.
import Cocoa
import WebKit

var args = [String: String]()
var it = CommandLine.arguments.dropFirst().makeIterator()
while let k = it.next() {
    guard k.hasPrefix("--"), let v = it.next() else { fatalError("bad argument \(k)") }
    args[String(k.dropFirst(2))] = v
}
if args["url"] == nil || args["out"] == nil {
    print("usage: snap --url URL --out file.png [--width W] [--height H] [--setup js] [--script js] [--wait-for expr]")
    exit(2)
}
let url = URL(string: args["url"]!)!
let out = args["out"]!
let width = Double(args["width"] ?? "1280")!
let height = Double(args["height"] ?? "800")!
let timeout = Double(args["timeout"] ?? "180")!
let delay = Double(args["delay"] ?? "0.8")!
func read(_ key: String) -> String? { args[key].map { try! String(contentsOfFile: $0, encoding: .utf8) } }

final class Snapper: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let window: NSWindow
    var setup = read("setup")
    let script = read("script")
    let waitFor = args["wait-for"]
    let started = Date()

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        if let inject = read("inject") {
            config.userContentController.addUserScript(WKUserScript(source: inject, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
        // An off-screen window keeps WebKit painting without showing anything on the display.
        window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: width, height: height),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        window.contentView = webView
        window.orderFrontRegardless()
        webView.navigationDelegate = self
        webView.load(URLRequest(url: url))
        Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { _ in
            print("timeout"); exit(1)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let s = setup {
            setup = nil
            run(s) { _ in webView.reload() }
            return
        }
        run(script ?? "return true") { value in
            if let value, !(value is NSNull) { print("script returned: \(value)") }
            self.waitThenShoot()
        }
    }

    func run(_ body: String, then: @escaping (Any?) -> Void) {
        webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            if case .failure(let e) = result { print("script error: \(e)"); exit(1) }
            then(try? result.get())
        }
    }

    func waitThenShoot() {
        guard let expr = waitFor else { return shoot() }
        webView.evaluateJavaScript("!!(\(expr))") { value, _ in
            if (value as? Bool) == true { self.shoot() }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitThenShoot() } }
        }
    }

    func shoot() {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            let config = WKSnapshotConfiguration()
            config.rect = NSRect(x: 0, y: 0, width: width, height: height)
            self.webView.takeSnapshot(with: config) { image, error in
                guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    print("snapshot failed: \(String(describing: error))"); exit(1)
                }
                let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!
                try! png.write(to: URL(fileURLWithPath: out))
                print("\(out) \(cg.width)x\(cg.height) in \(String(format: "%.1f", Date().timeIntervalSince(self.started)))s")
                exit(0)
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let snapper = Snapper()
app.run()
