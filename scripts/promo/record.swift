// Records scripts/promo/index.html to video: for every frame it calls seek(t) in the page,
// takes a WebKit snapshot off screen and pipes the pixels to ffmpeg (see make.sh).
//
//   swiftc -O scripts/promo/record.swift -o build/record -framework Cocoa -framework WebKit
//   build/record --page scripts/promo/index.html --out video.mp4 [--audio music.wav] [--fps 30] [--duration 60]
//   build/record --page scripts/promo/index.html --stills 2,12.5,30 --out build/stills   (PNG frames to check)
import Cocoa
import WebKit

var args = [String: String]()
var it = CommandLine.arguments.dropFirst().makeIterator()
while let k = it.next() {
    guard k.hasPrefix("--"), let v = it.next() else { fatalError("bad argument \(k)") }
    args[String(k.dropFirst(2))] = v
}
let pagePath = args["page"] ?? ""
let out = args["out"] ?? ""
if pagePath.isEmpty || out.isEmpty {
    print("usage: record --page index.html --out video.mp4 [--audio a.wav] [--fps 30] [--duration 60] [--stills t1,t2]")
    exit(2)
}
let width = 1920, height = 1080
let fps = Double(args["fps"] ?? "30")!
let duration = Double(args["duration"] ?? "60")!
let stills = args["stills"].map { $0.split(separator: ",").compactMap { Double($0) } }
let page = URL(fileURLWithPath: pagePath).standardizedFileURL
let root = page.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

final class Recorder: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let window: NSWindow
    var ffmpeg: Process?
    var pipe: FileHandle?
    let times: [Double]
    var index = 0
    let started = Date()

    override init() {
        times = stills ?? (0..<Int(duration * fps)).map { Double($0) / fps }
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: WKWebViewConfiguration())
        window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: width, height: height),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        window.contentView = webView
        window.orderFrontRegardless()
        webView.navigationDelegate = self
        webView.loadFileURL(page, allowingReadAccessTo: root)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript("await window.ready; return true", arguments: [:], in: nil, in: .page) { _ in
            if stills == nil { self.startEncoder() } else { try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true) }
            self.next()
        }
    }

    func startEncoder() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
        var a = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", "\(width)x\(height)", "-r", "\(Int(fps))", "-i", "-"]
        if let audio = args["audio"] { a += ["-i", audio] }
        a += ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        if args["audio"] != nil { a += ["-c:a", "aac", "-b:a", "192k", "-shortest"] }
        a.append(out)
        p.arguments = a
        let input = Pipe()
        p.standardInput = input
        try! p.run()
        ffmpeg = p
        pipe = input.fileHandleForWriting
    }

    func next() {
        guard index < times.count else { return finish() }
        let t = times[index]
        webView.evaluateJavaScript("seek(\(t)); 1") { _, error in
            if let error { print("seek failed: \(error)"); exit(1) }
            let config = WKSnapshotConfiguration()
            config.rect = NSRect(x: 0, y: 0, width: width, height: height)
            config.snapshotWidth = NSNumber(value: Double(width) / (NSScreen.main?.backingScaleFactor ?? 2))
            self.webView.takeSnapshot(with: config) { image, error in
                guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    print("snapshot failed: \(String(describing: error))"); exit(1)
                }
                self.write(cg, t: t)
                self.index += 1
                if self.index % 150 == 0 { print("\(self.index)/\(self.times.count) frames, \(Int(Date().timeIntervalSince(self.started)))s") }
                self.next()
            }
        }
    }

    func write(_ cg: CGImage, t: Double) {
        if stills != nil {
            let rep = NSBitmapImageRep(cgImage: cg)
            try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out).appendingPathComponent(String(format: "t%05.1f.png", t)))
            return
        }
        // exactly width × height BGRA, whatever the snapshot's scale
        var data = Data(count: width * height * 4)
        data.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
            ctx.interpolationQuality = .high
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        pipe?.write(data)
    }

    func finish() {
        try? pipe?.close()
        ffmpeg?.waitUntilExit()
        print("\(out): \(times.count) frames in \(Int(Date().timeIntervalSince(started)))s")
        exit(ffmpeg.map { $0.terminationStatus } ?? 0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let recorder = Recorder()
app.run()
